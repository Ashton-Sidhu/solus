import { bigint, defineTable, integer, json, text } from './schema/define-table'

/**
 * The host's own tables (docs/database-schema.md): the transcript index, the
 * execution ledger, the delivery queues, and host-local settings. They live in
 * `solus.db` on every machine whatever its records engine, and are read
 * synchronously through `getDb()`. Declared here once; drizzle-kit generates
 * their baseline into `packages/server/drizzle/host` from `./schema/host.ts`.
 * `session_fts`, an FTS5 virtual table, is hand-written in
 * `./schema/custom/host.sql` and appended to that baseline.
 */

// --- Transcript index -------------------------------------------------------

/** One row per provider thread this host has indexed from its own disk. */
export const sessions = defineTable('sessions', {
  session_id: text({ primaryKey: true }),
  provider: text({ notNull: true }),
  cwd: text(),
  project_path: text(),
  project_root: text(),
  is_worktree: integer(),
  slug: text(),
  first_message: text(),
  custom_title: text(),
  last_timestamp: bigint(),
  size: integer(),
  model: text(),
  reasoning_effort: text(),
  branch: text(),
  server_id: text(),
  parent_session_id: text(),
  root_session_id: text(),
  delegation_exchange_id: text(),
  delegation_depth: integer(),
  delegation_intent: text(),
  delegation_created_at: bigint(),
  started_by: json(),
  place: text(),
}, {
  indexes: [
    { name: 'sessions_by_parent', columns: ['parent_session_id', 'last_timestamp'], descending: ['last_timestamp'] },
    { name: 'sessions_by_project_root', columns: ['project_root', 'last_timestamp'], descending: ['last_timestamp'] },
    { name: 'sessions_worktree_recent', columns: ['last_timestamp'], where: 'is_worktree = 1' },
  ],
})

/** The indexed messages of a thread; `id` is the FTS rowid. */
export const sessionMessages = defineTable('session_messages', {
  id: integer({ primaryKey: true }),
  session_id: text({ notNull: true }),
  uuid: text(),
  role: text(),
  ts: bigint(),
  text: text(),
}, {
  indexes: [{ name: 'session_messages_by_session', columns: ['session_id'] }],
})

/** How far the indexer has read each transcript file. */
export const sessionFiles = defineTable('session_files', {
  path: text({ primaryKey: true }),
  provider: text(),
  last_offset: bigint({ default: 0 }),
})

/** A short number for each session, for the keyboard. */
export const sessionKeys = defineTable('session_keys', {
  number: integer({ primaryKey: true }),
  session_id: text({ notNull: true, unique: true }),
})

/** The provider threads a Solus session has run as, in order (handoffs). */
export const sessionLineageMembers = defineTable('session_lineage_members', {
  session_id: text({ notNull: true }),
  position: integer({ notNull: true }),
  provider: text({ notNull: true }),
  provider_session_id: text(),
  cwd: text({ notNull: true }),
  started_at: bigint({ notNull: true }),
  ended_at: bigint(),
  updated_at: bigint({ notNull: true }),
}, {
  primaryKey: ['session_id', 'position'],
  indexes: [
    { name: 'session_lineage_member_provider_session', columns: ['provider_session_id', 'provider'], unique: true, where: 'provider_session_id IS NOT NULL' },
  ],
})

/** A provider thread id that names a Solus session. */
export const sessionThreadAliases = defineTable('session_thread_aliases', {
  provider: text({ notNull: true }),
  provider_session_id: text({ notNull: true }),
  session_id: text({ notNull: true }),
}, { primaryKey: ['provider_session_id', 'provider'] })

/** A session a person pinned on this host. */
export const pinnedSessions = defineTable('pinned_sessions', {
  session_id: text({ notNull: true }),
  server_id: text({ notNull: true, default: '' }),
  provider: text(),
  title: text(),
  cwd: text(),
  pinned_at: bigint(),
}, { primaryKey: ['session_id', 'server_id'] })

// --- Execution ledger -------------------------------------------------------

export const runs = defineTable('runs', {
  session_id: text({ primaryKey: true }),
  run_id: text({ notNull: true }),
  state: text({ notNull: true }),
  payload: json({ notNull: true }),
  updated_at: bigint({ notNull: true }),
})

