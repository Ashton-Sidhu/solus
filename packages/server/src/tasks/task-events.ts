import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { ulid } from './ulid'
import type { TaskActor, TaskEvent, TaskEventKind, TaskLinkKind } from '@solus/contracts/task-types'

/** Cap on the events returned with a task's details. The activity feed is a
 * page, not an archive; deep history would get its own paged read if anything
 * ever asked for it. */
const TASK_EVENT_LIMIT = 200

export interface EventActor {
  actor?: TaskActor
  actorLabel?: string | null
}

interface TaskEventInput extends EventActor {
  kind: TaskEventKind
  from?: string | null
  to?: string | null
  targetKind?: TaskLinkKind | 'session'
  targetScope?: string | null
  targetKey?: string | null
  targetTitle?: string | null
}

/** The subset of a `tasks` row that carries user-visible history. */
interface TaskFieldsForDiff {
  status: string
  priority: string | null
  assignee: string | null
  due_date: string | null
  title: string
  parent_id: string | null
  labels: string
}

const taskEventRowSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  kind: z.enum([
    'created', 'status_changed', 'priority_changed', 'assignee_changed',
    'due_date_changed', 'title_changed', 'parent_changed', 'labels_changed',
    'linked', 'unlinked', 'session_started', 'snoozed', 'woke',
  ]),
  actor: z.enum(['user', 'agent', 'automation', 'system']),
  actor_label: z.string().nullable(),
  from_value: z.string().nullable(),
  to_value: z.string().nullable(),
  target_kind: z.enum(['work', 'plan', 'pr', 'automation', 'session']).nullable(),
  target_scope: z.string().nullable(),
  target_key: z.string().nullable(),
  target_title: z.string().nullable(),
  created_at: z.number(),
})

type TaskEventRow = z.infer<typeof taskEventRowSchema>

function eventFromRow(row: TaskEventRow): TaskEvent {
  const event: TaskEvent = {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    actor: row.actor,
    createdAt: row.created_at,
  }
  if (row.actor_label !== null) event.actorLabel = row.actor_label
  if (row.from_value !== null) event.from = row.from_value
  if (row.to_value !== null) event.to = row.to_value
  if (row.target_kind !== null) event.targetKind = row.target_kind
  if (row.target_scope !== null) event.targetScope = row.target_scope
  if (row.target_key !== null) event.targetKey = row.target_key
  if (row.target_title !== null) event.targetTitle = row.target_title
  return event
}

/** Append one event inside the caller's transaction. This never opens its own:
 * an event must commit or roll back with the mutation that caused it. */
export function appendTaskEvent(
  db: DatabaseSync,
  taskId: string,
  event: TaskEventInput,
  now = Date.now(),
): void {
  db.prepare(`
    INSERT INTO task_events(
      id, task_id, kind, actor, actor_label, from_value, to_value,
      target_kind, target_scope, target_key, target_title, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ulid(now),
    taskId,
    event.kind,
    event.actor ?? 'user',
    event.actorLabel ?? null,
    event.from ?? null,
    event.to ?? null,
    event.targetKind ?? null,
    event.targetScope ?? null,
    event.targetKey ?? null,
    event.targetTitle ?? null,
    now,
  )
}

/** Label sets compare as sets, so reordering the same labels is not history. */
function sortedLabels(value: string): string {
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(value))
    if (!parsed.success) return value
    return JSON.stringify([...parsed.data].sort())
  } catch {
    return value
  }
}

const DIFFED_FIELDS: Array<{ column: keyof TaskFieldsForDiff; kind: TaskEventKind }> = [
  { column: 'status', kind: 'status_changed' },
  { column: 'priority', kind: 'priority_changed' },
  { column: 'assignee', kind: 'assignee_changed' },
  { column: 'due_date', kind: 'due_date_changed' },
  { column: 'title', kind: 'title_changed' },
  { column: 'parent_id', kind: 'parent_changed' },
  { column: 'labels', kind: 'labels_changed' },
]

/** Derive field-change events by diffing two `tasks` rows. This is the single
 * place field history is produced: every mutation path re-reads the row before
 * and after and hands both here, so no caller can forget an event kind.
 *
 * `body`, `pr`, `project_key` and the timestamps are
 * deliberately not logged — body edits would flood the feed and the rest is
 * machine bookkeeping nobody asked to see. */
export function diffTaskEvents(
  db: DatabaseSync,
  taskId: string,
  before: TaskFieldsForDiff,
  after: TaskFieldsForDiff,
  actor: EventActor = {},
  now = Date.now(),
): void {
  for (const field of DIFFED_FIELDS) {
    const from = field.column === 'labels' ? sortedLabels(before.labels) : before[field.column]
    const to = field.column === 'labels' ? sortedLabels(after.labels) : after[field.column]
    if (from === to) continue
    appendTaskEvent(db, taskId, { ...actor, kind: field.kind, from, to }, now)
  }
}

/** Oldest-first, capped to the newest `TASK_EVENT_LIMIT` entries. */
export function readTaskEvents(db: DatabaseSync, taskId: string): TaskEvent[] {
  const rows = z.array(taskEventRowSchema).parse(db.prepare(`
    SELECT * FROM task_events
    WHERE task_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(taskId, TASK_EVENT_LIMIT))
  return rows.reverse().map(eventFromRow)
}
