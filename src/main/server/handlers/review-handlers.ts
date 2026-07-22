import type { SolusServer } from '../server'
import type { IpcContext } from '../../../shared/types'
import type { ReviewLedger, ReviewState } from '../../../shared/review'
import { readGuideByKey, readLegacyGuide, readLedger, writeLedger, resolveReviewContext, reviewCheckout, reviewRepoRoot } from '../../review/ledger'
import { cancelGenerateGuide, generateGuide, type GenerateGuideOptions } from '../../review/guide-producer'
import { guideKeyFor } from '../../review/review-target'
import { readReviewState, writeReviewState } from '../../review/review-state'

export function registerReviewHandlers(server: SolusServer): void {
  server.register('readLedger', async (args) => {
    const [ctx] = args as [IpcContext]
    return readLedger(ctx)
  })

  server.register('writeLedger', async (args) => {
    const [ctx, ledger] = args as [IpcContext, ReviewLedger]
    const repoRoot = await reviewRepoRoot(ctx)
    if (!repoRoot) return false
    return writeLedger(repoRoot, ledger)
  })

  server.register('getReviewContext', async (args) => {
    const [ctx] = args as [IpcContext]
    return resolveReviewContext(reviewCheckout(ctx), ctx.session.agentSessionId)
  })

  server.register('generateGuide', async (args) => {
    const [ctx, opts] = args as [IpcContext, GenerateGuideOptions | undefined]
    return generateGuide(ctx, opts, (event) => server.broadcast('review-progress', event))
  })

  server.register('cancelGenerateGuide', async (args) => {
    const [ctx, opts] = args as [IpcContext, Pick<GenerateGuideOptions, 'scope' | 'ownDeltaBase'> | undefined]
    return cancelGenerateGuide(ctx, opts)
  })

  server.register('readGuide', async (args) => {
    const [ctx, key] = args as [IpcContext, string]
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
    const [ctx, key] = args as [IpcContext, string]
    const repoRoot = await reviewRepoRoot(ctx)
    if (!repoRoot) return null
    return readReviewState(repoRoot, key)
  })

  server.register('writeReviewState', async (args) => {
    const [ctx, state] = args as [IpcContext, ReviewState]
    const repoRoot = await reviewRepoRoot(ctx)
    if (!repoRoot) return false
    return writeReviewState(repoRoot, state)
  })
}
