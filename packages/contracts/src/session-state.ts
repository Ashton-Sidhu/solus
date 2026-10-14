// Where a session is in a person's list (docs/plans/session-pull-requests.md,
// docs/plans/session-archive.md): active, settled, snoozed, or archived. The
// host holds it, so every client agrees.

/** What settled a session: a person, its pull requests ending, or its task
 *  finishing. `idle` is on sessions settled before an idle session was
 *  archived instead. */
export type SessionSettledBy = 'person' | 'pull-request' | 'task' | 'idle'

export interface SessionState {
  /** When the session became settled. Null while it is not settled. */
  settledAt: number | null
  settledBy: SessionSettledBy | null
  /** The wake time of a snooze. A time in the past is a snooze that ended. */
  snoozedUntil: number | null
  snoozeNote: string | null
  /** When the session left the person's list. Null while it is in the list. */
  archivedAt: number | null
}

/** The state of a session nothing settled, snoozed, or archived. */
export const ACTIVE_SESSION_STATE: SessionState = {
  settledAt: null,
  settledBy: null,
  snoozedUntil: null,
  snoozeNote: null,
  archivedAt: null,
}
