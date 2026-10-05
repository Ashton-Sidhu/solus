import { existsSync } from 'node:fs'
import { z } from 'zod'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AGENT_DEVICE_VERSION,
  DEVICE_HUB_VERSION,
  LOCAL_DEVICE_HOST_ID,
  deviceToolInstallMessage,
  type DeviceHostSummary,
  type DevicePlatform,
  type DevicePlatformAvailability,
} from '@solus/contracts/device-types'
import { createLogger } from '../logger'
import {
  DeviceHostError,
  type DeviceHost,
  type DeviceHostAgentReady,
  type DeviceHostPhaseListener,
  type DeviceHostReady,
  type AgentDeviceEndpoint,
} from './device-host'
import { boundedDetail, resolveNodeRuntime, type DeviceCommandRunner } from './device-process'
import { deviceHostEnvironment, findAndroidSdk, probePlatform } from './device-platform-probe'
import type { DeviceToolchain, DeviceToolName, DeviceToolPaths, RunningToolVersions } from './device-toolchain'
import { reserveLoopbackPort, waitForHttpReady, type HelperProcess, type HelperSpawner } from './device-helpers'

const log = createLogger('devices', 'local-device-host.ts')

const HUB_READY_TIMEOUT_MS = 30_000
const DAEMON_READY_TIMEOUT_MS = 30_000
const HUB_RESTART_STABLE_UPTIME_MS = 60_000
const HUB_RESTART_MAX_DELAY_MS = 30_000
const PLATFORM_CACHE_MS = 30_000

export interface LocalDeviceHostDeps {
  /** Host-owned directory for helper state (hub.json, agent-device daemon state). */
  stateDir: string
  toolchain: DeviceToolchain
  run: DeviceCommandRunner
  spawn: HelperSpawner
  env?: NodeJS.ProcessEnv
  hostPlatform?: NodeJS.Platform
  fetch?: typeof fetch
  reservePort?: () => Promise<number>
  /** Is a recorded PID still the helper Solus started? Reads its command line. */
  processCommandLine?: (pid: number) => Promise<string | null>
  now?: () => number
  /** Finds Node for the helpers. Defaults to the PATH search. */
  resolveNode?: () => Promise<{ nodePath: string } | { error: string }>
}

interface RunningHub {
  process: HelperProcess
  origin: string
  nodePath: string
  startedAt: number
  helpers: DeviceHostReady['helpers']
}

/** What a hub left on disk: its PID and the entry path on its command line. */
const hubStateSchema = z.object({ pid: z.number().int().positive(), entryPath: z.string().min(1) })

/** agent-device's daemon.json in HTTP mode. */
const daemonFileSchema = z.object({
  httpPort: z.number().int().positive(),
  token: z.string().min(1),
  pid: z.number().int().optional().catch(undefined),
  version: z.string().optional().catch(undefined),
})
type DaemonFile = z.infer<typeof daemonFileSchema>

/**
 * The device host that is this machine. Runs expo-device-hub as a supervised
 * child on a loopback port, never as an in-process import: serve-sim loads
 * private CoreSimulator frameworks through a native addon, and a crash there
 * must not take Solus down. Adapted from T3 Code (MIT,
 * pingdotgg/t3code@43bd667, apps/server/src/device/LocalDeviceHost.ts).
 */
export class LocalDeviceHost implements DeviceHost {
  readonly deviceHostId = LOCAL_DEVICE_HOST_ID
  readonly kind = 'local' as const

