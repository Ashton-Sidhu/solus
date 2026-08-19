import type { SolusServer } from '../server'
import { readGuideByKey, readLegacyGuide, readLedger, writeLedger, resolveReviewContext, reviewCheckout, reviewRepoRoot } from '../../review/ledger'
import { cancelGenerateGuide, generateGuide, getReviewGuideStatus, requestReviewGuide } from '../../review/guide-producer'
import { guideKeyFor } from '../../review/review-target'
import { readReviewState, writeReviewState } from '../../review/review-state'
import type { AgentDispatcher } from '../../agents/agent-runner'
import type { HostEventPublisher } from '../../events/host-event-publisher'

export function registerReviewHandlers(server: SolusServer, dispatcher: AgentDispatcher, events: HostEventPublisher): void {
  server.register('readLedger', async (args) => {
    const [ctx] = args
    return readLedger(ctx)
  })

  server.register('writeLedger', async (args) => {
    const [ctx, ledger] = args
    const repoRoot = await reviewRepoRoot(ctx)
    if (!repoRoot) return false
    return writeLedger(repoRoot, ledger)
  })

  server.register('getReviewContext', async (args) => {
    const [ctx] = args
    return resolveReviewContext(reviewCheckout(ctx), ctx.session.agentSessionId)
  })

  server.register('generateGuide', async (args) => {
    const [ctx, opts] = args
    return generateGuide(
      dispatcher,
      ctx,
      opts,
      (event) => events.broadcast('review.progressChanged', event),
      (event) => events.broadcast('review.guideStatusChanged', event),
    )
  })

  server.register('requestReviewGuide', async (args) => {
    const [ctx, opts] = args
    return requestReviewGuide(
      dispatcher,
      ctx,
      opts,
      (event) => events.broadcast('review.progressChanged', event),
      (event) => events.broadcast('review.guideStatusChanged', event),
    )
  })

  server.register('reviewGuideStatus', async (args) => {
    const [ctx, opts] = args
    return getReviewGuideStatus(ctx, opts)
  })

  server.register('cancelGenerateGuide', async (args) => {
    const [ctx, opts] = args
    return cancelGenerateGuide(
      ctx,
      opts,
      (event) => events.broadcast('review.guideStatusChanged', event),
    )
  })

  server.register('readGuide', async (args) => {
    const [ctx, key] = args
    const repoRoot = await reviewRepoRoot(ctx)
    if (!repoRoot) return null
    const current = await readGuideByKey(repoRoot, key)
    if (current) return current

    // One-time compatibility read for SHA-derived guide names. A successful
    // regeneration writes the stable key and naturally completes the migration.
    const review = await resolveReviewContext(reviewCheckout(ctx), ctx.session.agentSessionId)
    if (!review) return null
    const sessionId = ctx.session.agentSessionId
    const isStableKey = key === guideKeyFor(review, 'session', sessionId)
      || key === guideKeyFor(review, 'branch', sessionId)
    return isStableKey
      ? readLegacyGuide(repoRoot, key, review.branch === review.targetBranch)
      : null
  })

  server.register('readReviewState', async (args) => {
    const [ctx, key] = args
    const repoRoot = await reviewRepoRoot(ctx)
    if (!repoRoot) return null
    return readReviewState(repoRoot, key)
  })

  server.register('writeReviewState', async (args) => {
    const [ctx, state] = args
    const repoRoot = await reviewRepoRoot(ctx)
    if (!repoRoot) return false
    return writeReviewState(repoRoot, state)
  })
}
