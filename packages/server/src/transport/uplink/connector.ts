import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { createLogger } from '../../logger'
import { findOnPath, getCliPath } from '../../cli-env'
import { dataDir } from '../../platform/paths'

const log = createLogger('main', 'uplink-connector')

/**
 * Runs `cloudflared tunnel run` for a linked host (docs/plans/personal-uplink.md, H3).
 * The run token travels only in the child's environment — never argv, never a log
 * line — and the process is restarted with bounded backoff for as long as the link
 * is desired. It is also restarted when its `/ready` check keeps reporting no edge
 * connection, and it moves to HTTP/2 when QUIC keeps stalling (constants below).
 * What the connector observes stays on this host: it is the Access tab's
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
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
  /** Answers the readiness check; only the HTTP status is read. */
  fetchReady?: (url: string, signal: AbortSignal) => Promise<{ status: number }>
  now?: () => number
  /** The environment the child inherits; also where an explicit transport choice is read. */
  env?: NodeJS.ProcessEnv
}

const RESTART_BASE_MS = 1_000
const RESTART_MAX_MS = 30_000
const STOP_GRACE_MS = 3_000

/**
 * `cloudflared` resolves the edge only at start. After a network or VPN change it
 * can keep running with zero connections, and `/ready` answers 503. After this many
 * 503s in a row (about three minutes) the child is stopped and the restart path
 * starts a fresh one. Each watchdog restart that is not followed by a ready answer
 * doubles the count, up to about thirty minutes, so a host that is really offline
 * does not restart every few minutes. Only an explicit 503 counts: a failed request
 * says nothing about the tunnel.
 */
const READY_INTERVAL_MS = 30_000
const READY_REQUEST_TIMEOUT_MS = 5_000
const NOT_READY_CHECKS_BEFORE_RESTART = 6
const NOT_READY_CHECKS_MAX = 60
const METRICS_PATTERN = /\bStarting metrics server on (127\.0\.0\.1:\d+)\/metrics\b/

/**
 * Some networks register QUIC and then drop it again and again through idle
 * timeouts. This many stall lines in the window switch the connector to HTTP/2 for
 * the life of this connector. The count survives registrations and restarts,
 * because a registration resets cloudflared's own fallback.
 */
const QUIC_STALL_PATTERN = /\btimeout: no recent network activity\b/
const QUIC_STALLS_BEFORE_HTTP2 = 30
const QUIC_STALL_WINDOW_MS = 5 * 60_000

/**
 * `cloudflared` keeps several edge connections at once (four by default) and names
 * each by `connIndex`. The tunnel carries traffic while at least one is registered.
 */
const REGISTERED_PATTERN = /Registered tunnel connection.*connIndex=(\d+)/i
const UNREGISTERED_PATTERN = /Unregistered tunnel connection.*connIndex=(\d+)/i

export const CLOUDFLARED_BINARY = 'cloudflared'

/** The explicit override, Solus-managed binary, or a system binary. */
export function resolveCloudflaredBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.SOLUS_CLOUDFLARED?.trim()
  if (override && existsSync(override)) return override
  const managed = join(dataDir(), 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  if (existsSync(managed)) return managed
  return findOnPath(CLOUDFLARED_BINARY, getCliPath())
}

