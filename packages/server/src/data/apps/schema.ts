import { bigint, boolean, defineTable, integer, json, text } from '../../db/schema/define-table'

/**
 * An app (docs/plans/apps.md §4.1): a record on a host with a repository and
 * versions. Its source and builds are in its git repository, its data is in
 * its own folder, and its secrets are in the host's secret store; none of
 * them is here.
 */
export const apps = defineTable('apps', {
  id: text({ primaryKey: true }),
  organization_id: text({ notNull: true, default: 'local' }),
  /** The user id of who made the app (plans/029 decision 2): its owner, who its schedules and webhooks run as. */
  created_by: text({ notNull: true }),
  /** Unique on the host: the namespace an agent's tools and a link use. */
  slug: text({ notNull: true }),
  name: text({ notNull: true }),
  description: text({ notNull: true, default: '' }),
  /** The version that runs; null until a deploy succeeds. */
  active_version: integer(),
  stopped: boolean({ notNull: true, default: false }),
  /** The app's operations are tools for agents. */
  agent_access: boolean({ notNull: true, default: true }),
  /** The name of the app's git repository in the host's repository folder. */
  repository: text({ notNull: true }),
  /** The newest revision: the commit `main` of the repository is at. */
  latest_revision: text(),
  /** The folder of the first save: the project a list groups the app under. */
  project: text(),
  /** `Attribution` JSON of who made it, for display. */
  author: json({ notNull: true }),
  /** The webhook record of each webhook the app declares: `{ [name]: webhookId }`. */
  webhook_ids: json({ notNull: true, default: '{}' }),
  created_at: bigint({ notNull: true }),
  updated_at: bigint({ notNull: true }),
}, {
  indexes: [
    { name: 'apps_by_slug', columns: ['slug'], unique: true },
    { name: 'apps_by_creator', columns: ['organization_id', 'created_by'] },
  ],
})

/** One immutable version (§4.1): the revision it was built from, its build commit, and what the build declares. */
export const appVersions = defineTable('app_versions', {
  app_id: text({ notNull: true, references: { table: apps, column: 'id', onDelete: 'cascade' } }),
  number: integer({ notNull: true }),
  source_commit: text({ notNull: true }),
  build_commit: text({ notNull: true }),
  descriptor: json({ notNull: true }),
  has_backend: boolean({ notNull: true }),
  has_ui: boolean({ notNull: true }),
  /** `building`, `active`, `superseded`, or `failed`. */
  state: text({ notNull: true }),
  error: text(),
  /** The end of the text of the host's build. */
  build_log: text(),
  build_ms: integer(),
  message: text({ notNull: true, default: '' }),
  author: json({ notNull: true }),
  created_at: bigint({ notNull: true }),
}, {
  primaryKey: ['app_id', 'number'],
})

/** The state of one schedule the active version declares (§8). The declaration itself is in the descriptor. */
export const appSchedules = defineTable('app_schedules', {
  app_id: text({ notNull: true, references: { table: apps, column: 'id', onDelete: 'cascade' } }),
  name: text({ notNull: true }),
  enabled: boolean({ notNull: true, default: true }),
  next_run_at: bigint(),
  last_run_at: bigint(),
  last_outcome: text(),
  last_error: text(),
}, {
  primaryKey: ['app_id', 'name'],
  indexes: [
    { name: 'app_schedules_due', columns: ['next_run_at'] },
  ],
})

/** The call log (§4.1, decision 21): which operation ran, for which caller, how it ended, and what the host kept of it. Never a result or a secret. */
export const appCalls = defineTable('app_calls', {
  id: text({ primaryKey: true }),
  app_id: text({ notNull: true, references: { table: apps, column: 'id', onDelete: 'cascade' } }),
  version: integer({ notNull: true }),
  operation: text({ notNull: true }),
  caller: json({ notNull: true }),
  /** The caller's kind, for the filter of the call log. */
  caller_kind: text({ notNull: true, default: 'ui' }),
  started_at: bigint({ notNull: true }),
  finished_at: bigint(),
  /** `running`, `ok`, or `failed`. */
  outcome: text({ notNull: true }),
  error: text(),
  error_stack: text(),
  /** The start of the input as JSON text. */
  input: text(),
  input_truncated: boolean({ notNull: true, default: false }),
  result_bytes: integer(),
  /** `AppLogLine[]`. */
  logs: json({ notNull: true, default: '[]' }),
  logs_truncated: boolean({ notNull: true, default: false }),
  /** `AppSpan[]`. */
  spans: json({ notNull: true, default: '[]' }),
  /** The workflow run a step's call belongs to. */
  run_id: text(),
  /** The call's OpenTelemetry span: its W3C trace id and span id. */
  trace_id: text(),
  span_id: text(),
}, {
  indexes: [
    { name: 'app_calls_by_app', columns: ['app_id', 'started_at', 'id'] },
    { name: 'app_calls_by_run', columns: ['run_id'] },
  ],
})

