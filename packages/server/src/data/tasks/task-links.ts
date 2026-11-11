import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { parseGitHubPullRequestUrl, type PullRequest } from '@solus/contracts/providers'
import type { Db } from '../../db/database'
import type { Attribution } from '@solus/contracts/user'
import { taskChanged } from './task-activity'
import { appendActivity } from '../activity/activity'
import { attributionJson, parseStoredAttribution } from '../stored-attribution'
import { linkTargetRecordKey, linkTargetRecordsFor } from './host-records'
import { tasks } from './schema'
import { resourceLinks } from '../links/schema'
import {
  canonicalPullRequest,
  canonicalTargetScope,
  creatorOf,
  edgeClause,
  provenanceOf,
  pullRequestStateSchema,
  sourceClause,
  type LinkEdge,
  type LinkRelation,
} from '../links/resource-links'
import {
  latestObservation,
  OBSERVATION_COLUMNS,
  OBSERVATION_JOIN,
  OBSERVATION_ROW_COLUMNS,
  pullRequestObservedMerged,
  recordObservation,
} from '../links/pull-request-observations'
import { emitSessionPullRequestsChanged } from '../sessions/session-pull-requests'
import { assertTaskKey, database, emitChanged } from './task-store'
import { scopeClause } from '../scope'
import type { RecordScope } from '../../admission/principal'
import type {
  TaskLink,
  TaskLinkInput,
  TaskLinkKind,
  TaskLinkTarget,
  TaskLinkedTask,
  TaskPrSnapshot,
  TaskSidebarPrLink,
} from '@solus/contracts/task-types'

/** A task's links to docs, plans, PRs and automations: its edges in
 * `resource_links` to a work, plan, pr, or automation (data/links/schema.ts).
 * A link is an attachment: it keys on the task key, needs no row in `tasks`,
 * and has the organization of who made it.
 *
 * These are in-transaction cores, not a public API: they run inside the
 * caller's transaction and never open their own. The public surface is
 * `task-attachments.ts`.
 */

const linkKindSchema = z.enum(['work', 'plan', 'pr', 'automation'])

/** A task's link to something other than a session. */
const TASK_LINK = sql`resource_links.source_kind = 'task' AND resource_links.target_kind IN ('work', 'plan', 'pr', 'automation')`
const TASK_PR = sql`resource_links.source_kind = 'task' AND resource_links.target_kind = 'pr'`
/** A session's live pull request edge. */
const SESSION_PR = sql`resource_links.source_kind = 'session' AND resource_links.target_kind = 'pr'
  AND resource_links.relation = 'pull-request' AND resource_links.status = 'active'`

const taskLinkRowSchema = z.object({
  task_id: z.string(),
  kind: linkKindSchema,
  target_scope: z.string(),
  target_key: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  author: z.string().nullable(),
  origin_session_id: z.string().nullable(),
  via_session_id: z.string().nullable(),
  created_at: z.number(),
  pinned: z.number(),
  pr_state: pullRequestStateSchema.nullable(),
  pr_title: z.string().nullable(),
})
const titleRowSchema = z.object({ title: z.string(), organization_id: z.string() })
const taskPrLinkRowSchema = z.object({
  task_id: z.string(),
  target_scope: z.string(),
  target_key: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  author: z.string().nullable(),
  origin_session_id: z.string().nullable(),
  created_at: z.number(),
  ...OBSERVATION_ROW_COLUMNS,
})

/** A pull request that one of a task's sessions owns, joined to the task. */
const sessionOwnedPrRowSchema = z.object({
  task_id: z.string(),
  session_id: z.string(),
  repository: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  created_at: z.number(),
  ...OBSERVATION_ROW_COLUMNS,
})
type SessionOwnedPrRow = z.infer<typeof sessionOwnedPrRowSchema>

const prLinkInterestRowSchema = z.object({
  target_scope: z.string(),
  target_key: z.string(),
  pr_state: pullRequestStateSchema.nullable(),
  pr_updated_at: z.string().nullable(),
  active: z.coerce.number(),
})

