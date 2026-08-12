import { createWork, loadWork, agentSaveWork } from './works'
import { workPreview } from '../../shared/work-preview'
import { Task } from '../tasks/task'
import { PermanentApplyError, registerOutboxApplier } from '../outbox/outbox-store'
import { createLogger } from '../logger'
import type { OutboxOp, WorkCreateOpPayload, WorkUpdateOpPayload } from '../../shared/outbox-types'
import type { AgentId } from '../../shared/types'

const log = createLogger('folio', 'work-applier.ts')

/**
 * Owner-side writes for `works` outbox ops (ADR-0007): a dispatched session's
 * works belong to its task's host, and these land them there. Registered on
 * every host — any host can own tasks and their works.
 *
 * Both verbs survive redelivery: `create` writes the row under the op's
 * resource id and skips when it already exists; `update` re-applies the same
 * full content. The create also links the work to its task so the next
 * snapshot re-ship carries it back to the execution host — that link write is
 * best effort (the work outliving a deleted task is correct, not a failure).
 */
export function registerWorkOutboxApplier(): void {
  registerOutboxApplier('works', async (op: OutboxOp) => {
    if (op.name === 'create') {
      const payload = op.payload as WorkCreateOpPayload
      const existing = await loadWork(op.resourceId)
      if (!existing) {
        await createWork(
          payload.title,
          payload.docType,
          payload.content,
          workPreview(payload.docType, payload.content),
          payload.originSessionId ?? op.sessionId,
          (payload.agentProvider as AgentId) ?? 'claude-code',
          payload.cwd ?? '~',
          op.resourceId,
        )
      }
      await Task.byId(payload.taskId)
        .then((task) => task.link({
          kind: 'work',
          targetScope: '',
          targetKey: op.resourceId,
          title: payload.title,
          createdBy: 'agent',
          originSessionId: payload.originSessionId ?? op.sessionId ?? null,
        }, { actor: 'agent', actorLabel: op.sessionId }))
        .catch((error) => {
          log.warn('work_op_task_link_failed', {
            opId: op.id,
            taskId: payload.taskId,
            workId: op.resourceId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      return
    }
    if (op.name === 'update') {
      const payload = op.payload as WorkUpdateOpPayload
      const existing = await loadWork(op.resourceId)
      if (!existing) {
        throw new PermanentApplyError(`Work ${op.resourceId} no longer exists on its owner host.`)
      }
      await agentSaveWork(op.resourceId, {
        content: payload.content,
        preview: workPreview(existing.type, payload.content),
        ...(payload.title !== undefined ? { title: payload.title } : {}),
      })
      return
    }
    // An unknown verb is a version-skew problem a retry may fix once this host
    // updates, so it is deliberately not permanent.
    throw new Error(`Unknown works outbox op "${op.name}".`)
  })
}
