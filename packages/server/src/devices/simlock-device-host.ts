// Adapted from T3 Code's SimlockDeviceHost.ts (MIT, pingdotgg/t3code).
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { DEVICE_SECRET_SAVED, type DevicePlatform, type DeviceSummary, type SimlockDeviceHostConfig } from '@solus/contracts/device-types'
import type { AgentDeviceEndpoint, DeviceHost, DeviceHostReady } from './device-host'
import type { DeviceToolchain } from './device-toolchain'
import { resolveNodeRuntime, type DeviceCommandRunner } from './device-process'

const catalogSchema = z.object({ platforms: z.array(z.object({
  platform: z.string(), modelRuntimes: z.record(z.string(), z.array(z.string())),
  modelClasses: z.record(z.string(), z.string()).optional(), modelWorkers: z.record(z.string(), z.array(z.string())).optional(),
})) })
interface Lease {
  device: DeviceSummary
  session: string
  dir: string
  configPath: string
  expiresAt: number
  renewedUntil: number
  timer?: ReturnType<typeof setTimeout>
}

class SimlockGatewayError extends Error {
  constructor(readonly status: number) { super(`Simlock answered HTTP ${status}. Check the gateway and agent token.`) }
}

export function simlockToken(config: SimlockDeviceHostConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (config.agentToken) return config.agentToken
  const base = env.AGENT_DEVICE_DAEMON_BASE_URL?.replace(/\/+$/, '')
  if (!base?.endsWith('/v1/agent-device')) return ''
  try {
    return new URL(base).origin === new URL(config.gatewayUrl).origin ? env.AGENT_DEVICE_DAEMON_AUTH_TOKEN?.trim() ?? '' : ''
  } catch { return '' }
}

export class SimlockDeviceHost implements DeviceHost {
  readonly kind = 'simlock' as const
  readonly deviceHostId: string
  private ready: DeviceHostReady | null = null
  private cli: { nodePath: string; entryPath: string } | null = null
  private readonly leases = new Map<string, Lease>()
  private readonly starts = new Set<Promise<string>>()
  private starting = 0
  private catalogCache: { at: number; devices: DeviceSummary[] } | null = null
  private epoch = 0
  private readonly token: string
  private readonly gateway: string

  constructor(private readonly config: SimlockDeviceHostConfig, private readonly stateDir: string, private readonly toolchain: DeviceToolchain, private readonly run: DeviceCommandRunner, private readonly fetchImpl: typeof fetch = fetch) {
    this.deviceHostId = config.id
    this.token = simlockToken(config)
    this.gateway = config.gatewayUrl.replace(/\/$/, '')
  }

  private async request(method: string, path: string, body?: { ttlMs: number }): Promise<Response> {
    if (!this.token) throw new Error('Add a Simlock agent token, or configure this host’s agent-device gateway environment.')
    const response = await this.fetchImpl(`${this.gateway}${path}`, {
      method, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
    }).catch(() => { throw new Error('Cannot reach the Simlock gateway.') })
    if (!response.ok) throw new SimlockGatewayError(response.status)
    return response
  }

  async check(): Promise<string> {
    const response = await this.request('GET', '/v1/identity')
    const identity = z.object({ name: z.string(), role: z.string() }).safeParse(await response.json().catch(() => null))
    if (!identity.success || identity.data.role !== 'agent') throw new Error('Use a Simlock token with the agent role.')
    return identity.data.name
  }

