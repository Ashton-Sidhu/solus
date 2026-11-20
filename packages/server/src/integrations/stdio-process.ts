import { createHash } from 'node:crypto'
import type { Stream } from 'node:stream'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client'
import type { Integration, IntegrationEnvValue, IntegrationLaunch, IntegrationProcessFacts, IntegrationStopReason } from '@solus/contracts/integration-types'
import { getCliPath } from '../cli-env'
import { createLogger } from '../logger'
import { resolveHomePath } from '../platform/paths'

const log = createLogger('integrations', 'stdio-process.ts')

/**
 * A `stdio` integration's process (docs/plans/mcp-first-class.md §7.3): its
 * address, how it starts, the tail of its standard error, and the state each
 * person's process is in. The gateway owns the sessions; the SDK transport
 * owns the one child it started, and nothing here looks for a process by
 * name, command, or path.
 */

/** The last part of standard error that the owner sees (§7.3). */
const STDERR_TAIL_BYTES = 4096
/** An end this soon after a start counts toward `failed`. */
const QUICK_END_MS = 10_000
/** Three quick ends in this window set `failed`. */
const QUICK_END_WINDOW_MS = 5 * 60_000
const QUICK_ENDS_TO_FAIL = 3
/** A command that gives no MCP answer in this time did not start (§7.7). */
export const STDIO_START_TIMEOUT_MS = 30 * 1000

/** The idle timers and the times of `stdio` starts and ends; a test gives a fake one. */
export interface GatewayClock {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
  now(): number
}

export const SYSTEM_CLOCK: GatewayClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
  now: () => Date.now(),
}

/** The one child a `stdio` session's transport started (§7.3). */
export interface StdioChild {
  pid: number | null
  stderr: StderrTail
  startedAt: number
  /** It ended by itself, or the gateway closed it: calls in flight fail with the stopped text. */
  ended: boolean
}

/** `stdio:` and the first 16 hexadecimal characters of SHA-256 over `[command, ...args]` (§7.1). */
export function stdioServerAddress(launch: Pick<IntegrationLaunch, 'command' | 'args'>): string {
  return `stdio:${createHash('sha256').update(JSON.stringify([launch.command, ...launch.args])).digest('hex').slice(0, 16)}`
}

/**
 * The transport that starts the command, with no shell (§7.3). The child's
 * environment is the SDK's default set (`HOME`, `LOGNAME`, `PATH`, `SHELL`,
 * `TERM`, `USER` on macOS and Linux, read from the server's process), with
 * `PATH` replaced by the login shell's (`getCliPath`), plus the person's
 * values. No other variable of the Solus server reaches it.
 */
export function stdioTransport(integration: Pick<Integration, 'launch'>, environment: IntegrationEnvValue[]): StdioClientTransport {
  const launch = integration.launch
  if (!launch) throw new Error('This command has no launch.')
  return new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: { PATH: getCliPath(), ...Object.fromEntries(environment.map(({ name, value }) => [name, value])) },
    cwd: resolveHomePath(launch.cwd ?? '~'),
    stderr: 'pipe',
  })
}

/** The last 4 KB a process wrote to standard error, kept in memory only. It is never logged; a log has its size. */
export class StderrTail {
  private text = ''
  /** Every byte the process wrote, for the log. */
  bytes = 0

  constructor(stream: Stream | null) {
    // A pipe nobody reads fills up and stops the child, so the tail always reads it.
    stream?.on('data', (chunk: Buffer) => {
      const added = chunk.toString('utf8')
      this.bytes += chunk.byteLength
      this.text = (this.text + added).slice(-STDERR_TAIL_BYTES)
    })
  }

  get tail(): string | undefined {
    return this.text.trim() ? this.text : undefined
  }
}

/** The code `spawn` gave a missing or unusable program, from anywhere in a chain of causes. */
function spawnFailure(cause: unknown): 'ENOENT' | 'EACCES' | 'ENOTDIR' | null {
  for (let current = cause, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth++) {
    const code = 'code' in current ? current.code : undefined
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') return code
  }
  return null
}

/** The person's words for a command that cannot start, or null when it started. */
function notStartedMessage(integration: Pick<Integration, 'launch'>, cause: unknown): string | null {
  const failure = spawnFailure(cause)
  if (!failure) return null
  const command = integration.launch?.command ?? 'The command'
  if (failure === 'EACCES') return `\`${command}\` cannot be run on this host: it is not a program the Solus server may start.`
  // `spawn` reports a missing working directory as the program, so the folder is named too.
  const cwd = integration.launch?.cwd
  return cwd
    ? `\`${command}\` is not installed on this host, or the folder ${cwd} does not exist.`
    : `\`${command}\` is not installed on this host, or it is not on the PATH of the Solus server.`
}

