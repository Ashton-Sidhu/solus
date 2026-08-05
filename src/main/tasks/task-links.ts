import type { DatabaseSync } from 'node:sqlite'
import { appendTaskEvent, type EventActor } from './task-events'
import type { TaskActor, TaskLink, TaskLinkInput, TaskLinkKind } from '../../shared/task-types'

/** A task's links to docs, plans, PRs and automations.
 *
 * These are in-transaction cores, not a public API: they run inside the
 * caller's transaction and never open their own. The public surface is the
 * `Task` object's `link()` / `unlink()` / `links()`.
 */

interface TaskLinkRow {
  task_id: string
  kind: TaskLinkKind
  target_scope: string
  target_key: string
  title: string
  url: string | null
  created_by: TaskActor | 'migration'
  origin_session_id: string | null
  linked_at: number
  work_title: string | null
  work_type: string | null
  automation_title: string | null
  automation_enabled: number | null
  plan_title: string | null
  plan_status: string | null
}

/** Live title/status per kind. `work`, `plan` and `automation` all live in this
 * database, so a rename shows up immediately; `pr` state is a GitHub round trip
 * and must not make a task read network-bound, so it stays on the snapshot and
 * the renderer overlays from its own PR store. */
function liveFields(row: TaskLinkRow): { liveTitle?: string; liveStatus?: string } {
  switch (row.kind) {
    case 'work':
      return {
        ...(row.work_title === null ? {} : { liveTitle: row.work_title }),
        ...(row.work_type === null ? {} : { liveStatus: row.work_type }),
      }
    case 'automation':
      return {
        ...(row.automation_title === null ? {} : { liveTitle: row.automation_title }),
        ...(row.automation_enabled === null ? {} : { liveStatus: row.automation_enabled === 1 ? 'Active' : 'Paused' }),
      }
    case 'plan':
      return {
        ...(row.plan_title === null ? {} : { liveTitle: row.plan_title }),
        ...(row.plan_status === null ? {} : { liveStatus: row.plan_status }),
      }
    default:
      return {}
  }
}

function linkFromRow(row: TaskLinkRow): TaskLink {
  return {
    taskId: row.task_id,
    kind: row.kind,
    targetScope: row.target_scope,
    targetKey: row.target_key,
    title: row.title,
    ...(row.url === null ? {} : { url: row.url }),
    ...liveFields(row),
    createdBy: row.created_by,
    ...(row.origin_session_id === null ? {} : { originSessionId: row.origin_session_id }),
    linkedAt: row.linked_at,
  }
}

/** The snapshot label, so a row renders even once its target is gone. Resolved
 * from the target's own table when the caller did not supply one. */
function snapshotTitle(db: DatabaseSync, input: TaskLinkInput): string {
  const supplied = input.title?.trim()
  if (supplied) return supplied
  const scope = input.targetScope ?? ''
  switch (input.kind) {
    case 'work': {
      const row = db.prepare('SELECT title FROM works WHERE id = ?').get(input.targetKey) as
        { title: string | null } | undefined
      return row?.title?.trim() || 'Untitled doc'
    }
    case 'automation': {
      const row = db.prepare('SELECT name FROM automations WHERE id = ?').get(input.targetKey) as
        { name: string | null } | undefined
      return row?.name?.trim() || 'Untitled automation'
    }
    case 'plan': {
      const row = db.prepare(
        'SELECT title FROM plan_annotations WHERE session_id = ? AND plan_tool_use_id = ?',
      ).get(scope, input.targetKey) as { title: string | null } | undefined
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
  const existing = db.prepare(`
    SELECT title FROM task_links
    WHERE task_id = ? AND kind = ? AND target_scope = ? AND target_key = ?
  `).get(taskId, kind, targetScope, targetKey) as { title: string } | undefined
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
  const rows = db.prepare(`
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
  `).all(taskId) as unknown as TaskLinkRow[]
  return rows.map(linkFromRow)
}
