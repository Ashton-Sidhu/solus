import { pendingOutboxOpsFor } from '../outbox/outbox-store'
import type { OutboxOp, TaskCommentOpPayload, TaskSetStatusOpPayload } from '../../shared/outbox-types'
import type { TaskSnapshot, TaskStatus } from '../../shared/task-types'

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
    const payload = op.payload as TaskCommentOpPayload
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
    const payload = op.payload as TaskSetStatusOpPayload
    snapshot.details.task.status = payload.status as TaskStatus
  }
}