const linkedTaskRowSchema = z.object({
  task_id: z.string(),
  kind: linkKindSchema,
  target_scope: z.string(),
  target_key: z.string(),
  title: z.string().nullable(),
  category: z.enum(['open', 'active', 'done']).nullable(),
  reference: z.string().nullable(),
})

/** A card asks for the handful of targets it shows; a transcript never asks
 *  for more than this at once, and the query is one OR-clause per target. */
export const LINKED_TASKS_TARGET_CAP = 200

type TaskLinkRow = z.infer<typeof taskLinkRowSchema>

/** One pull request to keep an eye on, and the project it belongs to. */
export interface PrLinkTarget {
  projectScope: string
  number: number
}

/** What PR sync last saw for a linked pull request. `missing`: the code host
 *  says that it does not exist. */
export type PrLinkState = 'open' | 'closed' | 'merged' | 'missing'

/** One linked pull request as PR sync reads it (docs/plans/pr-sync.md §3.1). */
export interface PrLinkInterest extends PrLinkTarget {
  /** A task that is not done links it. */
  isActive: boolean
  /** Null until PR sync first answers. */
  state: PrLinkState | null
  /** The code host's `updatedAt` at that answer; a merge's time for a merged one. */
  updatedAt: string | null
}

interface TaskSidebarPrLinks {
  [taskId: string]: TaskSidebarPrLink[]
}

/** Who an edge names as its maker; an edge with nobody recorded is Solus's own. */
function linkCreator(row: { author: string | null }): Attribution {
  return parseStoredAttribution(row.author) ?? { kind: 'system' }
}

/** The title a pull request row shows: the observation's once PR sync answered, else the link's. */
function titleOf(row: { title: string; pr_title: string | null }): string {
  return row.pr_title || row.title
}

function taskEdge(taskId: string, target: TaskLinkTarget): LinkEdge {
  return { sourceKind: 'task', sourceId: taskId, targetKind: target.kind, targetScope: canonicalTargetScope(target.kind, target.targetScope), targetKey: target.targetKey }
}

/**
 * The pull requests the sessions of these tasks own, newest first
 * (docs/plans/session-pull-requests.md). A task has no copy of them: it reads
 * them through its sessions, so a session that joins a task brings its pull
 * requests and one that leaves takes them with it. A `referenced` session is a
 * relationship, not the task's work, and brings none.
 */
async function readSessionOwnedPrRows(db: Db, scope: RecordScope, taskIds?: readonly string[]): Promise<SessionOwnedPrRow[]> {
  if (taskIds && !taskIds.length) return []
  const onlyTasks = taskIds
    ? sql` AND works_on.source_id IN (${sql.join(taskIds.map((taskId) => sql`${taskId}`), sql`, `)})`
    : sql``
  return sessionOwnedPrRowSchema.array().parse(await db.all(sql`
    SELECT works_on.source_id AS task_id, resource_links.source_id AS session_id, resource_links.repository,
      resource_links.number, resource_links.url, resource_links.title, resource_links.author, resource_links.created_at, ${OBSERVATION_COLUMNS}
    FROM ${resourceLinks}
    JOIN ${resourceLinks} AS works_on ON works_on.source_kind = 'task' AND works_on.target_kind = 'session'
      AND works_on.relation = 'works-on' AND works_on.status = 'active'
      AND works_on.target_key = resource_links.source_id AND works_on.organization_id = resource_links.organization_id
    ${OBSERVATION_JOIN}
    WHERE ${scopeClause(scope, sql`works_on.organization_id`)} AND ${SESSION_PR}${onlyTasks}
    ORDER BY resource_links.created_at DESC, resource_links.repository, resource_links.number DESC
  `))
}

function pullRequestKey(scope: string, number: number | string): string {
  return `${scope.toLowerCase()}#${number}`
}

/** Live title/status per kind. `work`, `plan` and `automation` all live on this
 * host, so a rename shows up immediately; `pr` state is a GitHub round trip
 * and must not make a task read network-bound, so it stays on the observation and
 * the renderer overlays from its own PR store. */
