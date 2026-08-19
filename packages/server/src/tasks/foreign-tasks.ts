import { pendingOutboxOpsFor, pendingOutboxOpsForDomain } from '../outbox/outbox-store'
import type {
  OutboxOp,
  TaskCommentOpPayload,
  TaskSetStatusOpPayload,
  WorkCreateOpPayload,
  WorkUpdateOpPayload,
} from '@solus/contracts/outbox-types'
import type { TaskLink, TaskLinkedItemSnapshot, TaskSnapshot } from '@solus/contracts/task-types'
import { z } from 'zod'

const workCreatePayloadSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  docType: z.enum(['doc', 'slides', 'diagram']),
  content: z.string(),
  agentProvider: z.string().optional(),
  originSessionId: z.string().optional(),
  cwd: z.string().optional(),
})

const workUpdatePayloadSchema = z.object({
  taskId: z.string(),
  content: z.string(),
  title: z.string().optional(),
})

const taskCommentPayloadSchema = z.object({
  body: z.string(),
  author: z.string(),
  originSessionId: z.string().optional(),
})

const taskStatusPayloadSchema = z.object({
  status: z.enum(['inbox', 'todo', 'in_progress', 'in_review', 'done', 'dropped']),
  actorLabel: z.string().optional(),
})

const taskIdPayloadSchema = z.object({ taskId: z.string() })

/**
 * Foreign tasks on the execution host: the per-session snapshot a dispatched
 * prompt shipped (see docs/plans/dispatch-parity.md). The snapshot is the only
 * task state this host has — the row lives on another machine — so the packet
 * renders from it and `read_task` answers from it.
 *
 * Reads see the agent's own undelivered writes: a recorded op is applied to the
 * held snapshot immediately, and a fresh snapshot (re-shipped with every
 * prompt) is overlaid with whatever ops are still pending in the outbox, so the
 * view converges no matter which of delivery or re-shipment happens first.
 */

const snapshotsBySession = new Map<string, TaskSnapshot>()

/** Hold (or replace) a session's shipped snapshot, overlaid with its still-
 *  pending outbox ops. Null clears — a prompt that shipped no snapshot must not
 *  leave a previous task's state answering reads. */
export function setForeignTaskSnapshot(sessionId: string, snapshot: TaskSnapshot | null): void {
  if (!snapshot) {
    snapshotsBySession.delete(sessionId)
    return
  }
  const overlaid = structuredClone(snapshot)
  for (const op of pendingOutboxOpsFor('tasks', snapshot.details.task.id)) {
    applyOpToSnapshot(overlaid, op)
  }
  // Works ops are keyed by work id, so the task's are found through payload:
  // a still-pending create/update must stay visible on the fresh snapshot the
  // owner host rendered before the op drained.
  for (const op of pendingOutboxOpsForDomain('works')) {
    const payload = taskIdPayloadSchema.safeParse(op.payload)
    if (payload.success && payload.data.taskId === snapshot.details.task.id) applyWorkOpToSnapshot(overlaid, op)
  }
  snapshotsBySession.set(sessionId, overlaid)
}

/** The session's foreign task, when `taskId` names it. A non-matching id is not
 *  this session's task and answers nothing — foreign reads are scoped to the
 *  one task the dispatch carried. */
export function foreignTaskFor(sessionId: string | undefined, taskId: string): TaskSnapshot | null {
  if (!sessionId) return null
  const snapshot = snapshotsBySession.get(sessionId)
  return snapshot && snapshot.details.task.id === taskId ? snapshot : null
}

/** The content-bearing linked items the session's snapshot shipped — the only
 *  copies of those works and plans this host has. Read-only: the rows live on
 *  the task's host. */
export function foreignLinkedItemsFor(sessionId: string | undefined): TaskLinkedItemSnapshot[] {
  if (!sessionId) return []
  return snapshotsBySession.get(sessionId)?.linked ?? []
}