export const runQueue = defineTable('run_queue', {
  queue_id: text({ primaryKey: true }),
  session_id: text({ notNull: true }),
  position: integer({ notNull: true }),
  payload: json({ notNull: true }),
  updated_at: bigint({ notNull: true }),
}, {
  indexes: [{ name: 'run_queue_by_session', columns: ['session_id', 'position'] }],
})

export const runExchanges = defineTable('run_exchanges', {
  exchange_id: text({ primaryKey: true }),
  sender_session_id: text({ notNull: true }),
  target_session_id: text({ notNull: true }),
  run_id: text(),
  state: text({ notNull: true }),
  delivery_state: text(),
  delivery_queue_id: text(),
  payload: json({ notNull: true }),
  report: json(),
  reply: json(),
  settled_at: bigint(),
  updated_at: bigint({ notNull: true }),
})

export const asyncQuestions = defineTable('async_questions', {
  question_id: text({ primaryKey: true }),
  session_id: text({ notNull: true }),
  agent_session_id: text({ notNull: true }),
  questions_json: json({ notNull: true }),
  answers_json: json(),
  state: text({ notNull: true, default: 'pending' }),
  created_at: bigint({ notNull: true }),
}, {
  indexes: [
    { name: 'async_questions_by_session', columns: ['session_id', 'state', 'created_at'] },
    { name: 'async_questions_by_agent', columns: ['agent_session_id', 'state', 'created_at'] },
  ],
})

// --- Sync: outbox, delivery, mirrors ---------------------------------------

export const outboxOps = defineTable('outbox_ops', {
  id: text({ primaryKey: true }),
  domain: text({ notNull: true }),
  resource_id: text({ notNull: true }),
  name: text({ notNull: true }),
  payload: json({ notNull: true }),
  session_id: text(),
  recorded_at: bigint({ notNull: true }),
  state: text({ notNull: true, default: 'pending' }),
  error: text(),
  publication_id: text(),
}, {
  indexes: [
    { name: 'outbox_ops_by_resource', columns: ['domain', 'resource_id', 'id'] },
    { name: 'outbox_ops_by_publication', columns: ['publication_id', 'state'] },
  ],
})

export const deliveryQueue = defineTable('delivery_queue', {
  seq: integer({ primaryKey: true }),
  kind: text({ notNull: true }),
  key: text({ notNull: true }),
  payload: json({ notNull: true }),
  organization_id: text({ notNull: true }),
  actor_user_id: text({ notNull: true, default: '' }),
  error: text(),
}, {
  indexes: [
    { name: 'delivery_queue_by_destination', columns: ['organization_id', 'actor_user_id', 'seq'] },
    { name: 'delivery_queue_by_key', columns: ['kind', 'key'] },
  ],
})

export const transcriptMirrorRows = defineTable('transcript_mirror_rows', {
  session_id: text({ notNull: true }),
  position: integer({ notNull: true }),
  hash: text({ notNull: true }),
}, { primaryKey: ['session_id', 'position'] })

export const activityMirrorRows = defineTable('activity_mirror_rows', {
  session_id: text({ notNull: true }),
  activity_id: text({ notNull: true }),
}, { primaryKey: ['session_id', 'activity_id'] })

// --- Host settings and local state -----------------------------------------

export const kv = defineTable('kv', {
  key: text({ primaryKey: true }),
  value: text(),
})

export const projects = defineTable('projects', {
  key: text({ primaryKey: true }),
  path: text(),
  folder_name: text(),
  added_at: bigint(),
  last_used_at: bigint(),
})

export const recentProjects = defineTable('recent_projects', {
  path: text({ primaryKey: true }),
  folder_name: text(),
  last_opened: bigint(),
})

export const savedPrompts = defineTable('saved_prompts', {
  id: text({ primaryKey: true }),
  project_root: text({ notNull: true }),
  text: text({ notNull: true }),
  attachments: json({ notNull: true, default: '[]' }),
  created_at: bigint({ notNull: true }),
}, {
  indexes: [{ name: 'saved_prompts_by_project', columns: ['project_root', 'created_at'], descending: ['created_at'] }],
})

