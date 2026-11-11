import { z } from 'zod'
import type { OutboxOp } from '@solus/contracts/outbox-types'
import { attributionSchema } from '@solus/contracts/user'
import { parseTaskKey } from '@solus/contracts/task-sources'
import { PermanentApplyError, registerOutboxApplier } from '../../sync/outbox/outbox-store'
import { commentOnTask, moveTaskToStatus } from './task'

const taskCommentPayloadSchema = z.object({ body: z.string(), author: attributionSchema, originSessionId: z.string().optional() })
/** `status` is a status category or the name of a column (`moveTaskToStatus`). */
const taskStatusPayloadSchema = z.object({ status: z.string() })

/**
 * Owner-side writes for `tasks` outbox ops (ADR-0007): a dispatched session's
 * comment and status change, applied on the host that reads the task as
 * provider writes. A comment survives redelivery: it is kept under the op id,
 * so a second delivery makes no second row. A move to a category the task has
 * already is a no-op.
 */
export function registerTaskOutboxApplier(): void {
  registerOutboxApplier('tasks', async (op: OutboxOp, { organizationId }) => {
    if (!parseTaskKey(op.resourceId)) throw new PermanentApplyError(`"${op.resourceId}" is not a task of GitHub or Jira.`)
    if (op.name === 'comment') {
      const payload = taskCommentPayloadSchema.parse(op.payload)
      await commentOnTask(organizationId, op.resourceId, {
        id: op.id,
        body: payload.body,
        by: payload.author,
        originSessionId: payload.originSessionId ?? op.sessionId ?? null,
      })
      return
    }
    if (op.name === 'set-status') {
      await moveTaskToStatus(op.resourceId, taskStatusPayloadSchema.parse(op.payload).status)
      return
    }
    // An unknown verb is a version-skew problem a retry may fix once this host
    // updates, so it is deliberately not permanent.
    throw new Error(`Unknown tasks outbox op "${op.name}".`)
  })
}
