import { z } from 'zod'
import { attributionSchema } from '@solus/contracts/user'
import type { WorkTransfer } from '@solus/contracts/work-transfer'
import type { TaskTransfer } from '@solus/contracts/task-types'
import type { SolusServer } from '../server'
import type { ShareManager } from '../../sharing/share-manager'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { Work } from '../../data/works/work'
import { importWorkFromHost } from '../../data/works/works'
import { linkWorkToSessionTasks } from '../../data/works/work-tasks'
import { importTaskFromHost } from '../../data/tasks/task-transfer'
import { Task } from '../../data/tasks/task'
import { attributionOf } from '../../admission/actor'
import { createLogger } from '../../logger'
import { isApiMode } from '../../host/api-mode'
import { timeShareCall } from '../../sharing/share-timing'

const log = createLogger('main', 'cloud-uploads')

/** Who wrote a body, as an `Attribution`; null where nobody recorded it (plans/012 §2). */
const attributionOutlineSchema = z.object({ kind: z.enum(['user', 'agent', 'automation', 'upstream', 'system']) }).loose().nullable()

/**
 * The transfer's outline. It is passed through unparsed, so the fingerprint is
 * computed over what the client sent; the work domain checks that fingerprint
 * and every body, hash, revision id, and reference on import.
 */
const workTransferOutlineSchema = z.object({
  work: z.object({
    id: z.string().min(1),
    content: z.string(),
    title: z.string(),
    type: z.enum(['doc', 'slides', 'diagram', 'artifact']),
    contentVersion: z.number().int().positive(),
    contentHash: z.string().min(1),
    contentAuthor: attributionOutlineSchema,
  }).loose(),
  previousRevisionId: z.number().int().positive().nullable(),
  revisions: z.array(z.object({
    workId: z.string().min(1),
    revisionId: z.number().int().positive(),
    content: z.string(),
    contentHash: z.string().min(1),
    sourceContentVersion: z.number().int().positive().nullable(),
    reason: z.enum(['baseline', 'checkpoint', 'agent', 'upstream', 'review', 'restore']),
    author: attributionOutlineSchema,
    capturedAt: z.string().min(1),
  }).loose()),
  annotations: z.object({ workId: z.string().min(1) }).loose().nullable(),
  fingerprint: z.string().min(1),
})
const workTransferSchema = z.custom<WorkTransfer>((value) => workTransferOutlineSchema.safeParse(value).success, 'Not a work transfer.')

const taskTransferSchema = z.object({
  task: z.object({
    id: z.string().min(1),
    title: z.string(),
    projectKey: z.string().nullable(),
    body: z.string(),
    status: z.enum(['inbox', 'todo', 'in_progress', 'in_review', 'done', 'dropped']),
    priority: z.enum(['urgent', 'high', 'medium', 'low']).nullable(),
    labels: z.array(z.string()),
    dueDate: z.string().nullable(),
    source: z.enum(['user', 'agent', 'automation', 'import']).nullable(),
    originSessionId: z.string().nullable(),
    createdAt: z.number(),
  }),
  comments: z.array(z.object({ id: z.string().min(1), body: z.string(), author: attributionSchema.nullable(), originSessionId: z.string().nullable() })),
  workIds: z.array(z.string().min(1)),
  sessions: z.array(z.object({
    sessionId: z.string().min(1),
    role: z.enum(['lead', 'working', 'referenced']),
    linkedAt: z.number(),
    title: z.string().nullable(),
    provider: z.string().nullable(),
    startedBy: attributionSchema.nullable(),
    hostInstallationId: z.string().min(1),
  })),
  fingerprint: z.string().min(1),
}) satisfies z.ZodType<TaskTransfer>

/**
 * Cloud sharing (docs/plans/cloud-sharing.md §3): a signed-in member uploads a
 * Local work or task into their organization. It keeps its id, so the same
 * upload again answers "already there" and one of another organization is
 * refused. The uploader owns it and it starts shared with the organization, like
 * anything made in the organization's space. No host token is involved.
 */
export function registerCloudUploadHandlers(server: SolusServer, deps: { shares: ShareManager }): void {
  server.register('workUpload', async ([input], { principal }) => {
    if (!isApiMode()) throw new Error('Works are uploaded to Solus cloud, not to a machine.')
    if (principal.kind !== 'org-member') throw new Error('Sign in to an organization to share this work.')
    const transfer = workTransferSchema.parse(input)
    const organizationId = principal.organizationId
    return timeShareCall('workUpload', { kind: 'work', id: transfer.work.id }, async () => {
      const existing = await Work.find(ANY_ORGANIZATION, transfer.work.id)
      if (existing && existing.organizationId !== organizationId) throw new Error('This work already belongs to another organization.')
      const work = await importWorkFromHost(organizationId, transfer)
      await deps.shares.claimOwner({ kind: 'work', id: work.id }, principal)
      await linkWorkToSessionTasks(organizationId, work)
      log.info('work_uploaded', { organizationId, workId: work.id, userId: principal.userId, alreadyThere: existing !== null, revisions: transfer.revisions.length })
      return { workId: work.id, organizationId }
    })
  })

  server.register('taskUpload', async ([input], { principal, actor }) => {
    if (!isApiMode()) throw new Error('Tasks are uploaded to Solus cloud, not to a machine.')
    if (principal.kind !== 'org-member') throw new Error('Sign in to an organization to share this task.')
    const transfer = taskTransferSchema.parse(input)
    const organizationId = principal.organizationId
    return timeShareCall('taskUpload', { kind: 'task', id: transfer.task.id }, async () => {
      const existing = await Task.byId(ANY_ORGANIZATION, transfer.task.id).catch(() => null)
      if (existing && existing.organizationId !== organizationId) throw new Error('This task already belongs to another organization.')
      const task = await importTaskFromHost(organizationId, transfer, attributionOf(actor))
      await deps.shares.claimOwner({ kind: 'task', id: task.id }, principal)
      log.info('task_uploaded', { organizationId, taskId: task.id, userId: principal.userId, works: transfer.workIds.length, sessions: transfer.sessions.length, alreadyThere: existing !== null })
      return { taskId: task.id, organizationId }
    })
  })
}
