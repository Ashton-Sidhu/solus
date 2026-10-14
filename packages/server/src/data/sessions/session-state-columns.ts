import type { SessionSettledBy, SessionState } from '@solus/contracts/session-state'

/** The `session_states` columns that say where a session is in the list. */
export interface SessionStateColumns {
  settled_at: number | null
  settled_by: SessionSettledBy | null
  snoozed_until: number | null
  snooze_note: string | null
  archived_at: number | null
}

/** A row's state; null when nothing settled, snoozed, or archived the session. */
export function stateFromColumns(row: SessionStateColumns): SessionState | null {
  if (row.settled_at === null && row.snoozed_until === null && row.archived_at === null) return null
  return {
    settledAt: row.settled_at,
    settledBy: row.settled_by,
    snoozedUntil: row.snoozed_until,
    snoozeNote: row.snooze_note,
    archivedAt: row.archived_at,
  }
}
