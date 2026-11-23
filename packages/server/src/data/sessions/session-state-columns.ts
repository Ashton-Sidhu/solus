import type { SessionSettledBy, SessionState, SessionView } from '@solus/contracts/session-state'

/** The `session` columns that say whether a session is settled. */
export interface SessionStateColumns {
  auto_settle_disabled_at?: number | null
  settled_at: number | null
  settled_by: SessionSettledBy | null
}

/** The `personal_resource_state` columns of one person's view of a session. */
export interface SessionViewColumns {
  pin_order_key?: string | null
  active_order_key?: string | null
  view_settled_at: number | null
  archived_at: number | null
  snoozed_until: number | null
  viewed_at: number | null
  snooze_note: string | null
}

/** A row's shared state; null when nothing settled the session. */
export function stateFromColumns(row: SessionStateColumns): SessionState | null {
  return row.settled_at === null && row.auto_settle_disabled_at == null ? null : { settledAt: row.settled_at, settledBy: row.settled_by, ...(row.auto_settle_disabled_at != null && { autoSettleDisabledAt: row.auto_settle_disabled_at }) }
}

/** A person's view, including the last completion they read. */
export function viewFromColumns(row: SessionViewColumns): SessionView | null {
  if (row.view_settled_at === null && row.archived_at === null && row.snoozed_until === null && row.viewed_at === null && !row.pin_order_key && !row.active_order_key) return null
  return { ...(row.pin_order_key && { pinOrderKey: row.pin_order_key }), ...(row.active_order_key && { activeOrderKey: row.active_order_key }), settledAt: row.view_settled_at, archivedAt: row.archived_at, snoozedUntil: row.snoozed_until, snoozeNote: row.snooze_note, ...(row.viewed_at === null ? {} : { viewedAt: row.viewed_at }) }
}
