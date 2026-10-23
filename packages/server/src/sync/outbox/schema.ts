import { bigint, defineTable, text } from '../../db/schema/define-table'

/**
 * Where the Solus API is in each host's delivery (docs/plans/simplify-auth-and-sync.md
 * §4.5). A host numbers what it delivers in one sequence; the API keeps the last
 * sequence it applied for each (host, delivering person) and skips anything at or
 * below it, so a redelivery after a lost acknowledgement applies nothing twice. Rows
 * of different people interleave in one host's sequence, and each travels with its
 * own person's token (plans/010-standard-oauth.md).
 */
export const runnerDeliveryCursors = defineTable('runner_delivery_cursors', {
  organization_id: text({ notNull: true }),
  host_id: text({ notNull: true }),
  actor_user_id: text({ notNull: true, default: '' }),
  last_seq: bigint({ notNull: true, default: 0 }),
  updated_at: bigint({ notNull: true }),
}, {
  primaryKey: ['organization_id', 'host_id', 'actor_user_id'],
})

export const OUTBOX_TABLES = [runnerDeliveryCursors]
