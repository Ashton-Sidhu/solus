import { z } from 'zod'
import type { Db } from '../../db/database'
import type { Activity, TaskEventTarget } from '@solus/contracts/activity'
import type { TaskEventKind } from '@solus/contracts/task-types'
import { parseUserKey, type Attribution } from '@solus/contracts/user'
import { LOCAL_ORGANIZATION_ID } from '../../host/host-category'
import { isHostUserKey } from '../../host/host-user'
import { appendActivity, newActivity } from '../activity/activity'
import { agentAttribution, hostAttribution } from '../stored-attribution'
import { recordNotification } from '../notifications/store'

/** Cap on the activity returned with a task's details. The feed is a page, not
 * an archive; deep history would get its own paged read if anything asked. */
export const TASK_ACTIVITY_LIMIT = 200

/** The subset of a `tasks` row that carries user-visible history. */
interface TaskFieldsForDiff {
  status: string
  priority: string | null
  assignee: string | null
  due_date: string | null
  title: string
  labels: string
}

/**
 * Who a row written before plan 012 stage 4 names by label: `'user'` was someone
 * in the app, the host's user (right on a personal host, a guess on a shared
 * one); an agent's and an automation's label is its session id or name.
 */
export function legacyTaskActor(actor: string, label: string | null): Attribution {
  switch (actor) {
    case 'agent': return agentAttribution(label)
    case 'automation': return label ? { kind: 'automation', automationId: '', name: label } : { kind: 'automation', automationId: '' }
    case 'system':
    case 'migration': return { kind: 'system' }
    default: return hostAttribution()
  }
}

/** One `task_changed` activity (plans/012 §5). Append it inside the transaction of the change it records. */
export function taskChanged(
  taskId: string,
  by: Attribution,
  change: TaskEventKind,
  fields: { from?: string | null; to?: string | null; target?: TaskEventTarget } = {},
  now = Date.now(),
): Activity {
  return newActivity({ kind: 'task', id: taskId }, by, { kind: 'task_changed', change, ...fields }, now)
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

const DIFFED_FIELDS: Array<{ column: keyof TaskFieldsForDiff; change: TaskEventKind }> = [
  { column: 'status', change: 'status_changed' },
  { column: 'priority', change: 'priority_changed' },
  { column: 'assignee', change: 'assignee_changed' },
  { column: 'due_date', change: 'due_date_changed' },
  { column: 'title', change: 'title_changed' },
  { column: 'labels', change: 'labels_changed' },
]

/** Derive field-change activity by diffing two `tasks` rows, inside the caller's
 * transaction. This is the single place field history is produced: every
 * mutation path re-reads the row before and after and hands both here, so no
 * caller can forget a change.
 *
 * `body`, `pr`, `project_key` and the timestamps are deliberately not logged —
 * body edits would flood the feed and the rest is machine bookkeeping nobody
 * asked to see. */
export async function diffTaskActivity(
  db: Db,
  organizationId: string,
  taskId: string,
  before: TaskFieldsForDiff,
  after: TaskFieldsForDiff,
  by: Attribution,
  now = Date.now(),
): Promise<void> {
  for (const field of DIFFED_FIELDS) {
    const from = field.column === 'labels' ? sortedLabels(before.labels) : before[field.column]
    const to = field.column === 'labels' ? sortedLabels(after.labels) : after[field.column]
    if (from === to) continue
    await appendActivity(organizationId, taskChanged(taskId, by, field.change, { from, to }, now), db)
  }
}

/**
 * A native task's Solus assignee changed (plans/015-notifications-hub.md §5):
 * the new person is told. Whether the task is still theirs is the task's own
 * answer. Only the typed `assignee_user_id` names a person; a provider login in
 * `assignee` never does. Inside the caller's transaction.
 */
export async function notifyTaskAssignment(
  db: Db,
  organizationId: string,
  task: { id: string; title: string },
  before: string | null,
  after: string | null,
  by: Attribution,
  now = Date.now(),
): Promise<void> {
  if (before === after || !after) return
  const resource = { kind: 'task' as const, taskId: task.id }
  await recordNotification(db, {
    organizationId, eventId: `task.assigned:${task.id}:${after}:${now}`, recipients: [after], resource, by,
    facts: { kind: 'task.assigned' }, summary: { title: task.title.slice(0, 300) }, createdAt: now,
  })
}

/**
 * Whom a task may name as its Solus assignee. A Local task has no members: only
 * the host's user. An organization task names an account; a guest or a local
 * owner key is not a member. Membership itself is the directory's answer on the
 * client, as for review requests; the server never infers it from a name.
 */
export function assertTaskAssignee(organizationId: string, assigneeUserId: string | null | undefined): void {
  if (!assigneeUserId) return
  if (organizationId === LOCAL_ORGANIZATION_ID) {
    if (!isHostUserKey(assigneeUserId)) throw new Error('A Local task can be assigned only to this host\'s user.')
    return
  }
  if (parseUserKey(assigneeUserId).kind !== 'account') throw new Error('An organization task can be assigned only to a member account.')
}
