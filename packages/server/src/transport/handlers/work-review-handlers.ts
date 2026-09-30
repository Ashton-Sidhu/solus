import { workReviewDecideSchema, workReviewRequestSchema } from '@solus/contracts/work-review'
import { userKey } from '@solus/contracts/user'
import { recordScopeOf } from '../../admission/principal'
import { getDatabase } from '../../db/database'
import { decideWorkReview, loadWorkReview, removeWorkReviewer, requestWorkReview, shareWithReviewers, workReviewInbox, workReviewStates } from '../../data/works/work-reviews'
import type { ShareManager } from '../../sharing/share-manager'
import type { SolusServer } from '../server'

/**
 * Work review (docs/plans/work-review-and-live-editing.md, phase 2). The access
 * policy decides the role each call needs; the host names the reviewer from
 * the admitted principal, never from the call.
 */
export function registerWorkReviewHandlers(server: SolusServer, deps: { shares?: ShareManager } = {}): void {
  server.register('workReviewGet', ([workId], ctx) => loadWorkReview(recordScopeOf(ctx.principal), workId))

  server.register('workReviewRequest', async ([workId, rawRequest], ctx) => {
    const request = workReviewRequestSchema.parse(rawRequest)
    // One transaction: a refused request gives nobody access.
    return getDatabase().transaction(async () => {
      const review = await requestWorkReview(recordScopeOf(ctx.principal), workId, request, ctx.actor.user)
      await shareWithReviewers(deps.shares, ctx.principal, workId, request.reviewers.map((reviewer) => reviewer.userId))
      return review
    })
  })

  server.register('workReviewRemove', ([workId, reviewerId], ctx) => removeWorkReviewer(recordScopeOf(ctx.principal), workId, reviewerId, ctx.actor.user))

  server.register('workReviewDecide', async ([workId, rawDecide], ctx) => {
    const reviewer = ctx.actor.user
    if (!reviewer) throw new Error('Only a person can give a review decision.')
    return decideWorkReview(recordScopeOf(ctx.principal), workId, workReviewDecideSchema.parse(rawDecide), reviewer)
  })

  server.register('workReviewInbox', async (_args, ctx) => {
    const reviewer = ctx.actor.user
    if (!reviewer) return []
    const items = await workReviewInbox(recordScopeOf(ctx.principal), userKey(reviewer.id))
    return deps.shares ? deps.shares.filterVisible(ctx.principal, 'work', items, (item) => item.workId) : items
  })

  server.register('workReviewStates', async (_args, ctx) => {
    const states = await workReviewStates(recordScopeOf(ctx.principal))
    return deps.shares ? deps.shares.filterVisible(ctx.principal, 'work', states, (entry) => entry.workId) : states
  })
}
