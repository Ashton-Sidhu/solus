import { bigint, defineTable, integer, json, text } from '../../db/schema/define-table'

/**
 * One row per session (plans/029-fresh-database-baseline.md §4.2): the
 * collaboration record, its shared shelf state, the lead mark, and the Solus
 * API's admission, which were four tables. The row is the session's birth: an
 * admission or a claim makes it before the provider starts, and `started_at`
 * stays null until the first report of provider facts. List readers add
 * `started_at IS NOT NULL`. The transcript index (`transcript_index`,
 * `session_messages`, `session_fts`, `session_files`) stays runner-local in
 * the host's file, keyed by provider thread.
 *
 * `defineTable` has no CHECK; the typed write commands keep the two invariants:
 * `started_at IS NULL OR (provider IS NOT NULL AND project_path IS NOT NULL)`
 * and `(settled_at IS NULL) = (settled_by IS NULL)`.
 */
export const session = defineTable('session', {
  session_id: text({ primaryKey: true }),
  /** `local` while unassigned, else an organization id assigned once (organization-scope §3, R10). */
  organization_id: text({ notNull: true, default: 'local' }),
  /** The person who started the session, and so its owner (docs/plans/access-model.md §2.2); never changed. */
  created_by: text({ notNull: true }),
  /** `local` or `published` (organization-scope §3): whether the transcript is available from the Solus API. */
  publication: text({ notNull: true, default: 'local' }),
  /** The Solus API's acceptance before the provider started (organization-vms §3): the host it admitted the run for, and when. Null on a personal machine. */
  admitted_host_id: text(),
  admitted_at: bigint(),
  /** The first report of provider facts; null for a row only an admission or a claim made. */
  started_at: bigint(),
  provider: text(),
  project_path: text(),
  project_remote: text(),
  runner_host_id: text(),
  title: text(),
  custom_title: text(),
  status: text({ notNull: true, default: 'idle' }),
  model: text(),
  reasoning_effort: text(),
  parent_session_id: text(),
  root_session_id: text(),
  /** The admission or claim time, kept by every later write. */
  created_at: bigint({ notNull: true }),
  last_activity_at: bigint({ notNull: true, default: 0 }),
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
  /** `chat` or `project` (docs/plans/session-starter.md), written once when the host makes the session; null before. */
  place: text(),
  /** What started the session, as JSON (`SessionStarter`), written once as `place` is. */
  started_by: text(),
  // Shared shelf state (docs/plans/session-archive.md): every person sees it. A
  // person's own settle, archive, and snooze are in `resource_preferences`.
  /** When its pull requests or task settled the session. Null while it is active. */
  settled_at: bigint(),
  /** What settled it: `pull-request`, `task`, or `idle`. */
  settled_by: text(),
  /** When a person made a settled session active again. Its pull requests settle it again only if they end after this time. */
  unsettled_at: bigint(),
  /** The last prompt the session received. */
  last_prompt_at: bigint(),
  /** The execution preferences the session's last run carried (`ExecutionPreferences`; plans/018 §6). Person-derived but shared on purpose. */
  execution_preferences: json(),
  /** When the session was marked a lead (docs/plans/lead-session.md); never cleared. */
  lead_started_at: bigint(),
}, {
  indexes: [
    { name: 'session_api_page', columns: ['organization_id', 'created_at', 'session_id'], descending: ['created_at', 'session_id'] },
    { name: 'session_api_provider_page', columns: ['organization_id', 'provider', 'created_at', 'session_id'], descending: ['created_at', 'session_id'] },
    { name: 'session_api_activity_page', columns: ['organization_id', 'last_activity_at', 'session_id'], descending: ['last_activity_at', 'session_id'] },
    // A host owner reads every organization (`scopeClause` is `1 = 1`): the recent sessions of the list (`listCandidates`).
    { name: 'session_by_activity', columns: ['last_activity_at', 'session_id'], descending: ['last_activity_at', 'session_id'] },
    // Every page names a parent: the top-level sessions (`parent_session_id IS NULL`) or the ones one session
    // started (`parentSessionId` filters, `readDelegatedSessions`). One index per page order, so a page is an
    // index walk that stops at its limit: an index on the order alone loses to this equality and sorts every row.
    { name: 'session_by_parent', columns: ['parent_session_id', 'created_at', 'session_id'], descending: ['created_at', 'session_id'] },
    { name: 'session_by_parent_activity', columns: ['parent_session_id', 'last_activity_at', 'session_id'], descending: ['last_activity_at', 'session_id'] },
    // The picker asks for one project's sessions.
    { name: 'session_by_project_path', columns: ['project_path', 'last_activity_at'] },
    // The chats of a home: the picker asks for them beside a project (unified-search.md decision 12).
    { name: 'session_by_place', columns: ['place', 'last_activity_at'] },
  ],
})

/** A child of `session`: a session delete removes it. */
const SESSION_REFERENCE = { table: session, column: 'session_id', onDelete: 'cascade' } as const

/**
 * The pull requests a session works on (docs/plans/session-pull-requests.md).
 * A session owns its links; a task reads the links of its sessions. One pull
 * request can belong to several sessions, and a session to several pull
 * requests. `session_id` is the stable Solus session id.
 */
export const sessionPullRequests = defineTable('session_pull_requests', {
  session_id: text({ notNull: true, references: SESSION_REFERENCE }),
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
  indexes: [
    { name: 'session_pull_requests_by_pull_request', columns: ['repository', 'number'] },
    // The open links, which keep their sessions in every list (`readSessionListPage`).
    { name: 'session_pull_requests_open', columns: ['session_id'], where: "source <> 'dismissed' AND (pr_state IS NULL OR pr_state NOT IN ('merged', 'closed', 'missing'))" },
  ],
})

/**
 * The pull requests a session watches (docs/plans/pr-watch.md): the watcher
 * reads each in the background and wakes the session's agent when there is
 * news. A watch belongs to a session link; `watch_id` is new at each start, so
 * a read that finishes after a stop or a restart writes nothing.
 */
export const sessionPullRequestWatches = defineTable('session_pull_request_watches', {
  session_id: text({ notNull: true, references: SESSION_REFERENCE }),
  /** `host/owner/repo`, lower case, as on the session link. */
  repository: text({ notNull: true }),
  number: integer({ notNull: true }),
  watch_id: text({ notNull: true }),
  started_at: bigint({ notNull: true }),
  /** `PullRequestWatchState` as JSON: what the agent was told. */
  state: text({ notNull: true }),
  /** Whose account reads the pull request: the person the watch was started
   *  for (plans/019-acting-identity.md). Null reads as the host. */
  acting_user_key: text(),
  organization_id: text({ notNull: true, default: 'local' }),
}, {
  primaryKey: ['session_id', 'repository', 'number'],
})

/** Host-owned references. Works keep their existing session membership; PRs keep their lifecycle rows. */
export const sessionLinks = defineTable('session_links', {
  session_id: text({ notNull: true, references: SESSION_REFERENCE }),
  link_id: text({ notNull: true }),
  target: json({ notNull: true }),
  title: text({ notNull: true }),
  created_by: json({ notNull: true }),
  linked_at: bigint({ notNull: true }),
  organization_id: text({ notNull: true, default: 'local' }),
}, { primaryKey: ['session_id', 'link_id'] })

export const SESSION_TABLES = [session, sessionLinks, sessionPullRequests, sessionPullRequestWatches]
