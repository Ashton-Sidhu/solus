import { join } from 'path'
import { z } from 'zod'
import { hostIdentityKeySchema } from '@solus/contracts/host-identity'
import { DIRECT_ROUTE_RECHECK_MS, type HostRoute } from '@solus/contracts/host-routes'
import type { ForwardedHost, ForwardedHostState } from '@solus/contracts/remote-machines'
import type { HostOperatingSystem } from '@solus/contracts/types'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'
import { secretStore } from '../platform/secrets'
import type { SshTarget } from '../platform/ssh'
import type { MachineClient, MachineForward } from './wsl'
import { formatSshTarget, parseSshTarget } from './ssh-targets'

const log = createLogger('main', 'forwarded-hosts')

/**
 * The hosts this host reaches through an `ssh -L` forward it holds
 * (docs/plans/host-routes.md D7, D9): Solus with no account. A forward is a
 * loopback port on this machine, so only this machine dials its route: the
 * desktop on it, and this host's own agents for host-to-host work. Only the
 * owner of this host uses the forwards.
 *
 * A forward that stops (sleep, a network change, a restart on either side) opens
 * again with backoff, on the same local port when it is free, so the route a
 * client saved stays the same. At boot every saved forward opens again.
 */

const SECRET_KEY = 'forwarded-hosts'
const FIRST_RETRY_MS = 1_000
/** A forward retries at most this often; a linked host also has its tunnel meanwhile (D9). */
const MAX_RETRY_MS = DIRECT_ROUTE_RECHECK_MS

const recordSchema = z.object({
  installationId: z.string().min(1),
  label: z.string(),
  sshTarget: z.string().min(1),
  os: z.enum(['macos', 'windows', 'linux']).optional(),
  remotePort: z.number().int().positive(),
  localPort: z.number().int().positive().optional(),
  identityKey: hostIdentityKeySchema,
  sessionToken: z.string().min(1),
  startedBySolus: z.boolean(),
  isLinked: z.boolean(),
})
type ForwardRecord = z.infer<typeof recordSchema>
const storedSchema = z.object({ hosts: z.array(recordSchema) })

/** What a new forward needs: the host an add made, and this host's session there. */
export interface NewForward {
  installationId: string
  label: string
  target: SshTarget
  os?: HostOperatingSystem
  remotePort: number
  identityKey: string
  sessionToken: string
  startedBySolus: boolean
}

export interface ForwardedHostsDeps {
  /** Reaches a machine over SSH, or a WSL distro of this host. */
  ssh: Pick<MachineClient, 'forward'>
  /** This host's installation id: a forwarded route names it as the one machine that can dial it. */
  selfInstallationId: () => string
  /** The port the server there listens on now; it can change when the server restarts. */
  remotePort: (target: SshTarget) => Promise<number | null>
  onChange: (hosts: ForwardedHost[]) => void
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

interface LiveForward {
  forward: MachineForward | null
  state: ForwardedHostState
  error?: string
  retryMs: number
  timer: ReturnType<typeof setTimeout> | null
}

export class ForwardedHosts {
  private readonly live = new Map<string, LiveForward>()
  private isClosed = false

  constructor(private readonly deps: ForwardedHostsDeps) {}

  /** Opens every saved forward. */
  start(): void {
    for (const record of this.load()) void this.open(record)
  }

  list(): ForwardedHost[] {
    return this.load().map((record) => this.describe(record))
  }

  /** Saves the host and opens its forward. Resolves when the forward answers, or fails. */
  async add(host: NewForward): Promise<ForwardedHost> {
    const stored = this.load().filter((record) => record.installationId !== host.installationId)
    const record: ForwardRecord = {
      installationId: host.installationId,
      label: host.label,
      sshTarget: formatSshTarget(host.target),
      remotePort: host.remotePort,
      identityKey: host.identityKey,
      sessionToken: host.sessionToken,
      startedBySolus: host.startedBySolus,
      isLinked: false,
    }
    if (host.os) record.os = host.os
    this.close(host.installationId)
    this.save([...stored, record])
    await this.open(record)
    const opened = this.live.get(host.installationId)
    if (opened?.state !== 'open') throw new Error(opened?.error ?? `The SSH forward to ${host.label} did not open.`)
    return this.describe(this.find(host.installationId) ?? record)
  }

  /** The session token for a dial through the forward; null for a host this host does not forward to. */
  credential(installationId: string): string | null {
    return this.find(installationId)?.sessionToken ?? null
  }

  /** The SSH target and system of a forwarded host, for the steps that reach it again. */
  record(installationId: string): Pick<ForwardRecord, 'sshTarget' | 'os' | 'startedBySolus' | 'label'> | null {
    return this.find(installationId) ?? null
  }