function linkFromRow(row: TaskLinkRow, live: Map<string, { title: string | null; status: string | null }>): TaskLink {
  const link: TaskLink = {
    taskId: row.task_id,
    kind: row.kind,
    targetScope: row.target_scope,
    targetKey: row.target_key,
    title: row.kind === 'pr' ? titleOf(row) : row.title,
    createdBy: linkCreator(row),
    linkedAt: row.created_at,
  }
  const record = live.get(linkTargetRecordKey({ kind: row.kind, targetScope: row.target_scope, targetKey: row.target_key }))
  if (record?.title !== null && record?.title !== undefined) link.liveTitle = record.title
  if (record?.status !== null && record?.status !== undefined) link.liveStatus = record.status
  if (row.url !== null) link.url = row.url
  if (row.origin_session_id !== null) link.originSessionId = row.origin_session_id
  if (row.via_session_id !== null) link.ownerSessionId = row.via_session_id
  if (row.pinned === 1) link.pinned = true
  if (row.pr_state === 'missing') link.missing = true
  return link
}

/** The snapshot label, so a row renders even once its target is gone. Resolved
 * from the target's own table when the caller did not supply one. */
async function snapshotTitle(organizationId: string, input: TaskLinkInput): Promise<string> {
  const supplied = input.title?.trim()
  if (supplied) return supplied
  const targetScope = input.targetScope ?? ''
  const fallback = { work: 'Untitled doc', automation: 'Untitled automation', plan: 'Untitled plan' }
  if (input.kind === 'pr') return `#${input.targetKey}`
  const target = { kind: input.kind, targetScope: input.kind === 'plan' ? targetScope : '', targetKey: input.targetKey }
  const record = (await linkTargetRecordsFor(organizationId, [target])).get(linkTargetRecordKey(target))
  return record?.title?.trim() || fallback[input.kind]
}

/** A link to write. `outputOfSessionId` names the session of the task that made
 *  the item, for a link that is there because that session made it. */
export type TaskLinkWrite = TaskLinkInput & { outputOfSessionId?: string }

/** What a task's edge records of the link it writes: its relation, who made it, and the pull request it names. */
async function linkFacts(db: Db, organizationId: string, input: TaskLinkWrite, by: Attribution, targetScope: string, targetKey: string) {
  const url = input.url?.trim() || null
  const relation: LinkRelation = input.outputOfSessionId ? 'output' : input.kind === 'pr' ? 'pull-request' : 'reference'
  // A task's pull request edge names its observation at once when the organization holds one.
  const canonical = input.kind === 'pr' ? canonicalPullRequest(url, targetScope, targetKey) : null
  const observation = canonical ? await latestObservation(db, organizationId, canonical.repository, canonical.number) : null
  return {
    url,
    relation,
    source: input.automatic ? 'system' : provenanceOf(by),
    author: attributionJson(input.automatic ? { kind: 'system' } : by),
    originSessionId: input.originSessionId?.trim() || null,
    repository: canonical?.repository ?? null,
    number: canonical?.number ?? null,
    authorityKey: observation?.authorityKey ?? null,
  }
}

