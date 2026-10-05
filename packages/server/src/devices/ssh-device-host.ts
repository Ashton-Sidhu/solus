import { createHash } from 'node:crypto'
import { z } from 'zod'
import { hostname, networkInterfaces } from 'node:os'
import {
  deviceToolInstallMessage,
  type DeviceHostSummary,
  type DeviceHostTestResult,
  type DevicePlatform,
  type DevicePlatformAvailability,
  type SshDeviceHostConfig,
} from '@solus/contracts/device-types'
import { createLogger } from '../logger'
import { resolveHomePath } from '../platform/paths'
import {
  DeviceHostError,
  type AgentDeviceEndpoint,
  type DeviceHost,
  type DeviceHostAgentReady,
  type DeviceHostPhaseListener,
  type DeviceHostReady,
} from './device-host'
import { reserveLoopbackPort, waitForHttpReady, type HelperProcess, type HelperSpawner } from './device-helpers'
import { boundedDetail, type DeviceCommandOptions, type DeviceCommandRunner } from './device-process'
import { REMOTE_COMMAND, REMOTE_ENVIRONMENT, sshDeviceScript, type SshScriptMode } from './ssh-device-script'
import type { DeviceToolName } from './device-toolchain'

const log = createLogger('devices', 'ssh-device-host.ts')

const PROBE_CACHE_MS = 30_000
const SCRIPT_TIMEOUT_MS = 12 * 60_000
const FORWARD_READY_MS = 20_000