  /** The host is linked too: its forward stays as a route, and a failure is no longer an error (D9). */
  markLinked(installationId: string): void {
    const stored = this.load()
    const record = stored.find((candidate) => candidate.installationId === installationId)
    if (!record || record.isLinked) return
    record.isLinked = true
    this.save(stored)
    this.notify()
  }

  /** Closes the forward and forgets the host. */
  remove(installationId: string): boolean {
    const stored = this.load()
    if (!stored.some((record) => record.installationId === installationId)) return false
    this.close(installationId)
    this.live.delete(installationId)
    this.save(stored.filter((record) => record.installationId !== installationId))
    this.notify()
    log.info('forwarded_host_removed', { installationId })
    return true
  }

  /** Closes every forward; the records stay for the next start. */
  closeAll(): void {
    this.isClosed = true
    for (const installationId of this.live.keys()) this.close(installationId)
  }

  private async open(record: ForwardRecord): Promise<void> {
    if (this.isClosed) return
    const fresh: LiveForward = { forward: null, state: 'reconnecting', retryMs: FIRST_RETRY_MS, timer: null }
    const live = this.live.get(record.installationId) ?? fresh
    this.live.set(record.installationId, live)
    const target = parseSshTarget(record.sshTarget)
    try {
      // The server there can listen on another port after a restart: read it again first.
      const remotePort = await this.deps.remotePort(target).catch(() => null) ?? record.remotePort
      const forward = await this.deps.ssh.forward(target, remotePort, '/health', record.localPort)
      if (this.isClosed || this.live.get(record.installationId) !== live) {
        forward.close()
        return
      }
      live.forward = forward
      live.state = 'open'
      live.error = undefined
      live.retryMs = FIRST_RETRY_MS
      this.remember(record.installationId, { localPort: forward.localPort, remotePort })
      log.info('forward_opened', { installationId: record.installationId, localPort: forward.localPort })
      void forward.exited.then(() => {
        if (live.forward !== forward || this.isClosed) return
        live.forward = null
        log.info('forward_closed', { installationId: record.installationId })
        this.retry(record.installationId, live, 'The SSH connection closed.')
      })
    } catch (error) {
      this.retry(record.installationId, live, error instanceof Error ? error.message : String(error))
    }
    this.notify()
  }

  private retry(installationId: string, live: LiveForward, reason: string): void {
    if (this.isClosed || this.live.get(installationId) !== live) return
    live.state = live.retryMs >= MAX_RETRY_MS ? 'failed' : 'reconnecting'
    live.error = reason
    const wait = live.retryMs
    live.retryMs = Math.min(live.retryMs * 2, MAX_RETRY_MS)
    live.timer = (this.deps.setTimeoutFn ?? setTimeout)(() => {
      live.timer = null
      const record = this.find(installationId)
      if (record) void this.open(record)
    }, wait)
    this.notify()
  }

  private close(installationId: string): void {
    const live = this.live.get(installationId)
    if (!live) return
    if (live.timer) (this.deps.clearTimeoutFn ?? clearTimeout)(live.timer)
    live.timer = null
    const forward = live.forward
    live.forward = null
    forward?.close()
  }

  private describe(record: ForwardRecord): ForwardedHost {
    const live = this.live.get(record.installationId)
    const port = live?.forward?.localPort ?? record.localPort
    const route: HostRoute = { kind: 'forwarded', url: `http://127.0.0.1:${port ?? 0}`, viaHostId: this.deps.selfInstallationId(), source: 'ssh' }
    const host: ForwardedHost = {
      installationId: record.installationId,
      label: record.label,
      sshTarget: record.sshTarget,
      route,
      identityKey: record.identityKey,
      state: live?.state ?? 'reconnecting',
      startedBySolus: record.startedBySolus,
      isLinked: record.isLinked,
    }
    if (record.os) host.os = record.os
    if (live?.error && live.state !== 'open') host.error = live.error
    return host
  }

  private remember(installationId: string, ports: { localPort: number; remotePort: number }): void {
    const stored = this.load()
    const record = stored.find((candidate) => candidate.installationId === installationId)
    if (!record || (record.localPort === ports.localPort && record.remotePort === ports.remotePort)) return
    record.localPort = ports.localPort
    record.remotePort = ports.remotePort
    this.save(stored)
  }

  private notify(): void {
    this.deps.onChange(this.list())
  }

  private find(installationId: string): ForwardRecord | undefined {
    return this.load().find((record) => record.installationId === installationId)
  }

  private load(): ForwardRecord[] {
    return secretStore().loadJson(SECRET_KEY, secretFile(), storedSchema)?.hosts ?? []
  }

  private save(hosts: ForwardRecord[]): void {
    secretStore().saveJson(SECRET_KEY, secretFile(), { hosts })
  }
}

function secretFile(): string {
  return join(dataDir(), 'forwarded-hosts.bin')
}