export async function writeTaskLink(
  db: Db,
  organizationId: string,
  taskId: string,
  input: TaskLinkWrite,
  /** Who linked it; an `automatic` link is recorded as made by Solus itself. */
  by: Attribution,
  now = Date.now(),
): Promise<void> {
  assertTaskKey(taskId)
  const targetKey = input.targetKey.trim()
  if (!targetKey) throw new Error('A task link needs a target.')
  const targetScope = canonicalTargetScope(input.kind, (input.targetScope ?? '').trim())
  const title = await snapshotTitle(organizationId, { ...input, targetKey, targetScope })
  const facts = await linkFacts(db, organizationId, input, by, targetScope, targetKey)
  const createdBy = await creatorOf(by, async () => null)

  // A pin is a choice, and `undefined` is the absence of one: a re-link that
  // knows nothing about pinning must leave the existing pin alone. NULL is how
  // that reaches the COALESCE, so it is never written to the column itself.
  const pinned = input.pinned === undefined ? null : input.pinned ? 1 : 0

  await db.run(sql`
    INSERT INTO ${resourceLinks}(
      organization_id, source_kind, source_id, target_kind, target_scope, target_key, relation, title, url, source, status,
      pinned, via_session_id, origin_session_id, repository, number, authority_key, keeps_session, author, created_by, created_at
    ) VALUES (
      ${organizationId}, 'task', ${taskId}, ${input.kind}, ${targetScope}, ${targetKey}, ${facts.relation}, ${title}, ${facts.url},
      ${facts.source}, 'active',
      COALESCE(${pinned}, 0), ${input.outputOfSessionId ?? null}, ${facts.originSessionId},
      ${facts.repository}, ${facts.number}, ${facts.authorityKey}, 0,
      ${facts.author}, ${createdBy}, ${now}
    )
    ON CONFLICT(organization_id, source_kind, source_id, target_kind, target_scope, target_key) DO UPDATE SET
      title = excluded.title,
      url = COALESCE(excluded.url, resource_links.url),
      pinned = COALESCE(${pinned}, resource_links.pinned)
  `)
  // One artifact is open on a task at a time, so pinning one clears the rest in
  // the same transaction rather than leaving two rows claiming the slot.
  if (pinned === 1) {
    await db.run(sql`
      UPDATE ${resourceLinks} SET pinned = 0
      WHERE ${sourceClause('task', taskId)} AND resource_links.organization_id = ${organizationId} AND resource_links.pinned = 1
        AND NOT (resource_links.target_kind = ${input.kind} AND resource_links.target_scope = ${targetScope} AND resource_links.target_key = ${targetKey})
    `)
  }
  await appendActivity(organizationId, taskChanged(taskId, by, 'linked', {
    target: { kind: input.kind, scope: targetScope, key: targetKey, title },
  }, now), db)
}

/**
 * A person or an agent links an item that is on the task as a session's
 * output: the link is now deliberate, so it stays when the session leaves.
 * Returns false when the link was deliberate already.
 */
export async function claimSessionOutputLink(db: Db, organizationId: string, taskId: string, target: TaskLinkTarget): Promise<boolean> {
  return (await db.run(sql`
    UPDATE ${resourceLinks} SET relation = 'reference', via_session_id = NULL
    WHERE ${edgeClause(taskEdge(taskId, target))} AND resource_links.organization_id = ${organizationId} AND resource_links.relation = 'output'
  `)).changes > 0
}

/** The outputs of a session leave the task with the session. Returns false
 *  when the task held none. */
export async function deleteSessionOutputLinks(db: Db, organizationId: string, taskId: string, sessionId: string): Promise<boolean> {
  return (await db.run(sql`
    DELETE FROM ${resourceLinks} WHERE ${sourceClause('task', taskId)} AND resource_links.organization_id = ${organizationId}
      AND resource_links.relation = 'output' AND resource_links.via_session_id = ${sessionId}
  `)).changes > 0
}

/**
 * Move (or clear) the pin without re-linking.
 *
 * A pin is not a link: re-running `writeTaskLink` for it would append a second
 * "linked <name>" line to the task's activity feed every time the reader
 * changed which artifact the page opens with. Returns false when the pin is
 * already where it was asked to be, so the caller can skip the broadcast.
 */
export async function setTaskLinkPin(
  db: Db,
  organizationId: string,
  taskId: string,
  target: TaskLinkTarget,
  pinned: boolean,
): Promise<boolean> {
  const flag = pinned ? 1 : 0
  const edge = taskEdge(taskId, target)
  const inOrganization = sql`resource_links.organization_id = ${organizationId}`
  const changed = await db.run(sql`
    UPDATE ${resourceLinks} SET pinned = ${flag}
    WHERE ${edgeClause(edge)} AND ${inOrganization} AND resource_links.pinned <> ${flag}
  `)
  if (changed.changes === 0) return false
  if (pinned) {
    await db.run(sql`
      UPDATE ${resourceLinks} SET pinned = 0
      WHERE ${sourceClause('task', taskId)} AND ${inOrganization} AND resource_links.pinned = 1
        AND NOT (resource_links.target_kind = ${edge.targetKind} AND resource_links.target_scope = ${edge.targetScope} AND resource_links.target_key = ${edge.targetKey})
    `)
  }
  return true
}

/** Returns false when there was nothing to unlink in `scope`, so the caller
 * can skip the change broadcast on a no-op. The history of the unlink is in
 * the organization of the link. */
