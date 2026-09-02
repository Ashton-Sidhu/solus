import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { createLogger } from '../../logger'
import { findOnPath, getCliPath } from '../../cli-env'

const log = createLogger('main', 'uplink-connector')

/**
 * Runs `cloudflared tunnel run` for a linked host (docs/plans/personal-uplink.md, H3).
 * The run token travels only in the child's environment — never argv, never a log
 * line — and the process is restarted with bounded backoff for as long as the link
 * is desired. What the connector observes stays on this host: it is the Access tab's
 * status line, nothing more.
 */

export type ConnectorObservation =
  | { observed: 'online' }
  | { observed: 'offline' }
  | { observed: 'error'; error: string }

/** The one `spawn` signature the connector uses; a test can wrap the real one. */
export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface ConnectorDeps {
  /** Absolute path of the `cloudflared` binary, or null when none is installed. */
  resolveBinary: () => string | null
  onObservation: (observation: ConnectorObservation) => void
  spawnImpl?: SpawnLike
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

const RESTART_BASE_MS = 1_000
const RESTART_MAX_MS = 30_000
const STOP_GRACE_MS = 3_000

/**
 * `cloudflared` keeps several edge connections at once (four by default) and names
 * each by `connIndex`. The tunnel carries traffic while at least one is registered.
 */
const REGISTERED_PATTERN = /Registered tunnel connection.*connIndex=(\d+)/i
const UNREGISTERED_PATTERN = /Unregistered tunnel connection.*connIndex=(\d+)/i

export const CLOUDFLARED_BINARY = 'cloudflared'

/** The system binary or an explicit override. */
export function resolveCloudflaredBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.SOLUS_CLOUDFLARED?.trim()
  if (override && existsSync(override)) return override
  return findOnPath(CLOUDFLARED_BINARY, getCliPath())
}

export class CloudflaredConnector {
  private child: ChildProcess | null = null
  private token: string | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartAttempt = 0
  private readonly registeredConnections = new Set<string>()
  private stopping: Promise<void> | null = null

  constructor(private readonly deps: ConnectorDeps) {}

  get running(): boolean {
    return this.child !== null
  }

  /** Idempotent: a running connector with the same token is left alone. */
  start(token: string): void {
    if (this.child && this.token === token) return
    this.token = token
    this.restartAttempt = 0
    this.clearRestartTimer()
    if (this.child) {
      void this.stop().then(() => { if (this.token === token) this.spawnProcess() })
      return
    }
    this.spawnProcess()
  }

  async stop(): Promise<void> {
    this.token = null
    this.clearRestartTimer()
    const child = this.child
    if (!child) return
    if (this.stopping) return this.stopping
    this.stopping = new Promise<void>((resolve) => {
      const setTimeoutFn = this.deps.setTimeoutFn ?? setTimeout
      const clearTimeoutFn = this.deps.clearTimeoutFn ?? clearTimeout
      const killTimer = setTimeoutFn(() => child.kill('SIGKILL'), STOP_GRACE_MS)
      child.once('exit', () => {
        clearTimeoutFn(killTimer)
        resolve()
      })
      child.kill('SIGTERM')
    }).finally(() => {
      this.child = null
      this.stopping = null
      this.registeredConnections.clear()
      this.deps.onObservation({ observed: 'offline' })
    })
    return this.stopping
  }

  private spawnProcess(): void {
    const token = this.token
    if (!token) return
    const binary = this.deps.resolveBinary()
    if (!binary) {
      // Looked up again on every attempt, so installing it later needs no re-link.
      this.deps.onObservation({ observed: 'error', error: 'cloudflared is not installed on this host' })
      this.scheduleRestart()
      return
    }
    const spawnImpl: SpawnLike = this.deps.spawnImpl ?? spawn
    let child: ChildProcess
    try {
      child = spawnImpl(binary, ['tunnel', '--no-autoupdate', 'run'], {
        env: { ...process.env, TUNNEL_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      this.deps.onObservation({ observed: 'error', error: err instanceof Error ? err.message : String(err) })
      this.scheduleRestart()
      return
    }
    this.child = child
    this.registeredConnections.clear()
    log.info('cloudflared_started', { pid: child.pid ?? null, binary })

    const onLine = (line: string) => this.handleOutputLine(line)
    child.stdout?.on('data', (chunk: Buffer) => splitLines(chunk, onLine))
    child.stderr?.on('data', (chunk: Buffer) => splitLines(chunk, onLine))
    child.once('error', (err) => {
      this.deps.onObservation({ observed: 'error', error: err.message })
    })
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.registeredConnections.clear()
      log.info('cloudflared_exited', { code, signal })
      // A deliberate stop resolves through stop(); anything else is a crash to recover from.
      if (this.stopping || this.token !== token) return
      this.deps.onObservation({ observed: 'offline' })
      this.scheduleRestart()
    })
  }

  private handleOutputLine(line: string): void {
    const registered = REGISTERED_PATTERN.exec(line)
    if (registered) {
      this.restartAttempt = 0
      const wasOnline = this.registeredConnections.size > 0
      this.registeredConnections.add(registered[1])
      if (!wasOnline) this.deps.onObservation({ observed: 'online' })
      return
    }
    const unregistered = UNREGISTERED_PATTERN.exec(line)
    if (unregistered) {
      this.registeredConnections.delete(unregistered[1])
      if (this.registeredConnections.size === 0) this.deps.onObservation({ observed: 'offline' })
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer || !this.token) return
    this.restartAttempt += 1
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (this.restartAttempt - 1))
    const setTimeoutFn = this.deps.setTimeoutFn ?? setTimeout
    this.restartTimer = setTimeoutFn(() => {
      this.restartTimer = null
      if (this.token) this.spawnProcess()
    }, delay)
    this.restartTimer.unref?.()
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return
    const clearTimeoutFn = this.deps.clearTimeoutFn ?? clearTimeout
    clearTimeoutFn(this.restartTimer)
    this.restartTimer = null
  }
}

function splitLines(chunk: Buffer, onLine: (line: string) => void): void {
  for (const line of chunk.toString('utf8').split(/\r?\n/)) {
    if (line.trim()) onLine(line)
  }
}
