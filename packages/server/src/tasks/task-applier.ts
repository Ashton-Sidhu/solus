import { Task } from './task'
import { PermanentApplyError, registerOutboxApplier } from '../outbox/outbox-store'
import type { OutboxOp } from '@solus/contracts/outbox-types'
import { z } from 'zod'

const taskCommentPayloadSchema = z.object({
  body: z.string(),
  author: z.string(),
  originSessionId: z.string().optional(),
})
const taskStatusPayloadSchema = z.object({
  status: z.enum(['inbox', 'todo', 'in_progress', 'in_review', 'done', 'dropped']),
  actorLabel: z.string().optional(),
})

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
      const payload = taskCommentPayloadSchema.parse(op.payload)
      await task.comment(payload.body, {
        id: op.id,
        author: payload.author,
        originSessionId: payload.originSessionId ?? op.sessionId ?? null,
      })
      return
    }
    if (op.name === 'set-status') {
      const payload = taskStatusPayloadSchema.parse(op.payload)
      await task.update(
        { status: payload.status },
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
