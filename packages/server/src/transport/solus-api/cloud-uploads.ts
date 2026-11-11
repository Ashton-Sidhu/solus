import { z } from 'zod'
import type { WorkTransfer } from '@solus/contracts/work-transfer'
import type { SolusServer } from '../server'
import type { ShareManager } from '../../sharing/share-manager'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { Work } from '../../data/works/work'
import { importWorkFromHost } from '../../data/works/works'
import { linkWorkToSessionTasks } from '../../data/works/work-tasks'
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
    type: z.enum(['doc', 'slides', 'artifact', 'app']),
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

/**
 * Cloud sharing (docs/plans/cloud-sharing.md §3): a signed-in member uploads a
 * Local work into their organization. It keeps its id, so the same
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
      const work = await importWorkFromHost(organizationId, transfer, principal.userId)
      await (await Work.byId(organizationId, work.id)).flushStorage()
      await deps.shares.shareWithOrganization({ kind: 'work', id: work.id }, principal)
      await linkWorkToSessionTasks(organizationId, work)
      log.info('work_uploaded', { organizationId, workId: work.id, userId: principal.userId, alreadyThere: existing !== null, revisions: transfer.revisions.length })
      return { workId: work.id, organizationId }
    })
  })
}
