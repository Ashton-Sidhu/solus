import { bigint, defineTable, integer, json, text } from '../../db/schema/define-table'

/**
 * The relationships between records (plans/029-fresh-database-baseline.md §5.1):
 * one row per edge from a task or a session to another record. One table
 * replaces `task_links`, `task_session_links`, `session_links`,
 * `session_pull_requests` with its watches, and the JSON membership in
 * `works.meta.sessionIds`.
 *
 * The endpoints are polymorphic, so no SQL foreign key is possible: the
 * commands check both ends against the organization, and every delete of a
 * task, a work, or a session deletes its edges in the same transaction
 * (`deleteEdgesOf`). `defineTable` has no CHECK; the commands in
 * `resource-links.ts` keep the invariants (`keeps_session` only on an active
 * session→pull-request edge; the watch fields all set or all null; a dismissed
 * edge is not watched; a canonical pull request has both `repository` and
 * `number` or neither).
 *
 * Relations, one name per concept:
 * - `works-on`      task → session: the session works on the task (one active owner per session).
 * - `reference`     task → session: a relationship, not the task's work; task → work, plan, or
 *                   automation: a deliberate link; session → file or automation.
 * - `output`        task → work, plan, or automation: on the task because its working session
 *                   `via_session_id` made the item (docs/plans/session-outputs.md).
 * - `member`        session → work: the work is one of the session's artifacts. The session that
 *                   made the work stays `works.session_id` and needs no edge for access.
 * - `pull-request`  task → pr, session → pr. A session edge can be `dismissed`: the tombstone that
 *                   keeps PR sync from linking the branch's pull request again.
 */
export const resourceLinks = defineTable('resource_links', {
  organization_id: text({ notNull: true, default: 'local' }),
  source_kind: text({ notNull: true }),
  source_id: text({ notNull: true }),
  target_kind: text({ notNull: true }),
  /** The raw scope of the target: a repository key or a checkout path for a pull request, the
   *  plan's session, the host of a file or an automation. One canonical spelling per kind: a
   *  session target has `''`; a repository is lower case. */
  target_scope: text({ notNull: true, default: '' }),
  target_key: text({ notNull: true }),
  relation: text({ notNull: true }),
  /** The link-time label; a pull request's live title is on its observation. */
  title: text({ notNull: true, default: '' }),
  url: text(),
  /** Provenance: `manual` (a person), `agent`, `system` (Solus itself), and for a pull request
   *  also `branch` (found on the session's branch) and `created` (opened from the session). */
  source: text({ notNull: true, default: 'manual' }),
  /** `active`; `dismissed`, a removed pull request kept as a tombstone; `historical`, a
   *  `works-on` edge of a task that moved to its organization. */
  status: text({ notNull: true, default: 'active' }),
  pinned: integer({ notNull: true, default: 0 }),
  /** An `output` edge: the task's session that made the item. Null on a deliberate link. */
  via_session_id: text(),
  origin_session_id: text(),
  /** The observation the edge reads its pull request from, with `repository` and `number`
   *  (`pull_request_observations`); null until PR sync first answers. */
  authority_key: text(),
  /** The canonical pull request, both set or both null; null while the raw target is unresolved. */
  repository: text(),
  number: integer(),
  /** 1 on an active session→pull-request edge whose pull request is open or not yet observed:
   *  such a link keeps its session in every list (`readSessionListPage`). Stored, not derived
   *  (plans/data-model-validation/README.md). */
  keeps_session: integer({ notNull: true, default: 0 }),
  // A watch on a session's pull request (docs/plans/pr-watch.md): all four set or all null.
  /** New at each start, so a read that finishes after a stop or a restart writes nothing. */
  watch_id: text(),
  watch_started_at: bigint(),
  /** The person the watch acts for: whose account reads the pull request. Null is the host. */
  watch_user_id: text(),
  /** `PullRequestWatchState` as JSON. */
  watch_state: text(),
  /** Who made the edge, as the clients show it (`Attribution` JSON): a link's `createdBy`, a
   *  task session's `startedBy`. Null when nobody recorded who, as a first-dispatch bind. */
  author: json(),
  /** The user id of who made the edge (plans/029 decision 2); the source record's owner when the writer named no person. */
  created_by: text({ notNull: true }),
  created_at: bigint({ notNull: true }),
}, {
  indexes: [
    // The edge identity. The organization is part of it: a task key is the
    // provider's, so two organizations on one host can link one target to one task.
    { name: 'resource_links_edge', columns: ['organization_id', 'source_kind', 'source_id', 'target_kind', 'target_scope', 'target_key'], unique: true },
    // The forward read of one source's edges, in each organization.
    { name: 'resource_links_by_source', columns: ['source_kind', 'source_id', 'target_kind'] },
    // The reverse read: key before scope, so a work is found by its id alone (`readTasksLinkingTargets`).
    { name: 'resource_links_by_target', columns: ['target_kind', 'target_key', 'target_scope'] },
    // One task works on a session at a time (`transferSessionOwnership`).
    { name: 'resource_links_working_owner', columns: ['organization_id', 'target_key'], unique: true, where: "source_kind = 'task' AND target_kind = 'session' AND relation = 'works-on' AND status = 'active'" },
    // The links that keep their session listed: the measured covering index of the session list's candidate query.
    { name: 'resource_links_open_session', columns: ['source_id', 'organization_id'], where: 'keeps_session = 1' },
    // A watch's generation guard (`endPullRequestWatch`, `recordPullRequestWatchState`).
    { name: 'resource_links_watch', columns: ['watch_id'], unique: true, where: 'watch_id IS NOT NULL' },
    // An observation reaches every edge of its pull request (`recordObservation`, `sessionsOfPullRequest`).
    { name: 'resource_links_by_pull_request', columns: ['repository', 'number'], where: 'repository IS NOT NULL' },
  ],
})

/**
 * What PR sync last saw of a pull request, once per organization and source
 * authority (plans/029 §5.1, P1). The authority is the visibility context the
 * read had — the host, or a person's account — never a token; what one
 * authority cannot see (`missing`) is not written over what another saw. An
 * edge names the observation it reads through `authority_key`, `repository`,
 * and `number`; the observation and every dependent `keeps_session` bit are
 * written in one transaction.
 */
export const pullRequestObservations = defineTable('pull_request_observations', {
  organization_id: text({ notNull: true, default: 'local' }),
  authority_key: text({ notNull: true }),
  /** `host/owner/repo`, lower case. */
  repository: text({ notNull: true }),
  number: integer({ notNull: true }),
  /** `open`, `closed`, `merged`, or `missing`: the code host says that it does not exist. */
  state: text({ notNull: true }),
  draft: integer(),
  title: text({ notNull: true, default: '' }),
  /** The code host's `updatedAt`; a merge's time for a merged one. Null for a missing one. */
  updated_at: text(),
  observed_at: bigint({ notNull: true }),
}, {
  primaryKey: ['organization_id', 'authority_key', 'repository', 'number'],
})

export const LINK_TABLES = [resourceLinks, pullRequestObservations]
