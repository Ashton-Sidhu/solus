import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { appendTaskEvent, type EventActor } from './task-events'
import type {
  TaskLink,
  TaskLinkInput,
  TaskLinkKind,
  TaskSidebarPrLink,
} from '../../shared/task-types'

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
  work_title: z.string().nullable(),
  work_type: z.string().nullable(),
  automation_title: z.string().nullable(),
  automation_enabled: z.number().nullable(),
  plan_title: z.string().nullable(),
  plan_status: z.string().nullable(),
})
const nullableTitleRowSchema = z.object({ title: z.string().nullable() })
const titleRowSchema = z.object({ title: z.string() })
const taskPrLinkRowSchema = z.object({
  task_id: z.string(),
  target_key: z.string(),
  url: z.string().nullable(),
})

type TaskLinkRow = z.infer<typeof taskLinkRowSchema>

interface LiveTaskLinkFields {
  liveTitle?: string
  liveStatus?: string
}

interface TaskSidebarPrLinks {
  [taskId: string]: TaskSidebarPrLink
}

/** Live title/status per kind. `work`, `plan` and `automation` all live in this
 * database, so a rename shows up immediately; `pr` state is a GitHub round trip
 * and must not make a task read network-bound, so it stays on the snapshot and
 * the renderer overlays from its own PR store. */
function liveFields(row: TaskLinkRow): LiveTaskLinkFields {
  const fields: LiveTaskLinkFields = {}
  switch (row.kind) {
    case 'work':
      if (row.work_title !== null) fields.liveTitle = row.work_title
      if (row.work_type !== null) fields.liveStatus = row.work_type
      return fields
    case 'automation':
      if (row.automation_title !== null) fields.liveTitle = row.automation_title
      if (row.automation_enabled !== null) fields.liveStatus = row.automation_enabled === 1 ? 'Active' : 'Paused'
      return fields
    case 'plan':
      if (row.plan_title !== null) fields.liveTitle = row.plan_title
      if (row.plan_status !== null) fields.liveStatus = row.plan_status
      return fields
    default:
      return fields
  }
}

function linkFromRow(row: TaskLinkRow): TaskLink {
  const link: TaskLink = {
    taskId: row.task_id,
    kind: row.kind,
    targetScope: row.target_scope,
    targetKey: row.target_key,
    title: row.title,
    ...liveFields(row),
    createdBy: row.created_by,
    linkedAt: row.linked_at,
  }
  if (row.url !== null) link.url = row.url
  if (row.origin_session_id !== null) link.originSessionId = row.origin_session_id
  return link
}

/** The snapshot label, so a row renders even once its target is gone. Resolved
 * from the target's own table when the caller did not supply one. */
function snapshotTitle(db: DatabaseSync, input: TaskLinkInput): string {
  const supplied = input.title?.trim()
  if (supplied) return supplied
  const scope = input.targetScope ?? ''
  switch (input.kind) {
    case 'work': {
      const row = nullableTitleRowSchema.nullish().parse(
        db.prepare('SELECT title FROM works WHERE id = ?').get(input.targetKey),
      )
      return row?.title?.trim() || 'Untitled doc'
    }
    case 'automation': {
      const row = z.object({ name: z.string().nullable() }).nullish().parse(
        db.prepare('SELECT name FROM automations WHERE id = ?').get(input.targetKey),
      )
      return row?.name?.trim() || 'Untitled automation'
    }
    case 'plan': {
      const row = nullableTitleRowSchema.nullish().parse(db.prepare(
        'SELECT title FROM plan_annotations WHERE session_id = ? AND plan_tool_use_id = ?',
      ).get(scope, input.targetKey))
      return row?.title?.trim() || 'Untitled plan'
    }
    case 'pr':
      return `#${input.targetKey}`
  }
}

