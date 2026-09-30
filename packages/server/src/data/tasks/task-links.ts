import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { parseGitHubPullRequestUrl, type PullRequest } from '@solus/contracts/providers'
import type { Db } from '../../db/database'
import type { Attribution } from '@solus/contracts/user'
import { legacyTaskActor, taskChanged } from './task-activity'
import { appendActivity } from '../activity/activity'
import { attributionJson, parseStoredAttribution } from '../stored-attribution'
import { linkTargetRecordKey, linkTargetRecordsFor } from './host-records'
import { taskLinks, taskSessionLinks, tasks } from './schema'
import { sessionPullRequests } from '../sessions/schema'
import { recordSessionPullRequestObservation, sessionPullRequestIsMerged } from '../sessions/session-pull-requests'
import { database, emitChanged } from './task-store'
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

/** A task's links to docs, plans, PRs and automations.
 *
 * These are in-transaction cores, not a public API: they run inside the
 * caller's transaction and never open their own. The public surface is the
 * `Task` object's `link()` / `unlink()` / `links()`.
 */

const taskLinkRowSchema = z.object({
  task_id: z.string(),
  kind: z.enum(['work', 'plan', 'pr', 'automation']),
  target_scope: z.string(),
  target_key: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  created_by: z.string(),
  origin_session_id: z.string().nullable(),
  output_session_id: z.string().nullable(),
  linked_at: z.number(),
  pinned: z.number(),
  pr_state: z.string().nullable(),
})
const titleRowSchema = z.object({ title: z.string() })
const taskPrLinkRowSchema = z.object({
  task_id: z.string(),
  target_scope: z.string(),
  target_key: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  created_by: z.string(),
  origin_session_id: z.string().nullable(),
  pr_state: z.enum(['open', 'closed', 'merged', 'missing']).nullable(),
  pr_draft: z.number().nullable(),
  pr_updated_at: z.string().nullable(),
  linked_at: z.number(),
})

/** A pull request that one of a task's sessions owns, joined to the task. */
const sessionOwnedPrRowSchema = z.object({
  task_id: z.string(),
  session_id: z.string(),
  repository: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.string(),
  created_by: z.string(),
  linked_at: z.number(),
  pr_state: z.enum(['open', 'closed', 'merged', 'missing']).nullable(),
  pr_draft: z.number().nullable(),
  pr_updated_at: z.string().nullable(),
})
type SessionOwnedPrRow = z.infer<typeof sessionOwnedPrRowSchema>

const prLinkWatchRowSchema = z.object({
  target_scope: z.string(),
  target_key: z.string(),
  pr_state: z.enum(['open', 'closed', 'merged', 'missing']).nullable(),
  pr_updated_at: z.string().nullable(),
  active: z.coerce.number(),
})

