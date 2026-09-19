import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { PullRequest } from '@solus/contracts/providers'
import type { Db } from '../db/database'
import { prIndex } from '../prs/pr-index'
import { appendTaskEvent, type EventActor } from './task-events'
import { linkTargetRecordKey, linkTargetRecordsFor } from './host-records'
import { taskLinks, tasks } from './schema'
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
  created_by: z.enum(['user', 'agent', 'automation', 'system', 'migration']),
  origin_session_id: z.string().nullable(),
  linked_at: z.number(),
  pinned: z.number(),
})
const titleRowSchema = z.object({ title: z.string() })
const taskPrLinkRowSchema = z.object({
  task_id: z.string(),
  target_scope: z.string(),
  target_key: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  created_by: z.enum(['user', 'agent', 'automation', 'system', 'migration']),
  origin_session_id: z.string().nullable(),
})

const prLinkTargetRowSchema = z.object({
  target_scope: z.string(),
  target_key: z.string(),
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

interface TaskSidebarPrLinks {
  [taskId: string]: TaskSidebarPrLink[]
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
    createdBy: row.created_by,
    linkedAt: row.linked_at,
  }
  const record = live.get(linkTargetRecordKey({ kind: row.kind, targetScope: row.target_scope, targetKey: row.target_key }))
  if (record?.title !== null && record?.title !== undefined) link.liveTitle = record.title
  if (record?.status !== null && record?.status !== undefined) link.liveStatus = record.status
  if (row.url !== null) link.url = row.url
  if (row.origin_session_id !== null) link.originSessionId = row.origin_session_id
  if (row.pinned === 1) link.pinned = true
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

export async function writeTaskLink(
  db: Db,
  organizationId: string,
  taskId: string,
  input: TaskLinkInput,
  actor: EventActor = {},
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
      origin_session_id, linked_at, pinned, organization_id
    ) VALUES (
      ${taskId}, ${input.kind}, ${targetScope}, ${targetKey}, ${title}, ${input.url?.trim() || null},
      ${input.createdBy ?? actor.actor ?? 'user'}, ${input.originSessionId?.trim() || null}, ${now},
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
  await appendTaskEvent(db, organizationId, taskId, {
    ...actor,
    kind: 'linked',
    targetKind: input.kind,
    targetScope,
    targetKey,
    targetTitle: title,
  }, now)
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
  actor: EventActor = {},
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
  await appendTaskEvent(db, organizationId, taskId, {
    ...actor,
    kind: 'unlinked',
    targetKind: kind,
    targetScope,
    targetKey,
    targetTitle: existing.title,
  }, now)
  return true
}

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
  return rows.map((row) => linkFromRow(row, live))
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
  organizationId: string,
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
    WHERE tasks.organization_id = ${organizationId} AND (${clause})
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
 * Every pull request linked to work that is still going, by project.
 *
 * The reconciler's watch list: a pull request nobody's task points at has no
 * Solus surface to go stale, and a task that is done or dropped has stopped
 * asking what became of its pull request. Distinct, because several tasks
 * commonly link one pull request and it is one question either way.
 */
export async function readActivePrLinkTargets(db: Db, organizationId: string): Promise<PrLinkTarget[]> {
  const rows = prLinkTargetRowSchema.array().parse(await db.all(sql`
    SELECT DISTINCT task_links.target_scope, task_links.target_key
    FROM ${taskLinks}
    JOIN ${tasks} ON tasks.id = task_links.task_id
    WHERE tasks.organization_id = ${organizationId}
      AND task_links.kind = 'pr'
      AND tasks.status NOT IN ('done', 'dropped')
      AND task_links.target_scope <> ''
  `))
  const targets: PrLinkTarget[] = []
  for (const row of rows) {
    const number = Number(row.target_key)
    if (!Number.isSafeInteger(number) || number <= 0) continue
    targets.push({ projectScope: row.target_scope, number })
  }
  return targets
}

/** The part of a pull request a task card draws: display state, never a permission. */
function toTaskPrSnapshot(detail: PullRequest): TaskPrSnapshot {
  return {
    number: detail.number, url: detail.url, title: detail.title,
    state: detail.state, draft: detail.draft, updatedAt: detail.updatedAt,
    baseRepo: { ...detail.baseRepo },
  }
}

/** Compact PR edges for the sidebar's cold-start snapshot. Links are newest
 * first. Invalid legacy keys stay out of the renderer contract. */
export async function readTaskPrLinks(db: Db, organizationId: string): Promise<TaskSidebarPrLinks> {
  const rows = taskPrLinkRowSchema.array().parse(await db.all(sql`
    SELECT task_id, target_scope, target_key, title, url, created_by, origin_session_id
    FROM ${taskLinks}
    WHERE kind = 'pr' AND organization_id = ${organizationId}
    ORDER BY linked_at DESC, task_id, target_scope, target_key DESC
  `))
  const links: TaskSidebarPrLinks = {}
  for (const row of rows) {
    const number = Number(row.target_key)
    if (!Number.isSafeInteger(number) || number <= 0) continue
    const link: TaskSidebarPrLink = {
      number,
      title: row.title,
      targetScope: row.target_scope,
      createdBy: row.created_by,
    }
    const detail = prIndex.lastRead(row.target_scope, number)
    if (detail) link.snapshot = toTaskPrSnapshot(detail)
    if (row.url !== null) link.url = row.url
    if (row.origin_session_id !== null) link.originSessionId = row.origin_session_id
    const taskPrLinks = links[row.task_id]
    if (taskPrLinks) taskPrLinks.push(link)
    else links[row.task_id] = [link]
  }
  return links
}
