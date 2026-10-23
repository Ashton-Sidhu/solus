import { Task } from './task'
import { PermanentApplyError, registerOutboxApplier } from '../../sync/outbox/outbox-store'
import type { OutboxOp } from '@solus/contracts/outbox-types'
import { z } from 'zod'
import { attributionSchema, type Attribution } from '@solus/contracts/user'
import { agentAttribution } from '../stored-attribution'
import { legacyTaskActor } from './task-activity'

const taskStatusSchema = z.enum(['inbox', 'todo', 'in_progress', 'in_review', 'done', 'dropped'])
/** An op recorded before plan 012 stage 4 names its author by label (`'agent'`) and its actor by session id. */
const taskCommentPayloadSchema = z.union([
  z.object({ body: z.string(), author: attributionSchema, originSessionId: z.string().optional() }),
  z.object({ body: z.string(), author: z.string(), originSessionId: z.string().optional() })
    .transform((payload) => ({ ...payload, author: legacyTaskActor(payload.author, payload.originSessionId ?? null) })),
])
const taskStatusPayloadSchema = z.object({
  status: taskStatusSchema,
  actor: attributionSchema.optional(),
  actorLabel: z.string().optional(),
})
/** Who an op says did it: its attribution, or for an older op the agent its label or session names. */
function opActor(payload: { actor?: Attribution; actorLabel?: string }, op: OutboxOp): Attribution {
  return payload.actor ?? agentAttribution(payload.actorLabel ?? op.sessionId)
}

/**
 * Owner-side writes for `tasks` outbox ops (ADR-0007): a dispatched session's
 * comment and status change, applied on the host that owns the task. Every verb
 * survives redelivery: a comment inserts under the op id (`INSERT OR IGNORE`),
 * and set-status re-applies to the same value.
 */
export function registerTaskOutboxApplier(): void {
  registerOutboxApplier('tasks', async (op: OutboxOp, { organizationId }) => {
    const task = await taskOrPermanentError(organizationId, op.resourceId)
    if (op.name === 'comment') {
      const payload = taskCommentPayloadSchema.parse(op.payload)
      const originSessionId = payload.originSessionId ?? op.sessionId ?? null
      await task.comment(payload.body, {
        id: op.id,
        by: payload.author,
        originSessionId,
      })
      return
    }
    if (op.name === 'set-status') {
      const payload = taskStatusPayloadSchema.parse(op.payload)
      await task.update({ status: payload.status }, opActor(payload, op))
      return
    }
    // An unknown verb is a version-skew problem a retry may fix once this host
    // updates, so it is deliberately not permanent.
    throw new Error(`Unknown tasks outbox op "${op.name}".`)
  })
}

/** An op is applied in the organization that owns the task; a task gone from there is gone for good. */
async function taskOrPermanentError(organizationId: string, taskId: string): Promise<Task> {
  try {
    return await Task.byId(organizationId, taskId)
  } catch {
    throw new PermanentApplyError(`Task ${taskId} no longer exists on its owner host.`)
  }
}
