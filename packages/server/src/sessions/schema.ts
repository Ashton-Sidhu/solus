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

export const SESSION_TABLES = [sessionRecords]
