// Where a session is in a person's list (docs/plans/session-pull-requests.md):
// active, settled, or snoozed. The host holds it, so every client agrees.

/** What settled a session: a person, its pull requests ending, its task
 *  finishing, or a long time with no activity. */
export type SessionSettledBy = 'person' | 'pull-request' | 'task' | 'idle'

export interface SessionState {
  /** The stable Solus session id. */
  sessionId: string
  /** When the session became settled. Null while it is active. */
  settledAt: number | null
  settledBy: SessionSettledBy | null
  /** The wake time of a snooze. A time in the past is a snooze that ended. */
  snoozedUntil: number | null
  snoozeNote: string | null
}

/**
 * A settled or snoozed session as a list shows it when no conversation of it
 * is open on the client: its state, and enough of its record to name it and
 * open it again.
 */
export interface SessionShelfEntry extends SessionState {
  title: string | null
  /** The project the session belongs to, as its host names it. */
  projectPath: string | null
}