export async function deleteTaskLink(
  db: Db,
  scope: RecordScope,
  taskId: string,
  kind: TaskLinkKind,
  targetKey: string,
  targetScope = '',
  by: Attribution,
  now = Date.now(),
): Promise<boolean> {
  const edge = taskEdge(taskId, { kind, targetScope, targetKey })
  const inScope = sql`${edgeClause(edge)} AND ${scopeClause(scope, sql`resource_links.organization_id`)}`
  const existing = titleRowSchema.nullish().parse(await db.get(sql`
    SELECT title, organization_id FROM ${resourceLinks} WHERE ${inScope}
  `))
  if (!existing) return false

  await db.run(sql`DELETE FROM ${resourceLinks} WHERE ${inScope}`)
  // Carries the title so the feed still reads "unlinked <name>" afterwards.
  await appendActivity(existing.organization_id, taskChanged(taskId, by, 'unlinked', {
    target: { kind, scope: edge.targetScope, key: targetKey, title: existing.title },
  }, now), db)
  return true
}

/** A task's links in `scope`: the ones made on it, and the pull requests its
 *  sessions own. A pull request linked both ways is the task's own link. */
export async function readTaskLinks(db: Db, scope: RecordScope, taskId: string): Promise<TaskLink[]> {
  const rows = taskLinkRowSchema.array().parse(await db.all(sql`
    SELECT resource_links.source_id AS task_id, resource_links.target_kind AS kind, resource_links.target_scope, resource_links.target_key,
      resource_links.title, resource_links.url, resource_links.author, resource_links.origin_session_id, resource_links.via_session_id,
      resource_links.created_at, resource_links.pinned, o.state AS pr_state, o.title AS pr_title
    FROM ${resourceLinks} ${OBSERVATION_JOIN}
    WHERE ${TASK_LINK} AND resource_links.source_id = ${taskId} AND ${scopeClause(scope, sql`resource_links.organization_id`)}
    ORDER BY resource_links.created_at DESC, resource_links.target_kind, resource_links.target_key
  `))
  const live = await linkTargetRecordsFor(
    scope,
    rows.map((row) => ({ kind: row.kind, targetScope: row.target_scope, targetKey: row.target_key })),
  )
  const links = rows.map((row) => linkFromRow(row, live))
  const held = new Set(rows.filter((row) => row.kind === 'pr').map((row) => pullRequestKey(row.target_scope, row.target_key)))
  for (const row of await readSessionOwnedPrRows(db, scope, [taskId])) {
    const key = pullRequestKey(row.repository, row.number)
    if (held.has(key)) continue
    held.add(key)
    const link: TaskLink = {
      taskId,
      kind: 'pr',
      targetScope: row.repository,
      targetKey: String(row.number),
      title: titleOf(row) || `#${row.number}`,
      url: row.url,
      createdBy: linkCreator(row),
      ownerSessionId: row.session_id,
      linkedAt: row.created_at,
    }
    if (row.pr_state === 'missing') link.missing = true
    links.push(link)
  }
  return links.sort((left, right) => right.linkedAt - left.linkedAt)
}

/**
 * The reverse read: which tasks link each of these targets.
 *
 * This is what a conversation card asks so it can say "Linked to acme/app#184"
 * beside the document it just rendered, and offer the way back out. It joins
 * the host's copy of the task for the title and category the label needs, and
 * nothing more — the card opens the task for the rest. A host that holds the
 * link but never read the task names it by its key. Targets past the cap are dropped
 * rather than failing the read: a card missing a label is recoverable, a
 * transcript with no labels is not.
 */
