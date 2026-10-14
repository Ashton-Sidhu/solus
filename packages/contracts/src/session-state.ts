// Where a session is in a person's list (docs/plans/session-archive.md). Its
// home holds it: the organization's Solus API for an organization session, the
// machine for a personal one.

/** What settled a session: a person, its pull requests ending, or its task
 *  finishing. `idle` is on sessions settled before idle sessions left the
 *  list by rule. */
export type SessionSettledBy = 'person' | 'pull-request' | 'task' | 'idle'

/** What every person sees of a session: whether its work is finished. */
export interface SessionState {
  /** When the session became settled. Null while it is not settled. */
  settledAt: number | null
  settledBy: SessionSettledBy | null
}

/** One person's own view of a session. It changes that person's list, and
 *  nobody else's. */
export interface SessionView {
  /** When this person took the session out of their list. */
  archivedAt: number | null
  /** The wake time of this person's snooze. A time in the past is a snooze that ended. */
  snoozedUntil: number | null
  snoozeNote: string | null
}

/** The state of a session nothing settled. */
export const UNSETTLED_SESSION_STATE: SessionState = { settledAt: null, settledBy: null }

/** The view of a person who did nothing to a session. */
export const EMPTY_SESSION_VIEW: SessionView = { archivedAt: null, snoozedUntil: null, snoozeNote: null }

/** A session leaves a person's list after this long with no activity, unless
 *  that person snoozed it or it waits on an open pull request. */
export const SESSION_LIST_IDLE_MS = 30 * 24 * 60 * 60_000

/** Where a session is in the caller's list: its shared state and their own view. */
export interface SessionPlace {
  state: SessionState
  view: SessionView
}

/** A change to one session. `settled` changes it for every person; the other
 *  fields change only the caller's own view. */
export interface SessionChange {
  /** Settle it, or make a settled one active again. */
  settled?: boolean
  /** Take it out of the caller's list, or return it. */
  archived?: boolean
  /** Snooze it until a wake time; null wakes it now. */
  snoozedUntil?: number | null
  /** Why it is snoozed. Only with `snoozedUntil`. */
  snoozeNote?: string
}