/** One app file (§4.3): the record of a file whose bytes are in the app's `blobs/` folder. */
export const appFiles = defineTable('app_files', {
  id: text({ primaryKey: true }),
  app_id: text({ notNull: true, references: { table: apps, column: 'id', onDelete: 'cascade' } }),
  name: text({ notNull: true }),
  media_type: text({ notNull: true }),
  size: bigint({ notNull: true }),
  /** The kind of the caller that made it: a person in a UI, or the backend for one of its callers. Not a person: the app carries the creator. */
  caller_kind: text({ notNull: true }),
  created_at: bigint({ notNull: true }),
}, {
  indexes: [
    { name: 'app_files_by_app', columns: ['app_id', 'created_at', 'id'] },
  ],
})

/** One run of a workflow (§8.3). */
export const appWorkflowRuns = defineTable('app_workflow_runs', {
  id: text({ primaryKey: true }),
  app_id: text({ notNull: true, references: { table: apps, column: 'id', onDelete: 'cascade' } }),
  workflow: text({ notNull: true }),
  input: json({ notNull: true }),
  /** `running`, `sleeping`, `succeeded`, `failed`, or `terminated`. */
  state: text({ notNull: true }),
  /** A second start with the same key gives this run. */
  start_key: text(),
  result: json(),
  error: text(),
  /** When a sleeping run starts again. */
  wake_at: bigint(),
  /** `AppCaller` JSON of what started the run. */
  started_by: json({ notNull: true }),
  /** How many times in a row the runner stopped while the run was in progress. */
  interruptions: integer({ notNull: true, default: 0 }),
  started_at: bigint({ notNull: true }),
  updated_at: bigint({ notNull: true }),
  finished_at: bigint(),
}, {
  indexes: [
    { name: 'app_workflow_runs_by_app', columns: ['app_id', 'started_at', 'id'] },
    { name: 'app_workflow_runs_by_key', columns: ['app_id', 'workflow', 'start_key'] },
    { name: 'app_workflow_runs_by_state', columns: ['state', 'wake_at'] },
  ],
})

/** The receipt of one step of a run (§8.3): a run that starts again answers a finished step from it. */
export const appWorkflowSteps = defineTable('app_workflow_steps', {
  run_id: text({ notNull: true, references: { table: appWorkflowRuns, column: 'id', onDelete: 'cascade' } }),
  name: text({ notNull: true }),
  /** `do`, `sleep`, `query`, or `mutation`. */
  kind: text({ notNull: true }),
  /** `running`, `done`, `failed`, or `sleeping`. */
  state: text({ notNull: true }),
  attempts: integer({ notNull: true, default: 0 }),
  result: json(),
  error: text(),
  wake_at: bigint(),
  started_at: bigint({ notNull: true }),
  finished_at: bigint(),
}, {
  primaryKey: ['run_id', 'name'],
})

/** One occurrence of a signal (§8.4), with how each signal action ended. */
export const appSignals = defineTable('app_signals', {
  id: text({ primaryKey: true }),
  app_id: text({ notNull: true, references: { table: apps, column: 'id', onDelete: 'cascade' } }),
  name: text({ notNull: true }),
  payload: json({ notNull: true }),
  emitted_at: bigint({ notNull: true }),
  call_id: text(),
  run_id: text(),
  /** `AppSignalDelivery[]`. */
  deliveries: json({ notNull: true, default: '[]' }),
}, {
  indexes: [
    { name: 'app_signals_by_app', columns: ['app_id', 'emitted_at', 'id'] },
  ],
})

/** One signal action (§8.4): what the owner made a signal do. */
export const appSignalActions = defineTable('app_signal_actions', {
  id: text({ primaryKey: true }),
  app_id: text({ notNull: true, references: { table: apps, column: 'id', onDelete: 'cascade' } }),
  signal: text({ notNull: true }),
  /** `AppSignalAction` JSON. */
  action: json({ notNull: true }),
  enabled: boolean({ notNull: true, default: true }),
  created_at: bigint({ notNull: true }),
}, {
  indexes: [
    { name: 'app_signal_actions_by_app', columns: ['app_id', 'signal'] },
  ],
})

export const APP_TABLES = [apps, appVersions, appSchedules, appCalls, appFiles, appWorkflowRuns, appWorkflowSteps, appSignals, appSignalActions]
