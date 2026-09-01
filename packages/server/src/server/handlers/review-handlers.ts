import type { SolusServer } from '../server'
import { readGuideByKey, readLegacyGuide, readLedger, writeLedger, resolveReviewContext, reviewCheckout, reviewRepoRoot } from '../../review/ledger'
import { cancelGenerateGuide, generateGuide, getReviewGuideStatus, requestReviewGuide } from '../../review/guide-producer'
import { guideKeyFor } from '../../review/review-target'
import { readReviewState, writeReviewState } from '../../review/review-state'
import type { AgentDispatcher } from '../../agents/agent-runner'
import type { HostEventPublisher } from '../../events/host-event-publisher'
import type { IpcContext } from '@solus/contracts/types'
import type { ReviewGuideRequestOptions, ReviewTarget } from '@solus/contracts/review'
import { configureReviewRequestTool } from '../../review/review-request-tool'

export function registerReviewHandlers(
  server: SolusServer,
  dispatcher: AgentDispatcher,
  events: HostEventPublisher,
  preparePr?: (
    ctx: IpcContext,
    target: Extract<ReviewTarget, { kind: 'pr' }>,
  ) => Promise<{ ctx: IpcContext; target: Extract<ReviewTarget, { kind: 'pr' }> }>,
): void {
  configureReviewRequestTool({
    generate: (ctx, target, agent) => generateGuide(
      dispatcher,
      ctx,
      { target, agent },
      (event) => events.broadcast('review.progressChanged', event),
      (event) => events.broadcast('review.guideStatusChanged', event),
    ),
    preparePr,
  })
  const resolveRequest = async (
    ctx: IpcContext,
    opts: ReviewGuideRequestOptions | undefined,
  ): Promise<{ ctx: IpcContext; opts: ReviewGuideRequestOptions | undefined }> => {
    if (!preparePr || opts?.target?.kind !== 'pr') return { ctx, opts }
    const requestedTarget = opts.regenerationBaseSha && opts.target.headSha
      ? { ...opts.target, baseSha: opts.regenerationBaseSha }
      : opts.target
    const prepared = await preparePr(ctx, requestedTarget)
    return { ctx: prepared.ctx, opts: { ...opts, target: prepared.target } }
  }
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
    const resolved = await resolveRequest(ctx, opts)
    return generateGuide(
      dispatcher,
      resolved.ctx,
      resolved.opts,
      (event) => events.broadcast('review.progressChanged', event),
      (event) => events.broadcast('review.guideStatusChanged', event),
    )
  })

  server.register('requestReviewGuide', async (args) => {
    const [ctx, opts] = args
    const resolved = await resolveRequest(ctx, opts)
    return requestReviewGuide(
      dispatcher,
      resolved.ctx,
      resolved.opts,
      (event) => events.broadcast('review.progressChanged', event),
      (event) => events.broadcast('review.guideStatusChanged', event),
    )
  })

  server.register('reviewGuideStatus', async (args) => {
    const [ctx, opts] = args
    const resolved = await resolveRequest(ctx, opts)
    return getReviewGuideStatus(resolved.ctx, resolved.opts)
  })

  server.register('cancelGenerateGuide', async (args) => {
    const [ctx, opts] = args
    const resolved = await resolveRequest(ctx, opts)
    return cancelGenerateGuide(
      resolved.ctx,
      resolved.opts,
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