export async function readTasksLinkingTargets(
  db: Db,
  scope: RecordScope,
  targets: TaskLinkTarget[],
): Promise<TaskLinkedTask[]> {
  const wanted = targets.slice(0, LINKED_TASKS_TARGET_CAP)
  if (!wanted.length) return []
  const clause = sql.join(wanted.map((target) =>
    sql`(resource_links.target_kind = ${target.kind} AND resource_links.target_scope = ${canonicalTargetScope(target.kind, target.targetScope)} AND resource_links.target_key = ${target.targetKey})`), sql` OR `)
  const rows = linkedTaskRowSchema.array().parse(await db.all(sql`
    SELECT
      resource_links.source_id AS task_id, resource_links.target_kind AS kind, resource_links.target_scope, resource_links.target_key,
      tasks.title, tasks.category, tasks.reference
    FROM ${resourceLinks}
    LEFT JOIN ${tasks} ON tasks.id = resource_links.source_id
    WHERE ${scopeClause(scope, sql`resource_links.organization_id`)} AND ${TASK_LINK} AND (${clause})
    ORDER BY resource_links.created_at DESC
  `))
  return rows.map((row) => {
    const linked: TaskLinkedTask = {
      taskId: row.task_id,
      kind: row.kind,
      targetScope: row.target_scope,
      targetKey: row.target_key,
      title: row.title ?? row.task_id,
      category: row.category ?? 'open',
    }
    if (row.reference !== null) linked.reference = row.reference
    return linked
  })
}

/**
 * Every pull request linked on a task itself, with whether live work links it
 * (a task with no copy on this host is not known to be done, so it counts)
 * and what PR sync last saw. Distinct, because several tasks commonly link one
 * pull request and it is one question either way. The links that sessions own
 * are a separate read (`readSessionPullRequestInterests`).
 */
export async function readPrLinkInterests(db: Db, scope: RecordScope): Promise<PrLinkInterest[]> {
  const rows = prLinkInterestRowSchema.array().parse(await db.all(sql`
    SELECT resource_links.target_scope, resource_links.target_key, MAX(o.state) AS pr_state,
      MAX(o.updated_at) AS pr_updated_at,
      MAX(CASE WHEN tasks.category = 'done' THEN 0 ELSE 1 END) AS active
    FROM ${resourceLinks}
    LEFT JOIN ${tasks} ON tasks.id = resource_links.source_id
    ${OBSERVATION_JOIN}
    WHERE ${scopeClause(scope, sql`resource_links.organization_id`)}
      AND ${TASK_PR} AND resource_links.target_scope <> ''
    GROUP BY resource_links.target_scope, resource_links.target_key
  `))
  const interests: PrLinkInterest[] = []
  for (const row of rows) {
    const number = Number(row.target_key)
    if (!Number.isSafeInteger(number) || number <= 0) continue
    interests.push({
      projectScope: row.target_scope, number, isActive: row.active === 1,
      state: row.pr_state, updatedAt: row.pr_updated_at,
    })
  }
  return interests
}

/**
 * Write what PR sync saw for one pull request to its observation and bind every
 * edge that names it — the links made on tasks and the links sessions own —
 * then announce the sessions and tasks whose links changed. `scopes` are the
 * link scopes that name its repository: the repository key, and any local path
 * that resolved to it. Null means the code host says that the pull request
 * does not exist.
 */
export async function recordPullRequestObservation(
  repository: string,
  scopes: readonly string[],
  number: number,
  pullRequest: PullRequest | null,
): Promise<void> {
  const { sessionIds, taskIds } = await recordObservation(database(), { repository, number, scopes, pullRequest })
  for (const sessionId of sessionIds) emitSessionPullRequestsChanged(sessionId)
  for (const taskId of taskIds) emitChanged(taskId)
}

/** Whether PR sync last saw this linked pull request merged. Never a network
 *  read: completion asks about a task's other links, and an unknown one is not
 *  evidence that the work is finished. */
export async function linkedPullRequestIsMerged({ projectScope, number }: PrLinkTarget): Promise<boolean> {
  return pullRequestObservedMerged(database(), projectScope, number)
}

/** The part of a pull request a task card draws, as PR sync last saw it:
 *  display state, never a permission. */
function linkSnapshotOf(
  row: { pr_state: PrLinkState | null; pr_draft: number | null; pr_updated_at: string | null; url: string | null; title: string; pr_title: string | null },
  number: number,
): TaskPrSnapshot | null {
  if (!row.pr_state || row.pr_state === 'missing' || row.pr_updated_at === null || row.url === null) return null
  const parsed = parseGitHubPullRequestUrl(row.url)
  if (!parsed) return null
  return {
    number, url: parsed.url, title: titleOf(row),
    state: row.pr_state, draft: row.pr_draft === 1, updatedAt: row.pr_updated_at,
    baseRepo: parsed.baseRepo,
  }
}

