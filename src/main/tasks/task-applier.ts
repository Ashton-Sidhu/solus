import { Task } from './task'
import { PermanentApplyError, registerOutboxApplier } from '../outbox/outbox-store'
import type { OutboxOp, TaskCommentOpPayload, TaskSetStatusOpPayload } from '../../shared/outbox-types'
import type { TaskStatus } from '../../shared/task-types'

/**
 * Owner-side writes for `tasks` outbox ops (ADR-0007). Registered on every
 * host — any host can own tasks. Both verbs survive redelivery: a comment
 * inserts under the op id (`INSERT OR IGNORE`), and set-status re-applies to
 * the same value.
 */
export function registerTaskOutboxApplier(): void {
  registerOutboxApplier('tasks', async (op: OutboxOp) => {
    const task = await taskOrPermanentError(op.resourceId)
    if (op.name === 'comment') {
      const payload = op.payload as TaskCommentOpPayload
      await task.comment(payload.body, {
        id: op.id,
        author: payload.author,
        originSessionId: payload.originSessionId ?? op.sessionId ?? null,
      })
      return
    }
    if (op.name === 'set-status') {
      const payload = op.payload as TaskSetStatusOpPayload
      await task.update(
        { status: payload.status as TaskStatus },
        { actor: 'agent', actorLabel: payload.actorLabel ?? op.sessionId },
      )
      return
    }
    // An unknown verb is a version-skew problem a retry may fix once this host
    // updates, so it is deliberately not permanent.
    throw new Error(`Unknown tasks outbox op "${op.name}".`)
  })
}

async function taskOrPermanentError(taskId: string): Promise<Task> {
  try {
    return await Task.byId(taskId)
  } catch {
    throw new PermanentApplyError(`Task ${taskId} no longer exists on its owner host.`)
  }
}
