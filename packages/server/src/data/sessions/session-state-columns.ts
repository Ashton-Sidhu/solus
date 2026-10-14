import type { SessionSettledBy, SessionState, SessionView } from '@solus/contracts/session-state'

/** The `session_states` columns that say whether a session is settled. */
export interface SessionStateColumns {
  settled_at: number | null
  settled_by: SessionSettledBy | null
}

/** The `session_views` columns of one person's view of a session. */
export interface SessionViewColumns {
  archived_at: number | null
  snoozed_until: number | null
  snooze_note: string | null
}

/** A row's shared state; null when nothing settled the session. */
export function stateFromColumns(row: SessionStateColumns): SessionState | null {
  return row.settled_at === null ? null : { settledAt: row.settled_at, settledBy: row.settled_by }
}

/** A person's view; null when they neither archived nor snoozed the session. */
export function viewFromColumns(row: SessionViewColumns): SessionView | null {
  if (row.archived_at === null && row.snoozed_until === null) return null
  return { archivedAt: row.archived_at, snoozedUntil: row.snoozed_until, snoozeNote: row.snooze_note }
}
