import { bigint, defineTable, integer, json, text } from '../db/schema/define-table'

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
  parent_id: text({ references: { table: 'self', column: 'id', onDelete: 'cascade' } }),
  title: text({ notNull: true }),
  title_source: text({ notNull: true, default: 'prompt' }),
  body: text({ notNull: true, default: '' }),
  status: text({ notNull: true, default: 'inbox' }),
  kind: text({ notNull: true, default: 'task' }),
  assignee: text(),
  due_date: text(),
  priority: text(),
  labels: json({ notNull: true, default: '[]' }),
  pr: json(),
  source: text({ notNull: true, default: 'user' }),
  origin_session_id: text(),
  origin_automation_id: text(),
  created_at: bigint({ notNull: true }),
  updated_at: bigint({ notNull: true }),
  triaged_at: bigint(),
  done_at: bigint(),
  last_read_at: bigint(),
  organization_id: ORGANIZATION,
}, {
  indexes: [
    { name: 'tasks_by_project', columns: ['project_key', 'status', 'updated_at'], descending: ['updated_at'] },
    { name: 'tasks_by_status', columns: ['status', 'created_at'], descending: ['created_at'] },
    { name: 'tasks_parent', columns: ['parent_id'] },
  ],
})

const TASK_REFERENCE = { table: tasks, column: 'id', onDelete: 'cascade' } as const

export const taskSessionLinks = defineTable('task_session_links', {
  task_id: text({ notNull: true, references: TASK_REFERENCE }),
  session_id: text({ notNull: true }),
  role: text({ notNull: true, default: 'working' }),
  /** Legacy capture — populated by earlier versions, read-only today. */
  pr: json(),
  injected_at: bigint(),
  linked_at: bigint({ notNull: true }),
  organization_id: ORGANIZATION,
}, {
  primaryKey: ['task_id', 'session_id'],
  indexes: [{ name: 'task_session_links_by_session', columns: ['session_id'] }],
})

export const taskComments = defineTable('task_comments', {
  id: text({ primaryKey: true }),
  task_id: text({ notNull: true, references: TASK_REFERENCE }),
  author: text(),
  source: text({ notNull: true, default: 'local' }),
  external_id: text(),
  origin_session_id: text(),
  body: text({ notNull: true }),
  created_at: bigint({ notNull: true }),
  dirty: integer({ notNull: true, default: 0 }),
  organization_id: ORGANIZATION,
}, {
  indexes: [
    { name: 'task_comments_by_task', columns: ['task_id', 'created_at'] },
    { name: 'task_comments_external', columns: ['task_id', 'external_id'], unique: true, where: 'external_id IS NOT NULL' },
  ],
})

export const taskLinks = defineTable('task_links', {
  task_id: text({ notNull: true, references: TASK_REFERENCE }),
  kind: text({ notNull: true }),
  target_scope: text({ notNull: true, default: '' }),
  target_key: text({ notNull: true }),
  title: text({ notNull: true, default: '' }),
  url: text(),
  created_by: text({ notNull: true, default: 'user' }),
  origin_session_id: text(),
  linked_at: bigint({ notNull: true }),
  pinned: integer({ notNull: true, default: 0 }),
  organization_id: ORGANIZATION,
}, {
  primaryKey: ['task_id', 'kind', 'target_scope', 'target_key'],
  indexes: [
    { name: 'task_links_by_target', columns: ['kind', 'target_scope', 'target_key'] },
    { name: 'task_pr_links_by_url', columns: ['task_id', 'url'], unique: true, where: "kind = 'pr' AND url IS NOT NULL" },
  ],
})

export const taskEvents = defineTable('task_events', {
  id: text({ primaryKey: true }),
  task_id: text({ notNull: true, references: TASK_REFERENCE }),
  kind: text({ notNull: true }),
  actor: text({ notNull: true, default: 'user' }),
  actor_label: text(),
  from_value: text(),
  to_value: text(),
  target_kind: text(),
  target_scope: text(),
  target_key: text(),
  target_title: text(),
  created_at: bigint({ notNull: true }),
  organization_id: ORGANIZATION,
}, {
  indexes: [{ name: 'task_events_by_task', columns: ['task_id', 'created_at', 'id'] }],
})

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
  organization_id: ORGANIZATION,
})

export const TASK_TABLES = [
  tasks,
  taskCounters,
  taskSessionLinks,
  taskComments,
  taskLinks,
  taskEvents,
  taskExternalLinks,
  upstreamTaskCache,
  assetPublications,
]
