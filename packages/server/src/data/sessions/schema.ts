import { bigint, defineTable, integer, text } from '../../db/schema/define-table'

/**
 * The collaboration plane's session records
 * (docs/plans/cloud-service-model.md): one row per session, the facts every
 * client lists by. The transcript index (`sessions`, `session_messages`,
 * `session_fts`, `session_files`) stays runner-local in the host's file.
 */
export const sessionRecords = defineTable('session_records', {
  session_id: text({ primaryKey: true }),
  organization_id: text({ notNull: true, default: 'local' }),
  /** `local` or `published` (organization-scope §3): whether the transcript is available from the Solus API. */
  publication: text({ notNull: true, default: 'local' }),
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
  /** Where the session runs on its runner, so a client can resume it from the record alone. */
  cwd: text(),
  /** The provider's own name for the session; `title` falls back to it. */
  slug: text(),
  is_worktree: integer({ notNull: true, default: 0 }),
  branch: text(),
  project_root: text(),
  delegation_message_id: text(),
  delegation_depth: integer(),
  delegation_intent: text(),
  delegation_created_at: bigint(),
}, {
  indexes: [
    { name: 'sessions_api_page', columns: ['organization_id', 'created_at', 'session_id'], descending: ['created_at', 'session_id'] },
    { name: 'sessions_api_provider_page', columns: ['organization_id', 'provider', 'created_at', 'session_id'], descending: ['created_at', 'session_id'] },
  ],
})

/**
 * The Solus API's durable acceptance of a new organization session, before its
 * provider started (organization-vms §3). One row per run, keyed by the Solus
 * session id the execution host admitted it under; the owner is the person whose
 * run authority asked. The host's first report of the session record names this
 * admission, and the record's owner comes from here, never from the report.
 */
export const sessionAdmissions = defineTable('session_admissions', {
  organization_id: text({ notNull: true }),
  admission_id: text({ notNull: true }),
  host_id: text({ notNull: true }),
  owner_user_id: text({ notNull: true }),
  created_at: bigint({ notNull: true }),
}, { primaryKey: ['organization_id', 'admission_id'] })

/**
 * The pull requests a session works on (docs/plans/session-pull-requests.md).
 * A session owns its links; a task reads the links of its sessions. One pull
 * request can belong to several sessions, and a session to several pull
 * requests. `session_id` is the stable Solus session id.
 */
export const sessionPullRequests = defineTable('session_pull_requests', {
  session_id: text({ notNull: true }),
  /** `host/owner/repo`, lower case: the pull request's repository. */
  repository: text({ notNull: true }),
  number: integer({ notNull: true }),
  url: text({ notNull: true }),
  title: text({ notNull: true, default: '' }),
  /** Who made the link: `branch`, `created`, `agent`, `manual`, or the
   *  `dismissed` tombstone of a link a person removed. */
  source: text({ notNull: true }),
  /** Who made the link, as a stored attribution. */
  created_by: text({ notNull: true }),
  linked_at: bigint({ notNull: true }),
  // The last observation, written by PR sync so a row draws its pull request
  // without the network. `pr_state` is open, closed, merged, or missing; null
  // until PR sync first answers.
  pr_state: text(),
  pr_draft: integer(),
  pr_updated_at: text(),
  organization_id: text({ notNull: true, default: 'local' }),
}, {
  primaryKey: ['session_id', 'repository', 'number'],
  indexes: [{ name: 'session_pull_requests_by_pull_request', columns: ['repository', 'number'] }],
})

/**
 * Where a session is in a person's list (docs/plans/session-pull-requests.md):
 * settled when its work is finished, snoozed until a wake time. The host holds
 * this so every client shows the same list, and so PR sync knows which
 * sessions are live work. A session with no row is active. `session_id` is
 * the stable Solus session id.
 */
export const sessionStates = defineTable('session_states', {
  session_id: text({ primaryKey: true }),
  /** When the session became settled. Null while it is active. */
  settled_at: bigint(),
  /** What settled it: `person`, `pull-request`, `task`, or `idle`. */
  settled_by: text(),
  /** When a person made a settled session active again. Its pull requests
   *  settle it again only if they end after this time. */
  unsettled_at: bigint(),
  snoozed_until: bigint(),
  snooze_note: text(),
  /** The last prompt the session received. */
  last_prompt_at: bigint(),
  organization_id: text({ notNull: true, default: 'local' }),
}, {
  indexes: [{ name: 'session_states_settled', columns: ['settled_at'] }],
})

export const SESSION_TABLES = [sessionRecords, sessionAdmissions, sessionPullRequests, sessionStates]