/** Single-quote one argument for the remote POSIX shell. */
export const quoteRemoteArg = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`

/**
 * SSH options for one device host. Non-interactive public-key auth with the
 * user's normal host-key checks: no password prompts, and host-key
 * verification is never turned off. The destination follows `--`, and the
 * config schema refuses one that starts with `-`.
 */
export function sshArgs(config: SshDeviceHostConfig, extra: readonly string[] = []): string[] {
  if (config.target.startsWith('-') || /\s/.test(config.target)) throw new DeviceHostError(config.id, 'validating the SSH target')
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    ...(config.port ? ['-p', String(config.port)] : []),
    ...(config.identityFile ? ['-i', resolveHomePath(config.identityFile), '-o', 'IdentitiesOnly=yes'] : []),
    ...extra,
    '--',
    config.target,
  ]
}

const platformSchema = z.object({ platform: z.enum(['ios', 'android']), available: z.boolean(), reason: z.string().max(500).optional().catch(undefined) })
const toolVersionSchema = z.object({ requiredVersion: z.string(), installedVersions: z.array(z.string()).max(50), runningVersion: z.string().nullable() })

/** One line of JSON from the remote script. Every field is optional: modes report different subsets. */
const scriptReplySchema = z.object({
  nodeVersion: z.string().max(40).optional().catch(undefined),
  nodeOk: z.boolean().optional().catch(undefined),
  npmOk: z.boolean().optional().catch(undefined),
  platforms: z.array(platformSchema).max(2).optional().catch(undefined),
  tools: z.object({ hub: toolVersionSchema, agent: toolVersionSchema }).optional().catch(undefined),
  nodePath: z.string().max(1024).optional().catch(undefined),
  hubPort: z.number().int().positive().optional().catch(undefined),
  daemonPort: z.number().int().positive().optional().catch(undefined),
  token: z.string().max(512).optional().catch(undefined),
  helpers: z.object({ serveSimAxSettings: z.string().nullable(), serveSimCli: z.string().nullable() }).optional().catch(undefined),
})
type ProbeReply = z.infer<typeof scriptReplySchema>

/** The last JSON line a remote script printed. */
export function parseScriptReply(stdout: string): ProbeReply | null {
  const line = stdout.trim().split('\n').reverse().find((candidate) => candidate.trim().startsWith('{'))
  if (!line) return null
  try {
    const parsed = scriptReplySchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function hostCheck(name: DeviceHostTestResult['checks'][number]['name'], ok: boolean, detail: string | undefined): DeviceHostTestResult['checks'][number] {
  const check: DeviceHostTestResult['checks'][number] = { name, ok }
  if (detail) check.detail = detail
  return check
}

export interface SshDeviceHostDeps {
  run: DeviceCommandRunner
  spawn: HelperSpawner
  /** Distinguishes this Solus host's helpers from another's on the same Mac. */
  ownerSeed?: string
  fetch?: typeof fetch
  reservePort?: () => Promise<number>
  now?: () => number
}

interface Forward {
  process: HelperProcess
  localPort: number
  remotePort: number
}

/**
 * A Mac or Linux machine reached over SSH. Helpers run there under a
 * Solus-owned directory; their loopback ports are forwarded to this machine's
 * loopback, so the manager, streams and actions see the same shape as the
 * local host. Adapted from T3 Code (MIT, pingdotgg/t3code@43bd667,
 * apps/server/src/device/SshDeviceHost.ts).
 */
export class SshDeviceHost implements DeviceHost {
  readonly kind = 'ssh' as const
  readonly deviceHostId: string
  private readonly owner: string
  private probeCache: { at: number; value: ProbeReply } | null = null
  private hubForward: Forward | null = null
  private agentForward: Forward | null = null
  private agentToken: string | null = null
  private ready: DeviceHostReady | null = null
  private starting: Promise<DeviceHostReady> | null = null
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(readonly config: SshDeviceHostConfig, private readonly deps: SshDeviceHostDeps) {
    this.deviceHostId = config.id
    this.owner = createHash('sha256').update(JSON.stringify([deps.ownerSeed ?? hostname(), config.id])).digest('hex').slice(0, 24)
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  /** Run a command on the device host. Every argument is quoted; nothing is shell text. */
  readonly run: DeviceCommandRunner = (command, args, options) => {
    const remote = `sh -c ${quoteRemoteArg(`${REMOTE_ENVIRONMENT}exec "$0" "$@"`)} ${[command, ...args].map(quoteRemoteArg).join(' ')}`
    const sshOptions: DeviceCommandOptions = { timeoutMs: options?.timeoutMs ?? 30_000 }
    if (options?.stdin !== undefined) sshOptions.stdin = options.stdin
    return this.deps.run('ssh', [...sshArgs(this.config), remote], sshOptions)
  }

  private async script(mode: SshScriptMode, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<ProbeReply> {
    const result = await this.deps.run('ssh', [...sshArgs(this.config), REMOTE_COMMAND], { stdin: sshDeviceScript(this.owner, mode), timeoutMs })
    const reply = parseScriptReply(result.stdout)
    if (result.code !== 0 || !reply) {
      const detail = boundedDetail(result.stderr || result.stdout) || `exit code ${result.code}`
      throw new DeviceHostError(this.deviceHostId, result.code === 255 ? 'connecting over SSH' : `running ${mode} on the device host`, detail)
    }
    return reply
  }

  private async probe(): Promise<ProbeReply> {
    const cached = this.probeCache
    if (cached && this.now() - cached.at < PROBE_CACHE_MS) return cached.value
    const value = await this.script('probe', 60_000)
    this.probeCache = { at: this.now(), value }
    return value
  }

  async summary(): Promise<DeviceHostSummary> {
    try {
      const reply = await this.probe()
      const summary: DeviceHostSummary = {
        deviceHostId: this.deviceHostId,
        kind: 'ssh',
        label: this.config.label,
        platforms: reply.platforms ?? [],
        hubInstalled: (reply.tools?.hub.installedVersions ?? []).includes(reply.tools?.hub.requiredVersion ?? ''),
        agentDeviceInstalled: (reply.tools?.agent.installedVersions ?? []).includes(reply.tools?.agent.requiredVersion ?? ''),
      }
      if (reply.tools) summary.tools = reply.tools
      return summary
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        deviceHostId: this.deviceHostId,
        kind: 'ssh',
        label: this.config.label,
        platforms: (['ios', 'android'] as const).map((platform) => ({ platform, available: false, reason })),
        toolInspectionError: 'Cannot reach the device host. Check SSH and try again. Installed tools have not been changed.',
        hubInstalled: false,
        agentDeviceInstalled: false,
      }
    }
  }

  async platformAvailability(platform: DevicePlatform): Promise<DevicePlatformAvailability> {
    const summary = await this.summary()
    return summary.platforms.find((entry) => entry.platform === platform) ?? { platform, available: false, reason: 'Not checked.' }
  }

  /** Read-only connection test for the host editor. Installs and starts nothing. */
  async test(): Promise<DeviceHostTestResult> {
    this.probeCache = null
    try {
      const reply = await this.probe()
      const ios = reply.platforms?.find((entry) => entry.platform === 'ios')
      const android = reply.platforms?.find((entry) => entry.platform === 'android')
      const checks: DeviceHostTestResult['checks'] = [
        hostCheck('ssh', true, undefined),
        hostCheck('node', reply.nodeOk === true, reply.nodeOk ? `Node ${reply.nodeVersion}` : `Node.js 22.12 or newer is needed on the non-interactive SSH PATH (found ${reply.nodeVersion ?? 'none'}).`),
        hostCheck('npm', reply.npmOk === true, reply.npmOk ? undefined : 'npm is missing from the non-interactive SSH PATH.'),
        hostCheck('xcode', ios?.available === true, ios?.reason),
        hostCheck('android', android?.available === true, android?.reason),
      ]
      const usable = reply.nodeOk === true && reply.npmOk === true && checks.some((check) => (check.name === 'xcode' || check.name === 'android') && check.ok)
      return { ok: usable, isLocal: false, summary: await this.summary(), checks }
    } catch (error) {
      return { ok: false, isLocal: false, checks: [{ name: 'ssh', ok: false, detail: error instanceof Error ? error.message : String(error) }] }
    }
  }

  current(): DeviceHostReady | null {
    return this.ready
  }

  private async forward(remotePort: number): Promise<Forward> {
    const localPort = await (this.deps.reservePort ?? reserveLoopbackPort)()
    const child = this.deps.spawn('ssh', sshArgs(this.config, ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`]), process.env)
    return { process: child, localPort, remotePort }
  }

  ensureReady(onPhase: DeviceHostPhaseListener): Promise<DeviceHostReady> {
    if (this.ready && this.hubForward) return Promise.resolve(this.ready)
    this.starting ??= this.start(onPhase).finally(() => { this.starting = null })
    return this.starting
  }

  private async start(onPhase: DeviceHostPhaseListener): Promise<DeviceHostReady> {
    const probe = await this.probe()
    if (!probe.tools?.hub.installedVersions.includes(probe.tools.hub.requiredVersion)) {
      onPhase('installing', deviceToolInstallMessage('device hub', probe.tools?.hub))
    }
    const reply = await this.script('start')
    this.probeCache = null
    onPhase('starting')
    if (!reply.hubPort || !reply.nodePath) throw new DeviceHostError(this.deviceHostId, 'starting the device hub', 'no port was reported')
    const forward = await this.forward(reply.hubPort)
    const origin = `http://127.0.0.1:${forward.localPort}`
    let alive = true
    void forward.process.exited.then(() => {
      alive = false
      if (this.hubForward === forward) {
        // Tunnel loss: the hub may still run there; the next request reconnects.
        this.hubForward = null
        this.ready = null
        this.agentForward?.process.kill()
        this.agentForward = null
        log.warn('device_ssh_tunnel_lost', { deviceHostId: this.deviceHostId })
      }
    })
    if (!(await waitForHttpReady(`${origin}/readyz`, FORWARD_READY_MS, this.fetch, () => alive))) {
      forward.process.kill()
      throw new DeviceHostError(this.deviceHostId, 'forwarding the device hub', 'the SSH tunnel did not answer')
    }
    this.hubForward = forward
    this.ready = { hubOrigin: origin, nodePath: reply.nodePath, run: this.run, helpers: reply.helpers ?? { serveSimAxSettings: null, serveSimCli: null } }
    return this.ready
  }

  async ensureAgentReady(onPhase: DeviceHostPhaseListener): Promise<DeviceHostAgentReady> {
    const ready = await this.ensureReady(onPhase)
    if (!this.agentForward || !this.agentToken) {
      const reply = await this.script('agent-start')
      this.probeCache = null
      if (!reply.daemonPort || !reply.token) throw new DeviceHostError(this.deviceHostId, 'starting agent tools')
      this.agentForward?.process.kill()
      this.agentForward = await this.forward(reply.daemonPort)
      this.agentToken = reply.token
    }
    const agentDevice: AgentDeviceEndpoint = { baseUrl: `http://127.0.0.1:${this.agentForward.localPort}`, token: this.agentToken }
    return { ...ready, agentDevice }
  }

  async updateTool(_tool: DeviceToolName): Promise<void> {
    // The remote script installs the pinned version on start; there is no
    // separate remote install path that leaves helpers stopped.
    throw new DeviceHostError(this.deviceHostId, 'updating tools', 'Restart device support on this host to install the pinned version.')
  }

  async stopAgent(): Promise<void> {
    this.agentForward?.process.kill()
    this.agentForward = null
    this.agentToken = null
    await this.script('stop-agent', 60_000).catch((error) => log.warn('device_ssh_stop_agent_unreachable', { deviceHostId: this.deviceHostId, error: error instanceof Error ? error.message : String(error) }))
  }

  /** Close tunnels and stop owned helpers when reachable. Unreachable is reported, not claimed stopped. */
  async stop(): Promise<void> {
    this.hubForward?.process.kill()
    this.agentForward?.process.kill()
    this.hubForward = null
    this.agentForward = null
    this.agentToken = null
    this.ready = null
    await this.script('stop', 60_000).catch((error) => log.warn('device_ssh_stop_unreachable', { deviceHostId: this.deviceHostId, error: error instanceof Error ? error.message : String(error) }))
  }
}

/** Addresses that name this machine. */
function localAddresses(): Set<string> {
  const out = new Set(['localhost', '127.0.0.1', '::1', hostname().toLowerCase(), `${hostname().toLowerCase()}.local`])
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) out.add(entry.address.toLowerCase())
  return out
}

/** Does an SSH target resolve to this machine? Reads `ssh -G`; makes no connection. */
export async function isLocalSshTarget(config: SshDeviceHostConfig, run: DeviceCommandRunner): Promise<boolean> {
  const result = await run('ssh', ['-G', ...sshArgs(config).slice(0, -2), config.target], { timeoutMs: 5_000 })
  if (result.code !== 0) return false
  const resolved = /^hostname\s+(\S+)/m.exec(result.stdout)?.[1]?.toLowerCase()
  return resolved ? localAddresses().has(resolved) : false
}