export class CloudflaredConnector {
  private child: ChildProcess | null = null
  private token: string | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartAttempt = 0
  private readonly registeredConnections = new Set<string>()
  private stopping: Promise<void> | null = null
  private readyTimer: ReturnType<typeof setInterval> | null = null
  private notReadyChecksBeforeRestart = NOT_READY_CHECKS_BEFORE_RESTART
  private quicStalls: number[] = []
  private useHttp2 = false

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
    this.stopReadinessWatch()
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
      const args = [
        'tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:0',
        ...(this.useHttp2 ? ['--protocol', 'http2'] : []),
        'run',
      ]
      child = spawnImpl(binary, args, {
        env: { ...(this.deps.env ?? process.env), TUNNEL_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      this.deps.onObservation({ observed: 'error', error: err instanceof Error ? err.message : String(err) })
      this.scheduleRestart()
      return
    }
    this.child = child
    this.registeredConnections.clear()
    log.info('cloudflared_started', { pid: child.pid ?? null, binary, protocol: this.useHttp2 ? 'http2' : 'auto' })

    const onLine = (line: string) => this.handleOutputLine(child, line)
    child.stdout?.on('data', (chunk: Buffer) => splitLines(chunk, onLine))
    child.stderr?.on('data', (chunk: Buffer) => splitLines(chunk, onLine))
    child.once('error', (err) => {
      this.deps.onObservation({ observed: 'error', error: err.message })
    })
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.registeredConnections.clear()
      this.stopReadinessWatch()
      log.info('cloudflared_exited', { code, signal })
      // A deliberate stop resolves through stop(); anything else is a crash to recover from.
      if (this.stopping || this.token !== token) return
      this.deps.onObservation({ observed: 'offline' })
      this.scheduleRestart()
    })
  }

  private handleOutputLine(child: ChildProcess, line: string): void {
    if (this.child !== child) return
    const metricsAddress = METRICS_PATTERN.exec(line)?.[1]
    if (metricsAddress) {
      this.watchReadiness(child, `http://${metricsAddress}/ready`)
      return
    }
    if (QUIC_STALL_PATTERN.test(line)) {
      this.noteQuicStall(child)
      return
    }
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

  /** A child that never logs its metrics address is not polled. */
  private watchReadiness(child: ChildProcess, readyUrl: string): void {
    this.stopReadinessWatch()
    const setIntervalFn = this.deps.setIntervalFn ?? setInterval
    const fetchReady = this.deps.fetchReady ?? ((url, signal) => fetch(url, { signal }))
    let notReadyChecks = 0
    const timer = setIntervalFn(() => {
      void fetchReady(readyUrl, AbortSignal.timeout(READY_REQUEST_TIMEOUT_MS)).then(
        ({ status }) => {
          // The answer can arrive after this child was stopped or replaced.
          if (this.readyTimer !== timer || this.child !== child) return
          if (status === 200) {
            notReadyChecks = 0
            this.notReadyChecksBeforeRestart = NOT_READY_CHECKS_BEFORE_RESTART
            return
          }
          if (status !== 503) return
          notReadyChecks += 1
          const threshold = this.notReadyChecksBeforeRestart
          if (notReadyChecks < threshold) return
          this.notReadyChecksBeforeRestart = Math.min(threshold * 2, NOT_READY_CHECKS_MAX)
          log.warn('cloudflared_not_ready_restart', { pid: child.pid ?? null, notReadyChecks })
          this.stopReadinessWatch()
          child.kill('SIGTERM')
        },
        () => {},
      )
    }, READY_INTERVAL_MS)
    timer.unref?.()
    this.readyTimer = timer
  }

  private stopReadinessWatch(): void {
    if (!this.readyTimer) return
    const clearIntervalFn = this.deps.clearIntervalFn ?? clearInterval
    clearIntervalFn(this.readyTimer)
    this.readyTimer = null
  }

  private noteQuicStall(child: ChildProcess): void {
    // An explicit transport in the environment is the operator's choice.
    if (this.useHttp2 || (this.deps.env ?? process.env).TUNNEL_TRANSPORT_PROTOCOL !== undefined) return
    const now = (this.deps.now ?? Date.now)()
    this.quicStalls = this.quicStalls.filter((at) => now - at < QUIC_STALL_WINDOW_MS)
    this.quicStalls.push(now)
    if (this.quicStalls.length < QUIC_STALLS_BEFORE_HTTP2) return
    this.useHttp2 = true
    this.quicStalls = []
    log.warn('cloudflared_quic_fallback_http2', { pid: child.pid ?? null, stalls: QUIC_STALLS_BEFORE_HTTP2 })
    // The exit path restarts the child, now with `--protocol http2`.
    child.kill('SIGTERM')
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