  private async catalog(): Promise<DeviceSummary[]> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < 60_000) return this.catalogCache.devices
    const response = await this.request('GET', '/v1/catalog')
    const result = catalogSchema.safeParse(await response.json().catch(() => null))
    if (!result.success) throw new Error('The Simlock catalog could not be read.')
    const devices = result.data.platforms.flatMap((entry) => {
      const platform = entry.platform
      if (platform !== 'ios' && platform !== 'android') return []
      return Object.entries(entry.modelRuntimes).flatMap(([model, runtimes]) => {
        const kind = entry.modelClasses?.[model]
        if (!runtimes.length || entry.modelWorkers?.[model]?.length === 0 || (kind && kind !== 'phone' && kind !== 'tablet')) return []
        return [{ deviceHostId: this.deviceHostId, deviceId: `simlock:${platform}:${model}`, platform, name: model, version: `${platform === 'ios' ? 'iOS' : 'Android'} ${runtimes.at(-1)}`, booted: false, physical: false } satisfies DeviceSummary]
      })
    }).slice(0, 200)
    if (devices.length) this.catalogCache = { at: Date.now(), devices }
    return devices
  }

  async summary() {
    let devices: DeviceSummary[] = []
    let reason: string | undefined
    try { devices = await this.catalog() } catch (error) { reason = error instanceof Error ? error.message : 'Cannot read the Simlock catalog.' }
    return { deviceHostId: this.deviceHostId, kind: this.kind, label: this.config.label,
      config: { ...this.config, agentToken: this.config.agentToken ? DEVICE_SECRET_SAVED : '' },
      platforms: (['ios', 'android'] as const).map((platform) => ({ platform, available: devices.some((device) => device.platform === platform), reason })), hubInstalled: true, agentDeviceInstalled: true }
  }
  async platformAvailability(platform: DevicePlatform) {
    const devices = await this.catalog()
    return { platform, available: devices.some((device) => device.platform === platform), reason: `The pool has no ${platform} devices.` }
  }

  private async command(lease: Pick<Lease, 'session' | 'dir' | 'configPath'>, args: string[], timeoutMs = 120_000) {
    if (!this.cli) throw new Error('The Simlock agent CLI is not ready.')
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }
    for (const key of ['AGENT_DEVICE_DAEMON_BASE_URL', 'AGENT_DEVICE_DAEMON_AUTH_TOKEN', 'AGENT_DEVICE_CONFIG', 'AGENT_DEVICE_STATE_DIR', 'AGENT_DEVICE_SESSION']) delete env[key]
    const result = await this.run(this.cli.nodePath, [this.cli.entryPath, ...args, '--session', lease.session, '--config', lease.configPath, '--json'], { cwd: lease.dir, env, timeoutMs })
    if (result.code !== 0) {
      let detail = `agent-device ${args[0]} failed (exit ${result.code}). Check Simlock worker compatibility.`
      try {
        const failure = z.object({ error: z.object({ message: z.string(), hint: z.string().optional() }) }).safeParse(JSON.parse(result.stdout))
        if (failure.success) detail = [failure.data.error.message, failure.data.error.hint].filter(Boolean).join(' ')
      } catch { /* Unstructured CLI output never travels to clients. */ }
      throw new Error((this.token ? detail.replaceAll(this.token, '[redacted]') : detail).slice(0, 500))
    }
    return result.stdout
  }

  private async boot(device: DeviceSummary): Promise<string> {
    if (this.leases.has(device.deviceId)) return device.deviceId
    const target = /^simlock:(ios|android):(.+)$/.exec(device.deviceId)
    if (!target) throw new Error('This lease ended. Select a model from the pool again.')
    if (this.leases.size + this.starting >= this.config.maxLeases) throw new Error('The Simlock device limit was reached. Return a device to the pool first.')
    this.starting++
    const epoch = this.epoch
    const session = `solus-${randomUUID()}`
    const dir = join(this.stateDir, session)
    const configPath = join(dir, 'agent-device.json')
    const pending = { session, dir, configPath }
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(configPath, JSON.stringify({ daemonBaseUrl: `${this.gateway}/v1/agent-device`, daemonAuthToken: this.token, daemonTransport: 'http', stateDir: dir }), { mode: 0o600 })
      await this.command(pending, ['connect', 'proxy', '--daemon-base-url', `${this.gateway}/v1/agent-device`])
      await this.command(pending, ['open', '--platform', target[1]!, '--device', target[2]!], 7 * 60_000)
      const record = z.object({ leaseId: z.string().min(1) }).parse(JSON.parse(await readFile(join(dir, 'remote-connections', `${session}.json`), 'utf8')))
      if (epoch !== this.epoch) throw new Error('Device support stopped while the lease was opening.')
      const lease: Lease = { ...pending, device: { ...device, deviceId: record.leaseId, booted: true }, expiresAt: Date.now() + this.config.maxLeaseMinutes * 60_000, renewedUntil: Date.now() + 10 * 60_000 }
      this.leases.set(record.leaseId, lease)
      this.scheduleRenew(lease)
      return record.leaseId
    } catch (error) {
      await this.command(pending, ['close']).catch(() => {})
      await rm(dir, { recursive: true, force: true })
      throw new Error(error instanceof Error ? error.message : 'Could not open a Simlock lease. Check the gateway, pool capacity, and worker agent-device version.')
    } finally { this.starting-- }
  }

  private scheduleRenew(lease: Lease) {
    lease.timer = setTimeout(() => { void this.renew(lease) }, Math.max(0, Math.min(120_000, lease.expiresAt - Date.now())))
    lease.timer.unref?.()
  }
  private async renew(lease: Lease) {
    if (this.leases.get(lease.device.deviceId) !== lease) return
    if (Date.now() >= lease.expiresAt) {
      try { await this.release(lease) }
      catch {
        lease.timer = setTimeout(() => { void this.renew(lease) }, 30_000)
        lease.timer.unref?.()
      }
      return
    }
    try {
      await this.request('POST', `/v1/leases/${encodeURIComponent(lease.device.deviceId)}/renew`, { ttlMs: 10 * 60_000 })
      lease.renewedUntil = Date.now() + 10 * 60_000
    } catch (error) {
      if (error instanceof SimlockGatewayError && error.status === 404) { await this.forget(lease); return }
    }
    if (this.leases.get(lease.device.deviceId) === lease) this.scheduleRenew(lease)
  }
  private async forget(lease: Lease) {
    clearTimeout(lease.timer)
    this.leases.delete(lease.device.deviceId)
    await rm(lease.dir, { recursive: true, force: true })
  }
  private async release(lease: Lease) {
    clearTimeout(lease.timer)
    try { await this.command(lease, ['close']) }
    catch {
      await this.request('DELETE', `/v1/leases/${encodeURIComponent(lease.device.deviceId)}`).catch((error) => {
        if (!(error instanceof SimlockGatewayError && error.status === 404)) throw error
      })
    }
    await this.forget(lease)
  }

  async ensureReady(): Promise<DeviceHostReady> {
    if (this.ready) return this.ready
    const node = await resolveNodeRuntime(process.env, this.run)
    if ('error' in node) throw new Error(node.error)
    const cli = await this.toolchain.ensure('agent')
    this.cli = { nodePath: node.nodePath, entryPath: cli.entryPath }
    this.ready = {
      hubOrigin: this.gateway, nodePath: node.nodePath, serveSimOnly: true,
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      run: async () => ({ code: 127, stdout: '', stderr: 'Simlock does not expose host commands through the device preview.' }),
      devices: {
        list: async () => {
          for (const lease of this.leases.values()) if (Date.now() >= lease.renewedUntil) await this.forget(lease)
          return [...await this.catalog(), ...[...this.leases.values()].map((lease) => lease.device)]
        },
        boot: (device) => {
          const start = this.boot(device); this.starts.add(start)
          void start.finally(() => this.starts.delete(start)).catch(() => {})
          return start
        },
        shutdown: async (id) => { const lease = this.leases.get(id); if (lease) await this.release(lease) },
        agentEndpoint: (id) => {
          const lease = this.leases.get(id)
          return lease ? { baseUrl: `${this.gateway}/v1/agent-device`, token: this.token, deviceId: null, session: lease.session, stateDir: lease.dir, installDirectory: lease.dir } satisfies AgentDeviceEndpoint : null
        },
        screenshot: async () => { throw new Error('Use the bound agent-device CLI to capture a Simlock screenshot.') },
      },
      upstream: (id, route) => {
        if (!this.leases.has(id) || !['video.avcc', 'socket'].includes(route)) return null
        return { url: `${this.gateway}/v1/leases/${encodeURIComponent(id)}/${route === 'socket' ? 'input' : 'stream'}`, headers: { authorization: `Bearer ${this.token}` } }
      },
    }
    return this.ready
  }
  async ensureAgentReady() { return { ...await this.ensureReady(), agentDevice: null } }
  current() { return this.ready }
  async updateTool() { await this.toolchain.ensure('agent') }
  async stopAgent() {}
  async stop() {
    this.epoch++
    await Promise.allSettled(this.starts)
    for (const lease of this.leases.values()) clearTimeout(lease.timer)
    await Promise.all([...this.leases.values()].map((lease) => this.release(lease)))
    this.ready = null
  }
}
