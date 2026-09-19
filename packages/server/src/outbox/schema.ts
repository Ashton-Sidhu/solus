import { bigint, defineTable, text } from '../db/schema/define-table'

/**
 * Where the workspace service is in each runner's delivery streams
 * (docs/plans/cloud-service-model.md §16). A runner numbers what it delivers;
 * the service keeps the last sequence it applied per stream and skips anything
 * at or below it, so a redelivery after a lost ack applies nothing twice. One
 * row per organization, runner, and stream.
 */
export const runnerCursors = defineTable('runner_cursors', {
  organization_id: text({ notNull: true }),
  host_id: text({ notNull: true }),
  stream: text({ notNull: true }),
  last_seq: bigint({ notNull: true, default: 0 }),
  updated_at: bigint({ notNull: true }),
}, {
  primaryKey: ['organization_id', 'host_id', 'stream'],
})

export const OUTBOX_TABLES = [runnerCursors]
