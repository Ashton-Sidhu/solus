import { bigint, defineTable, text } from '../../db/schema/define-table'

/**
 * Where the Solus API is in each runner's delivery streams
 * (docs/plans/cloud-service-model.md §16). A runner numbers what it delivers;
 * the service keeps the last sequence it applied per stream and skips anything
 * at or below it, so a redelivery after a lost ack applies nothing twice. One
 * row per organization, runner, delivering person, and stream: rows of different
 * people interleave in one runner's sequence, and each travels with its own
 * person's token (plans/010-standard-oauth.md).
 */
export const runnerCursors = defineTable('runner_cursors', {
  organization_id: text({ notNull: true }),
  host_id: text({ notNull: true }),
  actor_user_id: text({ notNull: true, default: '' }),
  stream: text({ notNull: true }),
  last_seq: bigint({ notNull: true, default: 0 }),
  updated_at: bigint({ notNull: true }),
}, {
  primaryKey: ['organization_id', 'host_id', 'actor_user_id', 'stream'],
})

export const OUTBOX_TABLES = [runnerCursors]
