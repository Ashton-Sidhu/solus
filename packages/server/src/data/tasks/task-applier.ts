import { Task } from './task'
import { createTask } from './task-store'
import { PermanentApplyError, registerOutboxApplier } from '../../sync/outbox/outbox-store'
import type { OutboxOp, TaskLinkSessionOpPayload } from '@solus/contracts/outbox-types'
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
const taskCreatePayloadSchema = z.object({
  title: z.string(),
  projectKey: z.string().nullable(),
  body: z.string(),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).nullable(),
  labels: z.array(z.string()).optional(),
  dueDate: z.string().nullable(),
  status: taskStatusSchema,
  originSessionId: z.string().nullable(),
  createdAt: z.number(),
})
const taskLinkPayloadSchema = z.object({
  kind: z.enum(['work', 'plan', 'pr', 'automation']),
  targetScope: z.string(),
  targetKey: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  originSessionId: z.string().nullable(),
  actor: attributionSchema.optional(),
  actorLabel: z.string().optional(),
})
const taskLinkSessionPayloadSchema = z.object({
  sessionId: z.string(),
  role: z.enum(['working', 'referenced']),
})

/** Who an op says did it: its attribution, or for an older op the agent its label or session names. */
function opActor(payload: { actor?: Attribution; actorLabel?: string }, op: OutboxOp): Attribution {
  return payload.actor ?? agentAttribution(payload.actorLabel ?? op.sessionId)
}

/**
 * Owner-side writes for `tasks` outbox ops (ADR-0007). Registered on every
 * host — any host can own tasks — and on the workspace service, where a runner's
 * ops land in the runner's organization (cloud-service-model.md §16). Every verb
 * survives redelivery: a comment inserts under the op id (`INSERT OR IGNORE`),
 * set-status re-applies to the same value, create writes the row under the op's
 * resource id and skips when it exists, and a link upserts on its target.
 */
export function registerTaskOutboxApplier(): void {
  registerOutboxApplier('tasks', async (op: OutboxOp, organizationId: string) => {
    if (op.name === 'create') {
      const payload = taskCreatePayloadSchema.parse(op.payload)
      const existing = await Task.byId(organizationId, op.resourceId).catch(() => null)
      if (existing) return
      await createTask(organizationId, {
        title: payload.title,
        projectKey: payload.projectKey,
        body: payload.body,
        priority: payload.priority,
        labels: payload.labels,
        dueDate: payload.dueDate,
        status: payload.status,
        source: 'agent',
        originSessionId: payload.originSessionId,
      }, { id: op.resourceId, now: payload.createdAt })
      return
    }
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
    if (op.name === 'link') {
      const payload = taskLinkPayloadSchema.parse(op.payload)
      // A pull request of a session that works on the task is the session's link.
      if (payload.kind === 'pr' && payload.originSessionId && payload.url
        && await task.linkWorkingSessionPullRequest(payload.originSessionId, { url: payload.url, title: payload.title }, opActor(payload, op))) return
      await task.link({
        kind: payload.kind,
        targetScope: payload.targetScope,
        targetKey: payload.targetKey,
        title: payload.title,
        url: payload.url,
        originSessionId: payload.originSessionId,
      }, opActor(payload, op))
      return
    }
    if (op.name === 'link-session') {
      const payload: TaskLinkSessionOpPayload = taskLinkSessionPayloadSchema.parse(op.payload)
      await task.linkSession(payload.sessionId, payload.role)
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