const linkedTaskRowSchema = z.object({
  task_id: z.string(),
  kind: z.enum(['work', 'plan', 'pr', 'automation']),
  target_scope: z.string(),
  target_key: z.string(),
  title: z.string(),
  status: z.string(),
  short_id: z.number().nullable(),
  project_key: z.string().nullable(),
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
export interface PrLinkWatch extends PrLinkTarget {
  /** A task that is not done or dropped links it. */
  isActive: boolean
  /** Null until PR sync first answers. */
  state: PrLinkState | null
  /** The code host's `updatedAt` at that answer; a merge's time for a merged one. */
  updatedAt: string | null
}

interface TaskSidebarPrLinks {
  [taskId: string]: TaskSidebarPrLink[]
}

/** Who a link row names as its maker; a label from before plan 012 stage 4 reads as `legacyTaskActor` does. */
function linkCreator(row: { created_by: string; origin_session_id: string | null }): Attribution {
  return parseStoredAttribution(row.created_by) ?? legacyTaskActor(row.created_by, row.origin_session_id)
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
    ? sql` AND task_session_links.task_id IN (${sql.join(taskIds.map((taskId) => sql`${taskId}`), sql`, `)})`
    : sql``
  return sessionOwnedPrRowSchema.array().parse(await db.all(sql`
    SELECT task_session_links.task_id, session_pull_requests.session_id, session_pull_requests.repository,
      session_pull_requests.number, session_pull_requests.url, session_pull_requests.title,
      session_pull_requests.created_by, session_pull_requests.linked_at, session_pull_requests.pr_state,
      session_pull_requests.pr_draft, session_pull_requests.pr_updated_at
    FROM ${sessionPullRequests}
    JOIN ${taskSessionLinks} ON task_session_links.session_id = session_pull_requests.session_id
    WHERE ${scopeClause(scope, sql`task_session_links.organization_id`)}
      AND task_session_links.role <> 'referenced'
      AND session_pull_requests.source <> 'dismissed'${onlyTasks}
    ORDER BY session_pull_requests.linked_at DESC, session_pull_requests.repository, session_pull_requests.number DESC
  `))
}

function pullRequestKey(scope: string, number: number | string): string {
  return `${scope.toLowerCase()}#${number}`
}

/** Live title/status per kind. `work`, `plan` and `automation` all live on this
 * host, so a rename shows up immediately; `pr` state is a GitHub round trip
 * and must not make a task read network-bound, so it stays on the snapshot and
 * the renderer overlays from its own PR store. */
function linkFromRow(row: TaskLinkRow, live: Map<string, { title: string | null; status: string | null }>): TaskLink {
  const link: TaskLink = {
    taskId: row.task_id,
    kind: row.kind,
    targetScope: row.target_scope,
    targetKey: row.target_key,
    title: row.title,
    createdBy: linkCreator(row),
    linkedAt: row.linked_at,
  }
  const record = live.get(linkTargetRecordKey({ kind: row.kind, targetScope: row.target_scope, targetKey: row.target_key }))
  if (record?.title !== null && record?.title !== undefined) link.liveTitle = record.title
  if (record?.status !== null && record?.status !== undefined) link.liveStatus = record.status
  if (row.url !== null) link.url = row.url
  if (row.origin_session_id !== null) link.originSessionId = row.origin_session_id
  if (row.output_session_id !== null) link.ownerSessionId = row.output_session_id
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

export async function writeTaskLink(
  db: Db,
  organizationId: string,
  taskId: string,
  input: TaskLinkWrite,
  /** Who linked it; an `automatic` link is recorded as made by Solus itself. */
  by: Attribution,
  now = Date.now(),
): Promise<void> {
  const targetKey = input.targetKey.trim()
  if (!targetKey) throw new Error('A task link needs a target.')
  const targetScope = (input.targetScope ?? '').trim()
  const title = await snapshotTitle(organizationId, { ...input, targetKey, targetScope })

  // A pin is a choice, and `undefined` is the absence of one: a re-link that
  // knows nothing about pinning must leave the existing pin alone. NULL is how
  // that reaches the COALESCE, so it is never written to the column itself.
  const pinned = input.pinned === undefined ? null : input.pinned ? 1 : 0

  await db.run(sql`
    INSERT INTO ${taskLinks}(
      task_id, kind, target_scope, target_key, title, url, created_by,
      origin_session_id, output_session_id, linked_at, pinned, organization_id
    ) VALUES (
      ${taskId}, ${input.kind}, ${targetScope}, ${targetKey}, ${title}, ${input.url?.trim() || null},
      ${attributionJson(input.automatic ? { kind: 'system' } : by)}, ${input.originSessionId?.trim() || null},
      ${input.outputOfSessionId ?? null}, ${now},
      COALESCE(${pinned}, 0), ${organizationId}
    )
    ON CONFLICT(task_id, kind, target_scope, target_key) DO UPDATE SET
      title = excluded.title,
      url = COALESCE(excluded.url, task_links.url),
      linked_at = excluded.linked_at,
      pinned = COALESCE(${pinned}, task_links.pinned)
  `)
  // One artifact is open on a task at a time, so pinning one clears the rest in
  // the same transaction rather than leaving two rows claiming the slot.
  if (pinned === 1) {
    await db.run(sql`
      UPDATE ${taskLinks} SET pinned = 0
      WHERE task_id = ${taskId} AND pinned = 1
        AND NOT (kind = ${input.kind} AND target_scope = ${targetScope} AND target_key = ${targetKey})
    `)
  }
  await db.run(sql`UPDATE ${tasks} SET updated_at = ${now} WHERE id = ${taskId}`)
  await appendActivity(organizationId, taskChanged(taskId, by, 'linked', {
    target: { kind: input.kind, scope: targetScope, key: targetKey, title },
  }, now), db)
}

/**
 * A person or an agent links an item that is on the task as a session's
 * output: the link is now deliberate, so it stays when the session leaves.
 * Returns false when the link was deliberate already.
 */
export async function claimSessionOutputLink(db: Db, taskId: string, target: TaskLinkTarget): Promise<boolean> {
  return (await db.run(sql`
    UPDATE ${taskLinks} SET output_session_id = NULL
    WHERE task_id = ${taskId} AND kind = ${target.kind} AND target_scope = ${target.targetScope}
      AND target_key = ${target.targetKey} AND output_session_id IS NOT NULL
  `)).changes > 0
}

/** The outputs of a session leave the task with the session. Returns false
 *  when the task held none. */
export async function deleteSessionOutputLinks(db: Db, taskId: string, sessionId: string): Promise<boolean> {
  return (await db.run(sql`
    DELETE FROM ${taskLinks} WHERE task_id = ${taskId} AND output_session_id = ${sessionId}
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
  taskId: string,
  target: TaskLinkTarget,
  pinned: boolean,
  now = Date.now(),
): Promise<boolean> {
  const flag = pinned ? 1 : 0
  const changed = await db.run(sql`
    UPDATE ${taskLinks} SET pinned = ${flag}
    WHERE task_id = ${taskId} AND kind = ${target.kind} AND target_scope = ${target.targetScope}
      AND target_key = ${target.targetKey} AND pinned <> ${flag}
  `)
  if (changed.changes === 0) return false
  if (pinned) {
    await db.run(sql`
      UPDATE ${taskLinks} SET pinned = 0
      WHERE task_id = ${taskId} AND pinned = 1
        AND NOT (kind = ${target.kind} AND target_scope = ${target.targetScope} AND target_key = ${target.targetKey})
    `)
  }
  await db.run(sql`UPDATE ${tasks} SET updated_at = ${now} WHERE id = ${taskId}`)
  return true
}

/** Returns false when there was nothing to unlink, so the caller can skip the
 * change broadcast on a no-op. */
export async function deleteTaskLink(
  db: Db,
  organizationId: string,
  taskId: string,
  kind: TaskLinkKind,
  targetKey: string,
  targetScope = '',
  by: Attribution,
  now = Date.now(),
): Promise<boolean> {
  const existing = titleRowSchema.nullish().parse(await db.get(sql`
    SELECT title FROM ${taskLinks}
    WHERE task_id = ${taskId} AND kind = ${kind} AND target_scope = ${targetScope} AND target_key = ${targetKey}
  `))
  if (!existing) return false

  await db.run(sql`
    DELETE FROM ${taskLinks}
    WHERE task_id = ${taskId} AND kind = ${kind} AND target_scope = ${targetScope} AND target_key = ${targetKey}
  `)
  await db.run(sql`UPDATE ${tasks} SET updated_at = ${now} WHERE id = ${taskId}`)
  // Carries the title so the feed still reads "unlinked <name>" afterwards.
  await appendActivity(organizationId, taskChanged(taskId, by, 'unlinked', {
    target: { kind, scope: targetScope, key: targetKey, title: existing.title },
  }, now), db)
  return true
}

/** A task's links: the ones made on it, and the pull requests its sessions
 *  own. A pull request linked both ways is the task's own link. */
export async function readTaskLinks(db: Db, organizationId: string, taskId: string): Promise<TaskLink[]> {
  const rows = taskLinkRowSchema.array().parse(await db.all(sql`
    SELECT * FROM ${taskLinks}
    WHERE task_id = ${taskId}
    ORDER BY linked_at DESC, kind, target_key
  `))
  const live = await linkTargetRecordsFor(
    organizationId,
    rows.map((row) => ({ kind: row.kind, targetScope: row.target_scope, targetKey: row.target_key })),
  )
  const links = rows.map((row) => linkFromRow(row, live))
  const held = new Set(rows.filter((row) => row.kind === 'pr').map((row) => pullRequestKey(row.target_scope, row.target_key)))
  for (const row of await readSessionOwnedPrRows(db, organizationId, [taskId])) {
    const key = pullRequestKey(row.repository, row.number)
    if (held.has(key)) continue
    held.add(key)
    const link: TaskLink = {
      taskId,
      kind: 'pr',
      targetScope: row.repository,
      targetKey: String(row.number),
      title: row.title || `#${row.number}`,
      url: row.url,
      createdBy: parseStoredAttribution(row.created_by) ?? { kind: 'system' },
      ownerSessionId: row.session_id,
      linkedAt: row.linked_at,
    }
    if (row.pr_state === 'missing') link.missing = true
    links.push(link)
  }
  return links.sort((left, right) => right.linkedAt - left.linkedAt)
}

/**
 * The reverse read: which tasks link each of these targets.
 *
 * This is what a conversation card asks so it can say "Linked to T-184"
 * beside the document it just rendered, and offer the way back out. It joins
 * the task row for the title and status the label needs, and nothing more —
 * the card opens the task for the rest. Targets past the cap are dropped
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
    sql`(task_links.kind = ${target.kind} AND task_links.target_scope = ${target.targetScope} AND task_links.target_key = ${target.targetKey})`), sql` OR `)
  const rows = linkedTaskRowSchema.array().parse(await db.all(sql`
    SELECT
      task_links.task_id, task_links.kind, task_links.target_scope, task_links.target_key,
      tasks.title, tasks.status, tasks.short_id, tasks.project_key
    FROM ${taskLinks}
    JOIN ${tasks} ON tasks.id = task_links.task_id
    WHERE ${scopeClause(scope, sql`tasks.organization_id`)} AND (${clause})
    ORDER BY task_links.linked_at DESC
  `))
  return rows.map((row) => {
    const linked: TaskLinkedTask = {
      taskId: row.task_id,
      kind: row.kind,
      targetScope: row.target_scope,
      targetKey: row.target_key,
      title: row.title,
      // SAFETY: `tasks.status` is written only through `assertTaskStatus`.
      status: row.status as TaskLinkedTask['status'],
      projectKey: row.project_key,
    }
    if (row.short_id !== null) linked.shortId = row.short_id
    return linked
  })
}

/**
 * Every pull request linked on a task itself, with whether live work links it
 * and what PR sync last saw. Distinct, because several tasks commonly link one
 * pull request and it is one question either way. The links that sessions own
 * are a separate read (`readSessionPullRequestWatchList`).
 */
export async function readPrLinkWatchList(db: Db, scope: RecordScope): Promise<PrLinkWatch[]> {
  const rows = prLinkWatchRowSchema.array().parse(await db.all(sql`
    SELECT task_links.target_scope, task_links.target_key, MAX(task_links.pr_state) AS pr_state,
      MAX(task_links.pr_updated_at) AS pr_updated_at,
      MAX(CASE WHEN tasks.status NOT IN ('done', 'dropped') THEN 1 ELSE 0 END) AS active
    FROM ${taskLinks}
    JOIN ${tasks} ON tasks.id = task_links.task_id
    WHERE ${scopeClause(scope, sql`tasks.organization_id`)}
      AND task_links.kind = 'pr'
      AND task_links.target_scope <> ''
    GROUP BY task_links.target_scope, task_links.target_key
  `))
  const watched: PrLinkWatch[] = []
  for (const row of rows) {
    const number = Number(row.target_key)
    if (!Number.isSafeInteger(number) || number <= 0) continue
    watched.push({
      projectScope: row.target_scope, number, isActive: row.active === 1,
      state: row.pr_state, updatedAt: row.pr_updated_at,
    })
  }
  return watched
}

/**
 * Write what PR sync saw for one pull request to every link that names it —
 * the links made on tasks and the links sessions own — and announce the tasks
 * whose own links changed. `scopes` are the link scopes that name its
 * repository: the repository key, and any local path that resolved to it. Null
 * means the code host says that the pull request does not exist.
 */
export async function recordPullRequestObservation(
  scopes: readonly string[],
  number: number,
  pullRequest: PullRequest | null,
): Promise<void> {
  if (!scopes.length) return
  // A session link names the repository key, never a local path. The host
  // announces each changed session, and the tasks that read its links.
  for (const scope of scopes) await recordSessionPullRequestObservation(scope, number, pullRequest)
  const matches = sql`kind = 'pr' AND target_key = ${String(number)}
    AND target_scope IN (${sql.join(scopes.map((scope) => sql`${scope}`), sql`, `)})`
  const rows = linkedTaskIdRowSchema.array().parse(await database().all(sql`
    SELECT DISTINCT task_id FROM ${taskLinks} WHERE ${matches}
  `))
  if (!rows.length) return
  await database().run(pullRequest
    ? sql`
      UPDATE ${taskLinks} SET
        title = ${pullRequest.title}, pr_state = ${pullRequest.state},
        pr_draft = ${pullRequest.draft ? 1 : 0}, pr_updated_at = ${pullRequest.updatedAt}
      WHERE ${matches}`
    : sql`
      UPDATE ${taskLinks} SET pr_state = 'missing', pr_draft = NULL, pr_updated_at = NULL
      WHERE ${matches}`)
  for (const row of rows) emitChanged(row.task_id)
}

/** Whether PR sync last saw this linked pull request merged. Never a network
 *  read: completion asks about a task's other links, and an unknown one is not
 *  evidence that the work is finished. */
export async function linkedPullRequestIsMerged({ projectScope, number }: PrLinkTarget): Promise<boolean> {
  const row = z.object({ pr_state: z.string().nullable() }).nullish().parse(await database().get(sql`
    SELECT pr_state FROM ${taskLinks}
    WHERE kind = 'pr' AND target_scope = ${projectScope} AND target_key = ${String(number)} AND pr_state IS NOT NULL
    LIMIT 1
  `))
  return row?.pr_state === 'merged' || await sessionPullRequestIsMerged(projectScope, number)
}

/** The part of a pull request a task card draws, as PR sync last saw it:
 *  display state, never a permission. */
function linkSnapshotOf(
  row: Pick<z.infer<typeof taskPrLinkRowSchema>, 'pr_state' | 'pr_draft' | 'pr_updated_at' | 'url' | 'title'>,
  number: number,
): TaskPrSnapshot | null {
  if (!row.pr_state || row.pr_state === 'missing' || row.pr_updated_at === null || row.url === null) return null
  const parsed = parseGitHubPullRequestUrl(row.url)
  if (!parsed) return null
  return {
    number, url: parsed.url, title: row.title,
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
    ? sql` AND task_id IN (${sql.join(taskIds.map((taskId) => sql`${taskId}`), sql`, `)})`
    : sql``
  const rows = taskPrLinkRowSchema.array().parse(await db.all(sql`
    SELECT task_id, target_scope, target_key, title, url, created_by, origin_session_id,
      pr_state, pr_draft, pr_updated_at, linked_at
    FROM ${taskLinks}
    WHERE kind = 'pr' AND ${scopeClause(scope)}${onlyTasks}
    ORDER BY linked_at DESC, task_id, target_scope, target_key DESC
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
      title: row.title,
      targetScope: row.target_scope,
      createdBy: linkCreator(row),
    }
    const snapshot = linkSnapshotOf(row, number)
    if (snapshot) link.snapshot = snapshot
    if (row.pr_state === 'missing') link.missing = true
    if (row.url !== null) link.url = row.url
    if (row.origin_session_id !== null) link.originSessionId = row.origin_session_id
    held.add(`${row.task_id}\0${pullRequestKey(row.target_scope, number)}`)
    add(row.task_id, link, row.linked_at)
  }
  for (const row of await readSessionOwnedPrRows(db, scope, taskIds)) {
    const key = `${row.task_id}\0${pullRequestKey(row.repository, row.number)}`
    if (held.has(key)) continue
    held.add(key)
    const link: TaskSidebarPrLink = {
      number: row.number,
      title: row.title || `#${row.number}`,
      targetScope: row.repository,
      url: row.url,
      createdBy: parseStoredAttribution(row.created_by) ?? { kind: 'system' },
      ownerSessionId: row.session_id,
    }
    const snapshot = linkSnapshotOf(row, row.number)
    if (snapshot) link.snapshot = snapshot
    if (row.pr_state === 'missing') link.missing = true
    add(row.task_id, link, row.linked_at)
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
    SELECT DISTINCT task_id FROM ${taskLinks}
    WHERE ${scopeClause(scope)} AND kind = 'pr'
      AND lower(target_scope) = lower(${targetScope}) AND target_key = ${String(number)}
  `))
  for (const row of rows) emitChanged(row.task_id)
}