export const automations = defineTable('automations', {
  id: text({ primaryKey: true }),
  name: text(),
  enabled: integer(),
  favorite: integer(),
  action: json(),
  trigger_config: json(),
  next_run_at: bigint(),
  last_run: json(),
  created_at: bigint(),
  updated_at: bigint(),
  organization_id: text({ notNull: true, default: 'local' }),
  owner_key: text({ notNull: true, default: '' }),
})

export const automationRuns = defineTable('automation_runs', {
  id: text({ primaryKey: true }),
  automation_id: text({ notNull: true, references: { table: automations, column: 'id', onDelete: 'cascade' } }),
  started_at: bigint(),
  finished_at: bigint(),
  status: text(),
  output: text(),
  data: json(),
}, {
  indexes: [{ name: 'runs_by_automation', columns: ['automation_id', 'started_at'], descending: ['started_at'] }],
})

export const browserProfiles = defineTable('browser_profiles', {
  owner_key: text({ notNull: true }),
  project_root: text({ notNull: true }),
  profile_id: text({ notNull: true }),
  name: text({ notNull: true }),
  created_at: bigint({ notNull: true }),
}, { primaryKey: ['owner_key', 'project_root', 'profile_id'] })

export const browserProfileDefaults = defineTable('browser_profile_defaults', {
  owner_key: text({ notNull: true }),
  project_root: text({ notNull: true }),
  profile_id: text({ notNull: true }),
}, { primaryKey: ['owner_key', 'project_root'] })

export const integration = defineTable('integration', {
  id: text({ primaryKey: true }),
  organization_id: text({ notNull: true }),
  owner_key: text({ notNull: true }),
  kind: text({ notNull: true }),
  slug: text({ notNull: true }),
  name: text({ notNull: true }),
  url: text({ notNull: true }),
  auth: json({ notNull: true }),
  disabled_tools: json({ notNull: true, default: '[]' }),
  created_by: text(),
  created_at: text({ notNull: true }),
  updated_at: text({ notNull: true }),
}, {
  indexes: [{ name: 'integration_slug', columns: ['organization_id', 'owner_key', 'slug'], unique: true }],
})

export const integrationConnection = defineTable('integration_connection', {
  integration_id: text({ notNull: true }),
  user_id: text(),
  account_id: text({ notNull: true, default: 'default' }),
  status: text({ notNull: true }),
  source: text({ notNull: true, default: 'host' }),
  label: text(),
  info: json(),
  error: text(),
  updated_at: text({ notNull: true }),
}, { primaryKey: ['integration_id', 'user_id', 'account_id'] })

export const notificationPrObservations = defineTable('notification_pr_observations', {
  authority: text({ notNull: true }),
  repo: text({ notNull: true }),
  recipient_key: text({ notNull: true }),
  pending: json({ notNull: true }),
  observed_at: bigint({ notNull: true }),
}, { primaryKey: ['authority', 'repo', 'recipient_key'] })

export const savedMetricsQueries = defineTable('saved_metrics_queries', {
  id: text({ primaryKey: true }),
  name: text({ notNull: true }),
  form: text({ notNull: true }),
  spec: json(),
  sql: text(),
  created_at: bigint({ notNull: true }),
  updated_at: bigint({ notNull: true }),
})

export const turnFlags = defineTable('turn_flags', {
  trace_id: text({ primaryKey: true }),
  kind: text({ notNull: true }),
  note: text({ notNull: true, default: '' }),
  created_at: bigint({ notNull: true }),
  updated_at: bigint({ notNull: true }),
})

/** Every host table, in declaration order. */
export const HOST_TABLES = [
  sessions, sessionMessages, sessionFiles, sessionKeys, sessionLineageMembers, sessionThreadAliases, pinnedSessions,
  runs, runQueue, runExchanges, asyncQuestions,
  outboxOps, deliveryQueue, transcriptMirrorRows, activityMirrorRows,
  kv, projects, recentProjects, savedPrompts, automations, automationRuns, browserProfiles, browserProfileDefaults,
  integration, integrationConnection, notificationPrObservations, savedMetricsQueries, turnFlags,
] as const
