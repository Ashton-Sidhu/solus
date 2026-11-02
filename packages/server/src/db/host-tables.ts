import { bigint, defineTable, integer, json, text } from './schema/define-table'

/**
 * The host's own tables (docs/database-schema.md): the transcript index, the
 * execution ledger, the delivery queues, and host-local settings. They live in
 * `solus.db` on every machine whatever its records engine, and are read
 * synchronously through `getDb()`. Declared here once; drizzle-kit generates
 * their baseline into `packages/server/drizzle/sqlite` through `./schema/host.ts`.
 * `session_fts`, an FTS5 virtual table, is hand-written in
 * `./schema/custom/host.sql` and appended to that baseline.
 */

// --- Transcript index -------------------------------------------------------

/**
 * One row per provider thread this host has indexed from its own disk: the
 * indexer's state (file facts, timestamp, size) and the per-thread facts the
 * host's synchronous readers need (`getIndexedSession`, the transcript search,
 * the task and PR readers). The session's own facts live on the ported
 * `session` row (plans/029 §4.1); `custom_title` and `branch` are copies the
 * synchronous readers project from. Keyed by the provider thread id: one
 * session has several rows after a handoff.
 */
export const transcriptIndex = defineTable('transcript_index', {
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
  place: text(),
}, {
  indexes: [
    // `listProjectRoots` and the search's project scope.
    { name: 'transcript_index_by_project_root', columns: ['project_root', 'last_timestamp'], descending: ['last_timestamp'] },
    // The PR-sync tick (`recentBranchSessions`): recent threads on a branch.
    { name: 'transcript_index_recent_branches', columns: ['last_timestamp'], where: "branch IS NOT NULL AND branch <> ''" },
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
  /** When a settled question may be pruned; null while it is open (plan 029 §7). */
  retained_until: bigint(),
}, {
  indexes: [
    { name: 'async_questions_by_session', columns: ['session_id', 'state', 'created_at'] },
    { name: 'async_questions_by_agent', columns: ['agent_session_id', 'state', 'created_at'] },
    { name: 'async_questions_retained', columns: ['retained_until'], where: 'retained_until IS NOT NULL' },
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
}, {
  indexes: [
    { name: 'outbox_ops_by_resource', columns: ['domain', 'resource_id', 'id'] },
  ],
})

export const deliveryQueue = defineTable('delivery_queue', {
  seq: integer({ primaryKey: true }),
  kind: text({ notNull: true }),
  key: text({ notNull: true }),
  payload: json({ notNull: true }),
  organization_id: text({ notNull: true }),
  /** The person whose delegated token delivers the row; '' is the person who linked the host. */
  user_id: text({ notNull: true, default: '' }),
  error: text(),
}, {
  indexes: [
    { name: 'delivery_queue_by_destination', columns: ['organization_id', 'user_id', 'seq'] },
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

/**
 * The one folder name a member's things on this host live under
 * (`host/member-folders.ts`): fixed the first time it is known and kept
 * through a rename.
 */
export const memberFolder = defineTable('member_folder', {
  user_id: text({ primaryKey: true }),
  folder: text({ notNull: true, unique: true }),
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
  /** The user id of who made the automation (plans/029 decision 2): also its owner. */
  created_by: text({ notNull: true }),
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

/** A person's named browser identity in a project; `created_by` is the person whose jar it is (member-isolation.md §6). */
export const browserProfiles = defineTable('browser_profiles', {
  created_by: text({ notNull: true }),
  project_root: text({ notNull: true }),
  profile_id: text({ notNull: true }),
  name: text({ notNull: true }),
  created_at: bigint({ notNull: true }),
  /** The one profile new pages in this person's project open as; none flagged means the built-in profile (plan 023). */
  is_default: integer({ notNull: true, default: 0 }),
}, {
  primaryKey: ['created_by', 'project_root', 'profile_id'],
  indexes: [
    { name: 'browser_profiles_default', columns: ['created_by', 'project_root'], unique: true, where: 'is_default = 1' },
  ],
})

export const integration = defineTable('integration', {
  id: text({ primaryKey: true }),
  organization_id: text({ notNull: true }),
  /** The user id of who made the record (plans/029 decision 2): the one person who reads and changes it. */
  created_by: text({ notNull: true }),
  kind: text({ notNull: true }),
  slug: text({ notNull: true }),
  name: text({ notNull: true }),
  url: text({ notNull: true }),
  auth: json({ notNull: true }),
  disabled_tools: json({ notNull: true, default: '[]' }),
  created_at: text({ notNull: true }),
  updated_at: text({ notNull: true }),
}, {
  indexes: [{ name: 'integration_slug', columns: ['organization_id', 'created_by', 'slug'], unique: true }],
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
  /** The person whose pending reviews and assignments the row remembers. */
  user_id: text({ notNull: true }),
  pending: json({ notNull: true }),
  observed_at: bigint({ notNull: true }),
}, { primaryKey: ['authority', 'repo', 'user_id'] })

// A saved query and a turn flag are a person's judgement (plans/029 P8): each
// carries the user key of the person who made it, `created_by` (`ownerKeyOf`,
// the key `automations.owner_key` holds), and a list read is theirs alone.
export const savedMetricsQueries = defineTable('saved_metrics_queries', {
  id: text({ primaryKey: true }),
  created_by: text({ notNull: true }),
  name: text({ notNull: true }),
  form: text({ notNull: true }),
  spec: json(),
  sql: text(),
  created_at: bigint({ notNull: true }),
  updated_at: bigint({ notNull: true }),
}, {
  indexes: [{ name: 'saved_metrics_queries_by_creator', columns: ['created_by', 'updated_at'], descending: ['updated_at'] }],
})

export const turnFlags = defineTable('turn_flags', {
  created_by: text({ notNull: true }),
  trace_id: text({ notNull: true }),
  kind: text({ notNull: true }),
  note: text({ notNull: true, default: '' }),
  created_at: bigint({ notNull: true }),
  updated_at: bigint({ notNull: true }),
}, { primaryKey: ['created_by', 'trace_id'] })

/** Every host table, in declaration order. */
export const HOST_TABLES = [
  transcriptIndex, sessionMessages, sessionFiles, sessionKeys, sessionLineageMembers, sessionThreadAliases, pinnedSessions,
  runs, runQueue, runExchanges, asyncQuestions,
  outboxOps, deliveryQueue, transcriptMirrorRows, activityMirrorRows,
  kv, projects, memberFolder, automations, automationRuns, browserProfiles,
  integration, integrationConnection, notificationPrObservations, savedMetricsQueries, turnFlags,
] as const
