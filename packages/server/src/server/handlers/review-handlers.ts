import type { SolusServer } from '../server'
import { readGuideByKey, readLegacyGuide, readLedger, writeLedger, resolveReviewContext, reviewCheckout, reviewRepoRoot } from '../../review/ledger'
import { cancelGenerateGuide, generateGuide, getReviewGuideStatus, requestReviewGuide } from '../../review/guide-producer'
import { guideKeyFor } from '../../review/review-target'
import { readReviewState, writeReviewState } from '../../review/review-state'
import type { AgentDispatcher } from '../../agents/agent-runner'
import type { HostEventPublisher } from '../../events/host-event-publisher'
import type { IpcContext } from '@solus/contracts/types'
import type { ReviewGuideRequestOptions, ReviewTarget } from '@solus/contracts/review'
import { reviewSessionStatus } from '../../review/session-lifecycle'
import { prGuideJobs } from '../../review/pr-guide-jobs'
import { readPrGuide } from '../../review/pr-guide-store'
import { publishPrGuideStatus } from '../../review/pr-guide-events'

export function registerReviewHandlers(
  server: SolusServer,
  dispatcher: AgentDispatcher,
  events: HostEventPublisher,
): void {
  const prTargetFor = (ctx: IpcContext, opts?: ReviewGuideRequestOptions): Extract<ReviewTarget, { kind: 'pr' }> | null => {
    if (opts?.target?.kind === 'pr') return opts.target
    if (opts?.scope === 'session' || opts?.target) return null
    const pr = ctx.session.prReview
    return pr ? { kind: 'pr', host: pr.host, owner: pr.owner, repo: pr.repo, number: pr.number } : null
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
    const target = prTargetFor(ctx, opts)
    if (target) return prGuideJobs.request({
      dispatcher, ctx, opts: { ...opts, target },
      onStatus: (event) => publishPrGuideStatus(events, event),
    }).completion
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
    const target = prTargetFor(ctx, opts)
    const reportStatus = (event: import('@solus/contracts/review').ReviewGuideStatusEvent) => {
      if (target) publishPrGuideStatus(events, event)
      else events.broadcast('review.guideStatusChanged', event)
      if (!opts?.reportSessionLifecycle) return
      events.broadcast('session.statusChanged', {
        sessionId: ctx.session.sessionId,
        agentSessionId: ctx.session.agentSessionId,
        status: reviewSessionStatus(event.status),
        at: Date.now(),
      })
    }
    if (target) return prGuideJobs.request({ dispatcher, ctx, opts: { ...opts, target }, onStatus: reportStatus }).status
    const result = await requestReviewGuide(
      dispatcher,
      ctx,
      opts,
      (event) => events.broadcast('review.progressChanged', event),
      reportStatus,
    )
    if (!result && opts?.reportSessionLifecycle) {
      events.broadcast('session.statusChanged', {
        sessionId: ctx.session.sessionId,
        agentSessionId: ctx.session.agentSessionId,
        status: 'completed',
        at: Date.now(),
      })
    }
    return result
  })

  server.register('reviewGuideStatus', async (args) => {
    const [ctx, opts] = args
    const target = prTargetFor(ctx, opts)
    return target ? prGuideJobs.status(ctx, target) : getReviewGuideStatus(ctx, opts)
  })

  server.register('cancelGenerateGuide', async (args) => {
    const [ctx, opts] = args
    const target = prTargetFor(ctx, opts)
    if (target) return prGuideJobs.cancel(target)
    return cancelGenerateGuide(
      ctx,
      opts,
      (event) => events.broadcast('review.guideStatusChanged', event),
    )
  })

  server.register('readGuide', async (args) => {
    const [ctx, key, target] = args
    const legacy = !target ? prTargetFor(ctx) : null
    const branchKey = ctx.session.prReview?.branch.replace(/\//g, '__')
    const isLegacyPrKey = !!branchKey && (key === branchKey || key.startsWith(`${branchKey}--base-`))
    const pr = target?.kind === 'pr' ? target : isLegacyPrKey ? legacy : null
    if (pr) return readPrGuide(ctx, pr)
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