/**
 * Each task's pull requests for the sidebar's cold-start snapshot, newest
 * first: the links made on the task, and the links its sessions own. A pull
 * request linked both ways is the task's own link. Invalid legacy keys stay out
 * of the renderer contract.
 */
export async function readTaskPrLinks(db: Db, scope: RecordScope, taskIds?: readonly string[]): Promise<TaskSidebarPrLinks> {
  if (taskIds && !taskIds.length) return {}
  const onlyTasks = taskIds
    ? sql` AND resource_links.source_id IN (${sql.join(taskIds.map((taskId) => sql`${taskId}`), sql`, `)})`
    : sql``
  const rows = taskPrLinkRowSchema.array().parse(await db.all(sql`
    SELECT resource_links.source_id AS task_id, resource_links.target_scope, resource_links.target_key, resource_links.title, resource_links.url,
      resource_links.author, resource_links.origin_session_id, resource_links.created_at, ${OBSERVATION_COLUMNS}
    FROM ${resourceLinks} ${OBSERVATION_JOIN}
    WHERE ${TASK_PR} AND ${scopeClause(scope, sql`resource_links.organization_id`)}${onlyTasks}
    ORDER BY resource_links.created_at DESC, resource_links.source_id, resource_links.target_scope, resource_links.target_key DESC
  `))
  const dated = new Map<string, Array<{ link: TaskSidebarPrLink; linkedAt: number }>>()
  const held = new Set<string>()
  const add = (taskId: string, link: TaskSidebarPrLink, linkedAt: number) => {
    const entries = dated.get(taskId)
    if (entries) entries.push({ link, linkedAt })
    else dated.set(taskId, [{ link, linkedAt }])
  }
  for (const row of rows) {
    const number = Number(row.target_key)
    if (!Number.isSafeInteger(number) || number <= 0) continue
    const link: TaskSidebarPrLink = {
      number,
      title: titleOf(row),
      targetScope: row.target_scope,
      createdBy: linkCreator(row),
    }
    const snapshot = linkSnapshotOf(row, number)
    if (snapshot) link.snapshot = snapshot
    if (row.pr_state === 'missing') link.missing = true
    if (row.url !== null) link.url = row.url
    if (row.origin_session_id !== null) link.originSessionId = row.origin_session_id
    held.add(`${row.task_id}\0${pullRequestKey(row.target_scope, number)}`)
    add(row.task_id, link, row.created_at)
  }
  for (const row of await readSessionOwnedPrRows(db, scope, taskIds)) {
    const key = `${row.task_id}\0${pullRequestKey(row.repository, row.number)}`
    if (held.has(key)) continue
    held.add(key)
    const link: TaskSidebarPrLink = {
      number: row.number,
      title: titleOf(row) || `#${row.number}`,
      targetScope: row.repository,
      url: row.url,
      createdBy: linkCreator(row),
      ownerSessionId: row.session_id,
    }
    const snapshot = linkSnapshotOf(row, row.number)
    if (snapshot) link.snapshot = snapshot
    if (row.pr_state === 'missing') link.missing = true
    add(row.task_id, link, row.created_at)
  }
  const links: TaskSidebarPrLinks = {}
  for (const [taskId, entries] of dated) {
    links[taskId] = entries.sort((left, right) => right.linkedAt - left.linkedAt).map((entry) => entry.link)
  }
  return links
}

const linkedTaskIdRowSchema = z.object({ task_id: z.string() })

/** A task row draws the last observation of each pull request it links, so a
 * new observation changes exactly the tasks that link that pull request.
 * Announce those alone; a pull request no task links changes no task. */
export async function emitPullRequestTasksChanged(scope: RecordScope, targetScope: string, number: number): Promise<void> {
  const rows = linkedTaskIdRowSchema.array().parse(await database().all(sql`
    SELECT DISTINCT resource_links.source_id AS task_id FROM ${resourceLinks}
    WHERE ${scopeClause(scope, sql`resource_links.organization_id`)} AND ${TASK_PR}
      AND lower(resource_links.target_scope) = lower(${targetScope}) AND resource_links.target_key = ${String(number)}
  `))
  for (const row of rows) emitChanged(row.task_id)
}