export function writeTaskLink(
  db: DatabaseSync,
  taskId: string,
  input: TaskLinkInput,
  actor: EventActor = {},
  now = Date.now(),
): void {
  const targetKey = input.targetKey.trim()
  if (!targetKey) throw new Error('A task link needs a target.')
  const targetScope = (input.targetScope ?? '').trim()
  const title = snapshotTitle(db, { ...input, targetKey, targetScope })

  db.prepare(`
    INSERT INTO task_links(
      task_id, kind, target_scope, target_key, title, url, created_by,
      origin_session_id, linked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, kind, target_scope, target_key) DO UPDATE SET
      title = excluded.title,
      url = COALESCE(excluded.url, task_links.url),
      linked_at = excluded.linked_at
  `).run(
    taskId,
    input.kind,
    targetScope,
    targetKey,
    title,
    input.url?.trim() || null,
    input.createdBy ?? actor.actor ?? 'user',
    input.originSessionId?.trim() || null,
    now,
  )
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
  appendTaskEvent(db, taskId, {
    ...actor,
    kind: 'linked',
    targetKind: input.kind,
    targetScope,
    targetKey,
    targetTitle: title,
  }, now)
}

/** Returns false when there was nothing to unlink, so the caller can skip the
 * change broadcast on a no-op. */
export function deleteTaskLink(
  db: DatabaseSync,
  taskId: string,
  kind: TaskLinkKind,
  targetKey: string,
  targetScope = '',
  actor: EventActor = {},
  now = Date.now(),
): boolean {
  const existing = titleRowSchema.nullish().parse(db.prepare(`
    SELECT title FROM task_links
    WHERE task_id = ? AND kind = ? AND target_scope = ? AND target_key = ?
  `).get(taskId, kind, targetScope, targetKey))
  if (!existing) return false

  db.prepare(`
    DELETE FROM task_links
    WHERE task_id = ? AND kind = ? AND target_scope = ? AND target_key = ?
  `).run(taskId, kind, targetScope, targetKey)
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId)
  // Carries the title so the feed still reads "unlinked <name>" afterwards.
  appendTaskEvent(db, taskId, {
    ...actor,
    kind: 'unlinked',
    targetKind: kind,
    targetScope,
    targetKey,
    targetTitle: existing.title,
  }, now)
  return true
}

export function readTaskLinks(db: DatabaseSync, taskId: string): TaskLink[] {
  const rows = taskLinkRowSchema.array().parse(db.prepare(`
    SELECT
      task_links.*,
      works.title AS work_title,
      works.type AS work_type,
      automations.name AS automation_title,
      automations.enabled AS automation_enabled,
      plan_annotations.title AS plan_title,
      plan_annotations.status AS plan_status
    FROM task_links
    LEFT JOIN works
      ON task_links.kind = 'work' AND works.id = task_links.target_key
    LEFT JOIN automations
      ON task_links.kind = 'automation' AND automations.id = task_links.target_key
    LEFT JOIN plan_annotations
      ON task_links.kind = 'plan'
     AND plan_annotations.session_id = task_links.target_scope
     AND plan_annotations.plan_tool_use_id = task_links.target_key
    WHERE task_links.task_id = ?
    ORDER BY task_links.linked_at DESC, task_links.kind, task_links.target_key
  `).all(taskId))
  return rows.map(linkFromRow)
}

/** One compact PR edge per task for the sidebar's cold-start snapshot. Links
 * are newest-first because the task surface treats the most recent PR link as
 * the active one. Invalid legacy keys stay out of the renderer contract. */
export function readLatestTaskPrLinks(db: DatabaseSync): TaskSidebarPrLinks {
  const rows = taskPrLinkRowSchema.array().parse(db.prepare(`
    SELECT task_id, target_key, url
    FROM task_links
    WHERE kind = 'pr'
    ORDER BY linked_at DESC, rowid DESC
  `).all())
  const links: TaskSidebarPrLinks = {}
  for (const row of rows) {
    if (links[row.task_id]) continue
    const number = Number(row.target_key)
    if (!Number.isSafeInteger(number) || number <= 0) continue
    const link: TaskSidebarPrLink = { number }
    if (row.url !== null) link.url = row.url
    links[row.task_id] = link
  }
  return links
}
