import { bigint, defineTable, integer, text } from '../db/schema/define-table'

/**
 * The collaboration plane's session records
 * (docs/plans/cloud-service-model.md): one row per session, the facts every
 * client lists by. The transcript index (`sessions`, `session_messages`,
 * `session_fts`, `session_files`) stays runner-local in the host's file.
 */
export const sessionRecords = defineTable('session_records', {
  session_id: text({ primaryKey: true }),
  organization_id: text({ notNull: true, default: 'local' }),
  owner_user_id: text(),
  provider: text({ notNull: true }),
  project_path: text({ notNull: true }),
  project_remote: text(),
  runner_host_id: text(),
  title: text(),
  custom_title: text(),
  status: text({ notNull: true, default: 'idle' }),
  model: text(),
  reasoning_effort: text(),
  parent_session_id: text(),
  root_session_id: text(),
  created_at: bigint({ notNull: true }),
  last_activity_at: bigint({ notNull: true }),
  size: integer({ notNull: true, default: 0 }),
}, {
  indexes: [
    { name: 'session_records_by_project', columns: ['organization_id', 'project_path', 'last_activity_at'], descending: ['last_activity_at'] },
    { name: 'session_records_by_provider', columns: ['organization_id', 'provider', 'last_activity_at'], descending: ['last_activity_at'] },
  ],
})

/**
 * The durable prompt queue on a session's record (§4): a prompt a person sent
 * to a cloud session while its runner was away. `waiting` until the runner
 * claims it, `claimed` while the runner holds it under the session's lease,
 * then `dispatched` or `failed`. The runner settles it by the epoch it claimed
 * it under, so a runner that lost the lease cannot settle another's claim.
 */
export const sessionPromptQueue = defineTable('session_prompt_queue', {
  id: text({ primaryKey: true }),
  organization_id: text({ notNull: true, default: 'local' }),
  session_id: text({ notNull: true }),
  author_user_id: text({ notNull: true }),
  author_display_name: text(),
  text: text({ notNull: true }),
  state: text({ notNull: true, default: 'waiting' }),
  claimed_by_host_id: text(),
  claim_epoch: integer(),
  created_at: bigint({ notNull: true }),
  claimed_at: bigint(),
  settled_at: bigint(),
  error: text(),
}, {
  indexes: [
    { name: 'session_prompt_queue_session_idx', columns: ['organization_id', 'session_id', 'created_at'] },
    { name: 'session_prompt_queue_waiting_idx', columns: ['organization_id', 'state', 'created_at'] },
  ],
})

/**
 * Which runner may drain a session's queue (§4): one holder per session, with
 * an epoch that advances every time the holder changes, and an expiry the
 * holder renews while it works. A claim from another runner while the lease
 * is live is refused; after expiry it takes the lease at the next epoch.
 */
export const sessionRunnerLeases = defineTable('session_runner_leases', {
  session_id: text({ primaryKey: true }),
  organization_id: text({ notNull: true, default: 'local' }),
  host_id: text({ notNull: true }),
  epoch: integer({ notNull: true, default: 1 }),
  expires_at: bigint({ notNull: true }),
})

export const SESSION_TABLES = [sessionRecords, sessionPromptQueue, sessionRunnerLeases]
