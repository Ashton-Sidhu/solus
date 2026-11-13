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
  /** The name of the app's git repository in the host's repository folder. */
  repository: text({ notNull: true }),
  /** The folder of the first deploy: the project a list groups the app under. */
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

/** One immutable version (§4.1): a source commit, its build commit, and what the build declares. */
export const appVersions = defineTable('app_versions', {
  app_id: text({ notNull: true, references: { table: apps, column: 'id', onDelete: 'cascade' } }),
  number: integer({ notNull: true }),
  source_commit: text({ notNull: true }),
  build_commit: text({ notNull: true }),
  descriptor: json({ notNull: true }),
  has_backend: boolean({ notNull: true }),
  has_ui: boolean({ notNull: true }),
  /** `active`, `superseded`, or `failed`. */
  state: text({ notNull: true }),
  error: text(),
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

/** The call log (§4.1): which operation ran, for which caller, and how it ended. Never an input or a result. */
export const appCalls = defineTable('app_calls', {
  id: text({ primaryKey: true }),
  app_id: text({ notNull: true, references: { table: apps, column: 'id', onDelete: 'cascade' } }),
  version: integer({ notNull: true }),
  operation: text({ notNull: true }),
  caller: json({ notNull: true }),
  started_at: bigint({ notNull: true }),
  finished_at: bigint(),
  /** `running`, `ok`, or `failed`. */
  outcome: text({ notNull: true }),
  error: text(),
}, {
  indexes: [
    { name: 'app_calls_by_app', columns: ['app_id', 'started_at', 'id'] },
  ],
})

export const APP_TABLES = [apps, appVersions, appSchedules, appCalls]
