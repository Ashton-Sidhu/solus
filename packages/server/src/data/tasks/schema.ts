import { bigint, defineTable, integer, json, text } from '../../db/schema/define-table'

/**
 * The tasks domain's tables, declared once for both engines
 * (docs/plans/provider-owned-tasks.md §4.4). GitHub and Jira own every task:
 * these tables are the host's copy (the task cache) and the read state of each
 * task source. A task has no organization and no owner in Solus; the
 * attachments of a task (`resource_links`, `personal_resource_state`,
 * `activity`) have an organization and key on the task key.
 */

const ORGANIZATION = text({ notNull: true, default: 'local' })

/** The host's copy of a task. The provider is the truth; the next read replaces the row. */
export const tasks = defineTable('tasks', {
  /** The task key (`taskKey`): `github:<nodeId>` or `jira:<cloudId>:<issueId>`. */
  id: text({ primaryKey: true }),
  provider: text({ notNull: true }),
  /** `issue`, or `draft` for a GitHub Project item that is not an issue. */
  kind: text({ notNull: true }),
  /** `owner/repo#123` or `PROJ-12`. Null on a draft. */
  reference: text(),
  url: text(),
  title: text({ notNull: true }),
  body: text({ notNull: true, default: '' }),
  /** The provider's own state, in the provider's words, and its status category. */
  state_name: text({ notNull: true }),
  state_category: text({ notNull: true }),
  /** The Jira status id of the state. Null on GitHub. */
  state_id: text(),
  /** `Task.category`: from the state and the columns of the task (`taskCategory`). */
  category: text({ notNull: true }),
  assignee: text(),
  assignee_avatar_url: text(),
  labels: json({ notNull: true, default: '[]' }),
  priority: text(),
  due_date: text(),
  /** The epic snapshot (`TaskEpic`) of the last read. */
  epic: json(),
  /** The `TaskField`s the provider takes a change of for this task. */
  writable_fields: json({ notNull: true, default: '[]' }),
  /** `TaskHome` JSON: what the adapter needs to write (repository and issue number, Jira key). */
  home: json({ notNull: true }),
  /** Provider times, in epoch ms. */
  created_at: bigint(),
  updated_at: bigint({ notNull: true }),
  /** When the host last wrote this copy from a provider answer. */
  fetched_at: bigint({ notNull: true }),
  /** When the host last read the task with its comments. Null = never. */
  detail_fetched_at: bigint(),
  last_read_at: bigint(),
  /** The position the task's next comment thread takes (`comment_threads.position`), advanced in the inserting transaction. */
  comment_position: integer({ notNull: true, default: 0 }),
})

/** One task source, shared by each person who reads it. */
export const taskSources = defineTable('task_sources', {
  source_key: text({ primaryKey: true }),
  /** `TaskSource` JSON. */
  source: json({ notNull: true }),
  label: text({ notNull: true }),
  /** `TaskColumn[]` JSON, in the provider's order. */
  columns: json({ notNull: true, default: '[]' }),
  /** `SourceWriteState` JSON: what the adapter needs to write to the source. */
  write_state: json(),
  /** When a provider last answered a read. Null = never read. */
  fetched_at: bigint(),
  truncated: integer({ notNull: true, default: 0 }),
})

/** Where a source puts each of its tasks. A read of the source replaces its rows. */
export const taskSourceItems = defineTable('task_source_items', {
  source_key: text({ notNull: true }),
  task_id: text({ notNull: true }),
  /** A `TaskColumn.id` of the source. Null for a board item with no column. */
  column_id: text(),
  /** The board item, for a write to a GitHub Project. */
  item_id: text(),
  /** The order the provider gave the tasks in. */
  position: integer({ notNull: true, default: 0 }),
}, {
  primaryKey: ['source_key', 'task_id'],
  indexes: [
    { name: 'task_source_items_task', columns: ['task_id'] },
  ],
})

/**
 * One person's connection to one source. The cache is shared on a host, so a
 * person sees the tasks of a source only after their own connection read it
 * (`checked_at`). `health` is the result of that person's last read: it is
 * about their connection, not about the source.
 */
export const taskSourceAccess = defineTable('task_source_access', {
  /** The person whose connection this is: their user key. */
  user_id: text({ notNull: true }),
  source_key: text({ notNull: true }),
  /** When this person's own connection last read the source. Null = never. */
  checked_at: bigint(),
  /** `TaskSourceHealth` of this person's last read. */
  health: text({ notNull: true, default: 'ok' }),
  message: text(),
}, {
  primaryKey: ['user_id', 'source_key'],
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

export const TASK_TABLES = [
  tasks,
  taskSources,
  taskSourceItems,
  taskSourceAccess,
  assetPublications,
]