interface ProcessRecord {
  state: 'stopped' | 'failed'
  message?: string
  stopReason?: IntegrationStopReason
  stderrTail?: string
  startFailure?: IntegrationProcessFacts['startFailure']
  /** The times of the ends that came soon after a start, the oldest first. */
  quickEnds: number[]
}

/**
 * The state of each person's process of each `stdio` integration, by the
 * gateway's key for (integration, person). `running` is the gateway's answer:
 * a live session. This keeps what a stopped or failed process left behind.
 */
export class StdioProcessStates {
  private readonly records = new Map<string, ProcessRecord>()

  constructor(private readonly now: () => number) {}

  /** What `IntegrationFacts.process` says when no session runs. */
  facts(key: string): IntegrationProcessFacts {
    const record = this.records.get(key)
    if (!record) return { state: 'stopped' }
    const facts: IntegrationProcessFacts = { state: record.state }
    if (record.message) facts.message = record.message
    if (record.stopReason) facts.stopReason = record.stopReason
    if (record.stderrTail) facts.stderrTail = record.stderrTail
    if (record.startFailure) facts.startFailure = record.startFailure
    return facts
  }

  /** Why the process may not start now, or null. */
  refusal(key: string): string | null {
    const record = this.records.get(key)
    return record?.state === 'failed' ? record.message ?? 'This command failed. Press Start again.' : null
  }

  /** A start that worked: what an older end left behind is gone, but the count of quick ends stays. */
  started(key: string): void {
    const record = this.records.get(key)
    if (record) {
      delete record.message
      delete record.stderrTail
    }
  }

  /** Stop, an idle close, room at the limit, or the host's stop (no reason). A failed process stays failed. */
  stopped(key: string, reason: IntegrationStopReason | undefined): void {
    const record = this.records.get(key)
    if (record?.state === 'failed') return
    const next: ProcessRecord = { state: 'stopped', quickEnds: record?.quickEnds ?? [] }
    if (reason) next.stopReason = reason
    this.records.set(key, next)
  }

  /**
   * The process ended by itself, or ended before it answered. Three such ends
   * within 10 seconds of a start, in 5 minutes, set `failed`. Answers the state.
   */
  ended(key: string, startedAt: number, message: string, stderrTail: string | undefined): IntegrationProcessFacts['state'] {
    const now = this.now()
    const quickEnds = (this.records.get(key)?.quickEnds ?? []).filter((at) => now - at <= QUICK_END_WINDOW_MS)
    if (now - startedAt <= QUICK_END_MS) quickEnds.push(now)
    const failed = quickEnds.length >= QUICK_ENDS_TO_FAIL
    this.records.set(key, {
      state: failed ? 'failed' : 'stopped',
      message: failed ? `${message} It ended ${QUICK_ENDS_TO_FAIL} times soon after it started, so Solus does not start it again until you press Start again.` : message,
      stderrTail,
      quickEnds,
    })
    return failed ? 'failed' : 'stopped'
  }

  /**
   * Why a command did not start, recorded as its state (§7.7): not installed
   * (`failed` at once: no retry would help), ended at start, or no MCP answer
   * in 30 seconds (each one an end soon after a start). Answers the error the
   * caller throws.
   */
  startFailed(key: string, integration: Pick<Integration, 'id' | 'name' | 'launch'>, startedAt: number, stderr: StderrTail, cause: unknown): Error {
    const notStarted = notStartedMessage(integration, cause)
    const timedOut = cause instanceof SdkError && cause.code === SdkErrorCode.RequestTimeout
    const message = notStarted
      ?? (timedOut ? `${integration.name} did not answer as an MCP server within ${STDIO_START_TIMEOUT_MS / 1000} seconds.` : `${integration.name} ended before it answered as an MCP server.`)
    if (notStarted) this.records.set(key, { state: 'failed', message: notStarted, startFailure: spawnFailure(cause) === 'EACCES' ? 'not-runnable' : 'not-installed', quickEnds: [] })
    else this.ended(key, startedAt, message, stderr.tail)
    // The size of standard error only: it can hold a secret the server printed.
    log.warn('integration_process_start_failed', { integrationId: integration.id, notInstalled: notStarted !== null, timedOut, stderrBytes: stderr.bytes })
    return new Error(this.refusal(key) ?? message)
  }

  /** Start again, or a change of the record. */
  clear(key: string): void {
    this.records.delete(key)
  }

  /** Every person's record of one integration. */
  clearIntegration(keyPrefix: string): void {
    for (const key of this.records.keys()) if (key.startsWith(keyPrefix)) this.records.delete(key)
  }
}
