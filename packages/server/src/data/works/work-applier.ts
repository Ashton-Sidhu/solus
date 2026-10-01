import { createWork, loadWork } from './works'
import { Work, WorkContentInvalidError, WorkVersionConflictError } from './work'
import { workPreview } from '@solus/contracts/work-preview'
import { Task } from '../tasks/task'
import { PermanentApplyError, registerOutboxApplier } from '../../sync/outbox/outbox-store'
import { createLogger } from '../../logger'
import { agentAttribution } from '../stored-attribution'
import type { OutboxOp, WorkUpdateOpPayload } from '@solus/contracts/outbox-types'
import { z } from 'zod'

const log = createLogger('folio', 'work-applier.ts')
const workCreatePayloadSchema = z.object({
  taskId: z.string().optional(),
  title: z.string(),
  docType: z.enum(['doc', 'slides', 'diagram', 'artifact', 'insights-report']),
  content: z.string(),
  agentProvider: z.enum(['claude-code', 'codex', 'opencode']).optional(),
  originSessionId: z.string().optional(),
  cwd: z.string().optional(),
  linkToSessionTask: z.boolean().optional(),
})
const workUpdatePayloadSchema = z.object({
  taskId: z.string().optional(),
  content: z.string(),
  title: z.string().optional(),
  expectedContentVersion: z.number().int().min(0),
})

/**
 * Owner-side writes for `works` outbox ops (ADR-0007): a dispatched session's
 * works belong to its task's host, and these land them there. Registered on
 * every host — any host can own tasks and their works — and on the workspace
 * service, where a runner's ops land in the runner's organization
 * (cloud-service-model.md §16).
 *
 * Both verbs survive redelivery through the receipt that commits with them
 * (`applied_ops` on a host, the runner cursor on the workspace service): an op
 * already applied is answered without running again. `create` also skips a
 * row that already exists. `update` names the content version its agent read;
 * a work that moved past it refuses the op for good, so the courier
 * dead-letters it instead of overwriting a newer body. The create also links the work to its task — the one the op
 * names, or the one its session works when the op asks — so the next snapshot
 * re-ship carries it back to the execution host. That link write is best effort
 * (the work outliving a deleted task is correct, not a failure).
 */
/** A stale version or an invalid body will be refused on every retry. */
async function permanentOnRefusal<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (error instanceof WorkVersionConflictError || error instanceof WorkContentInvalidError) throw new PermanentApplyError(error.message)
    throw error
  }
}

export function registerWorkOutboxApplier(): void {
  registerOutboxApplier('works', async (op: OutboxOp, organizationId: string) => {
    if (op.name === 'create') {
      const payload = workCreatePayloadSchema.parse(op.payload)
      const existing = await loadWork(organizationId, op.resourceId)
      if (!existing) {
        await permanentOnRefusal(() => createWork(
          organizationId,
          payload.title,
          payload.docType,
          payload.content,
          workPreview(payload.docType, payload.content),
          payload.originSessionId ?? op.sessionId,
          payload.agentProvider ?? 'claude-code',
          payload.cwd ?? '~',
          op.resourceId,
          agentAttribution(payload.originSessionId ?? op.sessionId, payload.agentProvider),
        ))
      }
      const originSessionId = payload.originSessionId ?? op.sessionId
      const link = payload.taskId
        ? Task.byId(organizationId, payload.taskId).then((task) => task.link({
            kind: 'work',
            targetScope: '',
            targetKey: op.resourceId,
            title: payload.title,
            originSessionId: originSessionId ?? null,
          }, agentAttribution(op.sessionId)))
        : payload.linkToSessionTask && originSessionId
          ? Task.linkSessionOutput(organizationId, originSessionId, { kind: 'work', targetKey: op.resourceId, title: payload.title })
          : null
      await link?.catch((error) => {
        log.warn('work_op_task_link_failed', {
          opId: op.id,
          taskId: payload.taskId ?? null,
          workId: op.resourceId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return
    }
    if (op.name === 'update') {
      const parsed = workUpdatePayloadSchema.safeParse(op.payload)
      // An op recorded without the version its agent read cannot be checked,
      // and the current version is not a substitute for it.
      if (!parsed.success) throw new PermanentApplyError(`The update of work ${op.resourceId} names no content version it read.`)
      const payload: WorkUpdateOpPayload = parsed.data
      const work = await Work.find(organizationId, op.resourceId)
      if (!work) {
        throw new PermanentApplyError(`Work ${op.resourceId} no longer exists on its owner host.`)
      }
      await permanentOnRefusal(() => work.updateContent({
        content: payload.content,
        title: payload.title,
        expectedContentVersion: payload.expectedContentVersion,
        author: agentAttribution(op.sessionId),
        reason: 'agent',
      }))
      return
    }
    // An unknown verb is a version-skew problem a retry may fix once this host
    // updates, so it is deliberately not permanent.
    throw new Error(`Unknown works outbox op "${op.name}".`)
  })
}
