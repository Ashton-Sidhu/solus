import { z } from 'zod'
import type { OutboxOp } from '@solus/contracts/outbox-types'
import { attributionSchema } from '@solus/contracts/user'
import { PermanentApplyError, registerOutboxApplier } from '../../sync/outbox/outbox-store'
import { linkSessionPullRequest, pullRequestIdentityOf } from './session-pull-requests'
import { organizationOfSession } from './session-records'

const sessionPullRequestPayloadSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  actor: attributionSchema,
})

/**
 * Owner-side writes for `sessions` outbox ops: the pull request links an agent
 * makes on an attached machine, applied by the organization's Solus API to
 * the same session (docs/plans/session-pull-requests.md). The verb survives
 * redelivery: a link that exists changes nothing.
 */
export function registerSessionOutboxApplier(): void {
  registerOutboxApplier('sessions', async (op: OutboxOp, organizationId: string) => {
    if (op.name !== 'link-pull-request') {
      // An unknown verb is a version-skew problem a retry may fix once this
      // host updates, so it is deliberately not permanent.
      throw new Error(`Unknown sessions outbox op "${op.name}".`)
    }
    const payload = sessionPullRequestPayloadSchema.parse(op.payload)
    const identity = pullRequestIdentityOf(payload.url)
    if (!identity) throw new PermanentApplyError(`"${payload.url}" is not a pull request URL.`)
    if (await organizationOfSession(op.resourceId) !== organizationId) {
      throw new PermanentApplyError(`Session ${op.resourceId} does not belong to this organization.`)
    }
    await linkSessionPullRequest(op.resourceId, { url: identity.url, title: payload.title, source: 'agent', by: payload.actor })
  })
}