/** One shipped item by kind and key, when the session's snapshot carries it.
 *  `scope` narrows plans to their owning session; works pass none. */
export function foreignLinkedItemFor(
  sessionId: string | undefined,
  kind: TaskLinkedItemSnapshot['kind'],
  key: string,
  scope?: string,
): TaskLinkedItemSnapshot | null {
  return foreignLinkedItemsFor(sessionId).find(
    (item) => item.kind === kind && item.key === key && (scope === undefined || item.scope === scope),
  ) ?? null
}

/** Every link the session's foreign task carries (all kinds) — how PR and
 *  automation tools answer for targets whose rows live on the task's host. */
export function foreignTaskLinksFor(sessionId: string | undefined): TaskLink[] {
  if (!sessionId) return []
  return snapshotsBySession.get(sessionId)?.details.links ?? []
}

/** The session's foreign task id, when a dispatch shipped one — the marker
 *  work tools use to route writes through the outbox instead of local stores. */
export function foreignTaskIdFor(sessionId: string | undefined): string | null {
  if (!sessionId) return null
  return snapshotsBySession.get(sessionId)?.details.task.id ?? null
}

/** Fold a just-recorded works op into the held snapshot so the agent reads its
 *  own create/update back before the courier delivers it. */
export function applyWorkOpToForeignTask(sessionId: string | undefined, op: OutboxOp): void {
  if (!sessionId) return
  const snapshot = snapshotsBySession.get(sessionId)
  if (!snapshot) return
  applyWorkOpToSnapshot(snapshot, op)
}

function applyWorkOpToSnapshot(snapshot: TaskSnapshot, op: OutboxOp): void {
  snapshot.linked ??= []
  const existing = snapshot.linked.find((item) => item.kind === 'work' && item.key === op.resourceId)
  if (op.name === 'create') {
    const parsed = workCreatePayloadSchema.safeParse(op.payload)
    if (!parsed.success) return
    const payload: WorkCreateOpPayload = parsed.data
    if (existing) {
      existing.title = payload.title
      existing.content = payload.content
      return
    }
    snapshot.linked.push({
      kind: 'work',
      key: op.resourceId,
      scope: '',
      title: payload.title,
      workType: payload.docType,
      content: payload.content,
    })
    return
  }
  if (op.name === 'update' && existing) {
    const parsed = workUpdatePayloadSchema.safeParse(op.payload)
    if (!parsed.success) return
    const payload: WorkUpdateOpPayload = parsed.data
    existing.content = payload.content
    if (payload.title !== undefined) existing.title = payload.title
  }
}

/** Forget a session's snapshot when the session itself is torn down. */
export function clearForeignTaskSnapshot(sessionId: string): void {
  snapshotsBySession.delete(sessionId)
}

/** Fold a just-recorded op into the held snapshot so the agent reads its own
 *  write back before delivery. */
export function applyOpToForeignTask(sessionId: string | undefined, op: OutboxOp): void {
  if (!sessionId) return
  const snapshot = snapshotsBySession.get(sessionId)
  if (!snapshot || snapshot.details.task.id !== op.resourceId) return
  applyOpToSnapshot(snapshot, op)
}

function applyOpToSnapshot(snapshot: TaskSnapshot, op: OutboxOp): void {
  if (op.name === 'comment') {
    const parsed = taskCommentPayloadSchema.safeParse(op.payload)
    if (!parsed.success) return
    const payload: TaskCommentOpPayload = parsed.data
    snapshot.details.comments.push({
      id: op.id,
      taskId: snapshot.details.task.id,
      author: payload.author,
      source: 'local',
      originSessionId: payload.originSessionId ?? op.sessionId ?? null,
      body: payload.body,
      createdAt: op.recordedAt,
    })
    return
  }
  if (op.name === 'set-status') {
    const parsed = taskStatusPayloadSchema.safeParse(op.payload)
    if (!parsed.success) return
    const payload: TaskSetStatusOpPayload = parsed.data
    snapshot.details.task.status = payload.status
  }
}
