import { createHash } from 'node:crypto'
import type { Watch, WatchProbeResult, WatchSchedule, WatchUntil } from '@solus/contracts/watch-types'

/** Shortest probe interval. A tighter loop only spends the host's and the
 *  probed service's resources; a wait that needs seconds is a background shell. */
export const MIN_WATCH_INTERVAL_SECONDS = 15
export const DEFAULT_PROBE_TIMEOUT_SECONDS = 60
export const MAX_PROBE_TIMEOUT_SECONDS = 600
export const DEFAULT_MAX_WAKES = 5
export const DEFAULT_EXPIRES_IN_HOURS = 24
export const MAX_EXPIRES_IN_HOURS = 7 * 24
/** Watches one session may have waiting at a time. Watches run with no
 *  permission prompt, so an agent cannot fill the host with them. */
export const MAX_ACTIVE_WATCHES_PER_SESSION = 10
/** Consecutive probe errors that end a watch as failed. */
export const MAX_CONSECUTIVE_PROBE_ERRORS = 3
/** The part of the probe output the host keeps. */
export const OUTPUT_TAIL_CHARS = 16_000
/** The part of the probe output a wake prompt carries. */
const WAKE_OUTPUT_CHARS = 8_000

export function fingerprintOf(result: WatchProbeResult): string {
  return createHash('sha256').update(`${result.exitCode}\n${result.outputTail}`).digest('hex').slice(0, 32)
}

/** A timeout, a spawn failure, or a shell that could not run the command is
 *  not an answer to the question the probe asks. */
export function isProbeError(result: WatchProbeResult): boolean {
  return !!result.error || result.exitCode === null || result.exitCode === 126 || result.exitCode === 127
}

/** Whether a probe result ends the wait. `previousFingerprint` is the output
 *  the watch saw before this one; `outputChanges` never matches the first run. */
export function untilMatches(until: WatchUntil, result: WatchProbeResult, previousFingerprint: string | undefined): boolean {
  if ('exitCodes' in until) return result.exitCode !== null && until.exitCodes.includes(result.exitCode)
  if ('outputMatches' in until) return new RegExp(until.outputMatches, 'm').test(result.outputTail)
  return previousFingerprint !== undefined && fingerprintOf(result) !== previousFingerprint
}

export function validUntilPattern(pattern: string): string | null {
  try {
    new RegExp(pattern, 'm')
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function nextRunAfter(schedule: WatchSchedule, from: Date): string {
  if ('at' in schedule) return schedule.at
  return new Date(from.getTime() + schedule.everySeconds * 1000).toISOString()
}

function tail(text: string, chars: number): string {
  return text.length > chars ? `…${text.slice(-chars)}` : text
}

/** The prompt the host sends into the session when a watch wakes it. */
export function wakePrompt(watch: Watch, result: WatchProbeResult | undefined, ending: string | null): string {
  const lines = [`Watch ${watch.id} woke this conversation.`, `Reason: ${watch.reason}`]
  if (watch.probe && result) {
    lines.push(
      `Probe: ${watch.probe.command}`,
      result.error ? `Probe error: ${result.error}` : `Exit code: ${result.exitCode}`,
      'Output (last part):',
      '```',
      tail(result.outputTail, WAKE_OUTPUT_CHARS) || '(no output)',
      '```',
    )
  }
  lines.push(`This is wake ${watch.wakeCount} of ${watch.maxWakes}.`)
  lines.push(ending
    ?? `The watch runs again after this turn. To stop it, call cancel_watch with watch_id "${watch.id}".`)
  return lines.join('\n')
}

/** What the woken session's bubble shows; the prompt itself carries the output. */
export function wakeDisplayText(watch: Watch, result: WatchProbeResult | undefined): string {
  if (!watch.probe || !result) return watch.reason
  const outcome = result.error ? `probe error: ${result.error}` : `exit ${result.exitCode}`
  return `${watch.reason}\n\n${watch.probe.command} → ${outcome}`
}

/** One line for the agent's list_watches and the tool result. */
export function describeWatch(watch: Watch): string {
  const parts = [`${watch.id} — ${watch.status}`, `"${watch.reason}"`]
  if (watch.probe) parts.push(`probe: ${watch.probe.command}`)
  parts.push(`wakes ${watch.wakeCount}/${watch.maxWakes}`)
  if (watch.status === 'waiting' && watch.nextRunAt) parts.push(`next run ${watch.nextRunAt}`)
  if (watch.endReason) parts.push(watch.endReason)
  return parts.join(', ')
}
