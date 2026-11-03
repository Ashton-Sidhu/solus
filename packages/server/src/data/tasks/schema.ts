import { bigint, defineTable, integer, json, text } from '../../db/schema/define-table'

/**
 * The tasks domain's tables, declared once for both engines
 * (docs/plans/cloud-service-model.md). Column names and semantics are the
 * ones the SQLite migrations established; `organization_id` is new and
 * `'local'` on a host, so a cloud row can name its organization later.
 */

const ORGANIZATION = text({ notNull: true, default: 'local' })

export const tasks = defineTable('tasks', {
  id: text({ primaryKey: true }),
  short_id: integer({ unique: true }),
  project_key: text(),
  title: text({ notNull: true }),
  title_source: text({ notNull: true, default: 'prompt' }),
  body: text({ notNull: true, default: '' }),
  status: text({ notNull: true, default: 'inbox' }),
  assignee: text(),
  /** The Solus person assigned, by user key; never inferred from `assignee`. */
  assignee_user_id: text(),
  due_date: text(),
  priority: text(),
  labels: json({ notNull: true, default: '[]' }),
  /** Upstream epic snapshot (`TaskEpic`), written only by the sync engine. */
  epic: json(),
  source: text({ notNull: true, default: 'user' }),
  origin_session_id: text(),
  origin_automation_id: text(),
  created_at: bigint({ notNull: true }),
  updated_at: bigint({ notNull: true }),
  triaged_at: bigint(),
  done_at: bigint(),
  last_read_at: bigint(),
  /** `TaskLocation` JSON: the organization a shared task is in now
   * (cloud-sharing.md §3a). Null while the task is on this host; a row with a
   * location keeps its id, title, and links, and nothing else. */
  location: json(),
  organization_id: ORGANIZATION,
  /** The user id of who made the task (plans/029 decision 2): also its owner, never empty, never changed. */
  created_by: text({ notNull: true }),
  /** The position the task's next comment thread takes (`comment_threads.position`), advanced in the inserting transaction. */
  comment_position: integer({ notNull: true, default: 0 }),
}, {
  indexes: [
    { name: 'tasks_api_page', columns: ['organization_id', 'created_at', 'id'], descending: ['created_at', 'id'] },
    { name: 'tasks_api_project_page', columns: ['organization_id', 'project_key', 'created_at', 'id'], descending: ['created_at', 'id'] },
    { name: 'tasks_api_status_page', columns: ['organization_id', 'status', 'created_at', 'id'], descending: ['created_at', 'id'] },
  ],
})

const TASK_REFERENCE = { table: tasks, column: 'id', onDelete: 'cascade' } as const

// A task's sessions and its links to works, plans, pull requests, and
// automations are edges of `resource_links` (data/links/schema.ts); a task
// delete removes them explicitly (`deleteEdgesOf`), as no foreign key can.

export const taskExternalLinks = defineTable('task_external_links', {
  task_id: text({ primaryKey: true, references: TASK_REFERENCE }),
  provider: text({ notNull: true }),
  external_key: text({ notNull: true }),
  external_id: text({ notNull: true }),
  url: text({ notNull: true }),
  external_updated_at: text(),
  snapshot: json(),
  dirty_fields: json({ notNull: true, default: '[]' }),
  sync_state: text({ notNull: true, default: 'ok' }),
  sync_error: text(),
  last_synced_at: bigint(),
  retry_at: bigint(),
  failure_count: integer({ notNull: true, default: 0 }),
  organization_id: ORGANIZATION,
}, {
  indexes: [
    { name: 'task_external_links_external', columns: ['provider', 'external_key', 'external_id'], unique: true },
  ],
})

export const upstreamTaskCache = defineTable('upstream_task_cache', {
  project_key: text({ notNull: true }),
  provider: text({ notNull: true }),
  external_key: text({ notNull: true }),
  scope: text({ notNull: true }),
  fetched_at: bigint({ notNull: true }),
  truncated: integer(),
  tasks: json({ notNull: true }),
  organization_id: ORGANIZATION,
}, {
  primaryKey: ['project_key', 'provider', 'external_key', 'scope'],
})

export const assetPublications = defineTable('asset_publications', {
  asset_id: text({ notNull: true }),
  provider: text({ notNull: true }),
  target_key: text({ notNull: true }),
  remote_url: text({ notNull: true }),
  created_at: bigint({ notNull: true }),
  organization_id: ORGANIZATION,
}, {
  primaryKey: ['asset_id', 'provider', 'target_key'],
})

/**
 * The next `short_id`, handed out by one atomic upsert. `MAX(short_id) + 1`
 * read inside a transaction is not enough on Postgres: two creations in flight
 * read the same maximum. The row lock on this counter serializes them, and the
 * seed from `tasks` makes a file that already numbered its tasks carry on.
 */
export const taskCounters = defineTable('task_counters', {
  name: text({ primaryKey: true }),
  value: integer({ notNull: true }),
})

export const TASK_TABLES = [
  tasks,
  taskCounters,
  taskExternalLinks,
  upstreamTaskCache,
  assetPublications,
]
