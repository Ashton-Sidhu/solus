// Watches (docs/plans/watches.md): a durable record, owned by one session,
// that waits on the host and then wakes that session. The host runs the probe,
// decides when the wait ends, and enforces the stop; the agent does the work.

export type WatchStatus =
  | 'waiting'
  | 'paused'
  /** The host sent a wake and the woken turn has not ended yet. */
  | 'woken'
  | 'done'
  | 'exhausted'
  | 'expired'
  | 'cancelled'
  | 'failed'

export const WATCH_ENDED_STATUSES: readonly WatchStatus[] = ['done', 'exhausted', 'expired', 'cancelled', 'failed']

export function isWatchEnded(status: WatchStatus): boolean {
  return WATCH_ENDED_STATUSES.includes(status)
}

/** The command a watch runs on the host to read the current state. */
export interface WatchProbe {
  command: string
  timeoutSeconds: number
}

/** When the wait ends. Read against the probe result; ignored without a probe. */
export type WatchUntil =
  | { exitCodes: number[] }
  /** A regular expression tested against the probe output. */
  | { outputMatches: string }
  /** Any output different from the first probe run's. */
  | { outputChanges: true }

/** `at` is a single fire and is valid only without a probe. */
export type WatchSchedule = { everySeconds: number } | { at: string }

export interface WatchProbeResult {
  /** Null when the probe did not exit on its own (timeout or spawn failure). */
  exitCode: number | null
  /** The last part of stdout and stderr together. */
  outputTail: string
  at: string
  /** Set when the run was a probe error, not a result. */
  error?: string
}

export interface Watch {
  id: string
  /** The stable Solus session the watch wakes. */
  sessionId: string
  /** Resolved working directory the probe runs in. */
  cwd: string
  /** What the agent must do when it is woken. */
  reason: string
  probe?: WatchProbe
  schedule: WatchSchedule
  until?: WatchUntil
  /** What a met condition does: wake the agent with the result, or only
   *  tell the user. */
  onMatch: 'wake' | 'notify'
  /** Return to waiting after the woken turn ends. */
  repeat: boolean
  maxWakes: number
  expiresAt: string
  wakeCount: number
  consecutiveProbeErrors: number
  /** Hash of the last probe output, for `outputChanges`. */
  lastFingerprint?: string
  /** Hash of the result that caused the last wake, so one result wakes once. */
  wokenFingerprint?: string
  lastResult?: WatchProbeResult
  nextRunAt?: string
  status: WatchStatus
  /** Why the watch ended, in words for the user. */
  endReason?: string
  createdAt: string
  updatedAt: string
}

export interface WatchChangedEvent {
  watch: Watch
}