  private hub: RunningHub | null = null
  private agent: AgentDeviceEndpoint | null = null
  private starting: Promise<RunningHub> | null = null
  private agentStarting: Promise<AgentDeviceEndpoint> | null = null
  private restartDelayMs = 0
  private stopped = false
  private platformCache: { at: number; value: DevicePlatformAvailability[] } | null = null
  private readonly env: NodeJS.ProcessEnv
  private readonly hostPlatform: NodeJS.Platform
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(private readonly deps: LocalDeviceHostDeps) {
    const baseEnv = deps.env ?? process.env
    this.hostPlatform = deps.hostPlatform ?? process.platform
    this.env = deviceHostEnvironment(baseEnv, findAndroidSdk({ env: baseEnv, hostPlatform: this.hostPlatform }).root)
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  readonly run: DeviceCommandRunner = (command, args, options) =>
    this.deps.run(command, args, { ...options, env: options?.env ?? this.env })

  async platformAvailability(platform: DevicePlatform): Promise<DevicePlatformAvailability> {
    return (await this.platforms()).find((entry) => entry.platform === platform)!
  }

  private async platforms(): Promise<DevicePlatformAvailability[]> {
    const cached = this.platformCache
    if (cached && this.now() - cached.at < PLATFORM_CACHE_MS) return cached.value
    const deps = { env: this.env, hostPlatform: this.hostPlatform, run: this.deps.run }
    const value = [await probePlatform('ios', deps), await probePlatform('android', deps)]
    this.platformCache = { at: this.now(), value }
    return value
  }

  async summary(): Promise<DeviceHostSummary> {
    const [platforms, hubInstalled, agentDeviceInstalled] = await Promise.all([
      this.platforms(),
      this.deps.toolchain.isInstalled('hub'),
      this.deps.toolchain.isInstalled('agent'),
    ])
    const running: RunningToolVersions = {}
    if (this.hub) running.hub = DEVICE_HUB_VERSION
    if (this.agent) running.agent = AGENT_DEVICE_VERSION
    const tools = await this.deps.toolchain.versions(running)
    return {
      deviceHostId: this.deviceHostId,
      kind: 'local',
      label: 'This machine',
      platforms,
      tools,
      hubInstalled,
      agentDeviceInstalled,
    }
  }

  current(): DeviceHostReady | null {
    return this.hub ? this.toReady(this.hub) : null
  }

  async ensureReady(onPhase: DeviceHostPhaseListener): Promise<DeviceHostReady> {
    return this.toReady(await this.ensureHub(onPhase))
  }

  async ensureAgentReady(onPhase: DeviceHostPhaseListener): Promise<DeviceHostAgentReady> {
    const hub = await this.ensureHub(onPhase)
    if (!this.agent) {
      this.agentStarting ??= this.startAgent(hub, onPhase).finally(() => { this.agentStarting = null })
      this.agent = await this.agentStarting
    }
    return { ...this.toReady(hub), agentDevice: this.agent }
  }

  async updateTool(tool: DeviceToolName): Promise<void> {
    await this.install(tool)
  }

  async stopAgent(): Promise<void> {
    const hub = this.hub
    this.agent = null
    if (!hub) return
    const agentTool = this.deps.toolchain.paths('agent')
    if (!existsSync(agentTool.entryPath)) return
    await this.run(hub.nodePath, [agentTool.entryPath, 'daemon', 'stop', '--state-dir', this.agentStateDir()], {
      timeoutMs: 10_000,
      env: { ...this.env, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' },
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.stopAgent()
    const hub = this.hub
    this.hub = null
    if (hub) {
      hub.process.kill()
      log.info('device_hub_stopped', { pid: hub.process.pid })
    }
    await rm(this.hubStatePath(), { force: true }).catch(() => {})
    this.stopped = false
  }

  private agentStateDir(): string {
    return join(this.deps.stateDir, 'agent-device')
  }

  private hubStatePath(): string {
    return join(this.deps.stateDir, 'hub.json')
  }

  private toReady(hub: RunningHub): DeviceHostReady {
    return { hubOrigin: hub.origin, nodePath: hub.nodePath, run: this.run, helpers: hub.helpers }
  }

  private async install(tool: DeviceToolName, onPhase?: DeviceHostPhaseListener): Promise<DeviceToolPaths> {
    if (!(await this.deps.toolchain.isInstalled(tool))) {
      const versions = await this.deps.toolchain.versions()
      onPhase?.('installing', deviceToolInstallMessage(tool === 'hub' ? 'device hub' : 'agent tools', versions[tool]))
    }
    try {
      return await this.deps.toolchain.ensure(tool)
    } catch (error) {
      throw new DeviceHostError(this.deviceHostId, tool === 'hub' ? 'installing device support' : 'installing agent tools',
        boundedDetail(error instanceof Error ? error.message : String(error)))
    }
  }

  private async nodePath(): Promise<string> {
    const node = await (this.deps.resolveNode ?? (() => resolveNodeRuntime(this.env, this.deps.run)))()
    if ('error' in node) throw new DeviceHostError(this.deviceHostId, 'finding Node.js', node.error)
    return node.nodePath
  }

  private ensureHub(onPhase: DeviceHostPhaseListener): Promise<RunningHub> {
    if (this.hub) return Promise.resolve(this.hub)
    this.starting ??= this.startHub(onPhase).finally(() => { this.starting = null })
    return this.starting
  }

  private async startHub(onPhase: DeviceHostPhaseListener): Promise<RunningHub> {
    const nodePath = await this.nodePath()
    const hubTool = await this.install('hub', onPhase)
    onPhase('starting')
    const hub = await this.spawnHub(hubTool, nodePath)
    this.hub = hub
    this.restartDelayMs = 0
    void this.supervise(hub, hubTool)
    return hub
  }

  /**
   * A hub left by a Solus process that died without cleanup is identified by
   * its recorded PID plus our entry path on its command line, so a recycled
   * PID that belongs to something else is never signalled.
   */
  private async reapStaleHub(): Promise<void> {
    const raw = await readFile(this.hubStatePath(), 'utf8').catch(() => null)
    if (!raw) return
    try {
      const previous = hubStateSchema.safeParse(JSON.parse(raw))
      if (previous.success && this.deps.processCommandLine) {
        const commandLine = await this.deps.processCommandLine(previous.data.pid)
        if (commandLine?.includes(previous.data.entryPath)) {
          log.warn('device_hub_reaped', { pid: previous.data.pid })
          try { process.kill(previous.data.pid, 'SIGTERM') } catch {}
        }
      }
    } catch {
      // A corrupt state file names nothing to stop.
    }
    await rm(this.hubStatePath(), { force: true }).catch(() => {})
  }

  private async spawnHub(hubTool: DeviceToolPaths, nodePath: string): Promise<RunningHub> {
    await this.reapStaleHub()
    await mkdir(this.deps.stateDir, { recursive: true })
    const port = await (this.deps.reservePort ?? reserveLoopbackPort)()
    const origin = `http://127.0.0.1:${port}`
    const child = this.deps.spawn(
      nodePath,
      [hubTool.entryPath, '--port', String(port), '--host', '127.0.0.1', '--hide-sidebar', '--hide-boot-device'],
      { ...this.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    )
    let alive = true
    void child.exited.then(() => { alive = false })
    const ready = await waitForHttpReady(`${origin}/readyz`, HUB_READY_TIMEOUT_MS, this.fetch, () => alive)
    if (!ready) {
      child.kill()
      throw new DeviceHostError(this.deviceHostId, 'waiting for the device hub to answer')
    }
    await writeFile(this.hubStatePath(), JSON.stringify({ pid: child.pid, port, entryPath: hubTool.entryPath }), { mode: 0o600 })
    log.info('device_hub_started', { pid: child.pid, port })
    const serveSim = join(hubTool.installDir, 'node_modules', 'expo-device-hub', 'vendor', 'serve-sim', 'dist')
    const ax = join(serveSim, 'simax', 'serve-sim-ax-settings')
    const cli = join(serveSim, 'serve-sim.js')
    return {
      process: child,
      origin,
      nodePath,
      startedAt: this.now(),
      helpers: { serveSimAxSettings: existsSync(ax) ? ax : null, serveSimCli: existsSync(cli) ? cli : null },
    }
  }

  /** Restart a hub that dies under us, with doubling backoff so a crash on boot cannot spin. */
  private async supervise(hub: RunningHub, hubTool: DeviceToolPaths): Promise<void> {
    await hub.process.exited
    if (this.hub !== hub || this.stopped) return
    const uptime = this.now() - hub.startedAt
    const delay = uptime >= HUB_RESTART_STABLE_UPTIME_MS ? 0 : this.restartDelayMs
    this.restartDelayMs = uptime >= HUB_RESTART_STABLE_UPTIME_MS ? 0
      : this.restartDelayMs === 0 ? 1_000 : Math.min(this.restartDelayMs * 2, HUB_RESTART_MAX_DELAY_MS)
    this.hub = null
    this.agent = null
    log.warn('device_hub_restarting', { pid: hub.process.pid, delayMs: delay })
    await new Promise((resolve) => setTimeout(resolve, delay))
    if (this.stopped || this.hub) return
    try {
      const replacement = await this.spawnHub(hubTool, hub.nodePath)
      this.hub = replacement
      void this.supervise(replacement, hubTool)
    } catch (error) {
      log.warn('device_hub_restart_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async readDaemonFile(): Promise<DaemonFile | null> {
    const raw = await readFile(join(this.agentStateDir(), 'daemon.json'), 'utf8').catch(() => null)
    if (!raw) return null
    try {
      const parsed = daemonFileSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  /**
   * agent-device starts its daemon on any command; there is no `daemon start`.
   * A `devices` call in HTTP mode brings it up and writes daemon.json.
   */
  private async startAgent(hub: RunningHub, onPhase: DeviceHostPhaseListener): Promise<AgentDeviceEndpoint> {
    const agentTool = await this.install('agent', onPhase)
    onPhase('starting')
    await mkdir(this.agentStateDir(), { recursive: true, mode: 0o700 })
    const existing = await this.readDaemonFile()
    if (existing && existing.version === AGENT_DEVICE_VERSION) {
      const healthy = await this.fetch(`http://127.0.0.1:${existing.httpPort}/health`, { signal: AbortSignal.timeout(2_000) })
        .then((response) => response.ok).catch(() => false)
      if (healthy) return { baseUrl: `http://127.0.0.1:${existing.httpPort}`, token: existing.token }
    }
    await rm(join(this.agentStateDir(), 'daemon.json'), { force: true }).catch(() => {})
    await this.run(hub.nodePath, [agentTool.entryPath, 'devices', '--json'], {
      timeoutMs: DAEMON_READY_TIMEOUT_MS,
      env: {
        ...this.env,
        AGENT_DEVICE_STATE_DIR: this.agentStateDir(),
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        // Solus owns the daemon lifetime and stops it explicitly.
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    })
    const daemon = await this.readDaemonFile()
    if (!daemon) throw new DeviceHostError(this.deviceHostId, 'starting agent tools', `no daemon answered within ${DAEMON_READY_TIMEOUT_MS} ms`)
    log.info('agent_device_daemon_started', { port: daemon.httpPort, pid: daemon.pid })
    return { baseUrl: `http://127.0.0.1:${daemon.httpPort}`, token: daemon.token }
  }
}

/** `ps` for one PID's command line; null when it is gone. */
export async function processCommandLine(pid: number, run: DeviceCommandRunner): Promise<string | null> {
  const result = await run('ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 5_000 })
  return result.code === 0 ? result.stdout.trim() || null : null
}
