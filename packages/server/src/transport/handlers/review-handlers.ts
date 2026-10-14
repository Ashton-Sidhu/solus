import type { HandlerCtx, SolusServer } from '../server'
import { readGuideByKey, resolveReviewContext, reviewCheckout, reviewRepoRoot } from '../../review/review-context'
import { readReviewState, writeReviewState } from '../../review/review-state'
import type { AgentDispatcher } from '../../execution/agents/agent-runner'
import type { SessionRuntime } from '../../execution/session-runtime'
import type { SeatResolver } from '../../execution/seats/seat-manager'
import type { HostEventPublisher } from '../events/host-event-publisher'
import type { IpcContext } from '@solus/contracts/types'
import type { ReviewGuideRequestOptions, ReviewGuideStatusEvent, ReviewTarget } from '@solus/contracts/review'
import { reviewSessionStatus } from '../../review/session-lifecycle'
import type { ReviewGuideJobs } from '../../review/guide-jobs'
import { readPrGuide } from '../../review/pr-guide-store'
import { ReviewLensJobs } from '../../review/lens-jobs'
import { notifyOnReviewJobResult, type ReviewJobRequester, type ReviewJobRun } from '../../notifications/review-job-results'
import { ownerKeyOf } from '../../admission/actor'
import { organizationForNew } from '../../admission/principal'

export function registerReviewHandlers(
  server: SolusServer,
  dispatcher: AgentDispatcher & Pick<SessionRuntime, 'seatForTurn'>,
  events: HostEventPublisher,
  guides: ReviewGuideJobs,
): void {
  /** Guides and lenses run on the requester's own provider login, as their turns do. */
  const seatsOf = (handlerCtx: HandlerCtx): SeatResolver => (provider) => dispatcher.seatForTurn(handlerCtx.actor, provider)
  /** Who asked for a generation: their hub hears when it finishes (plans/015 §5). */
  const requesterOf = (handlerCtx: HandlerCtx): ReviewJobRequester | null => {
    const recipientKey = ownerKeyOf(handlerCtx.actor)
    if (!recipientKey) return null
    const user = handlerCtx.actor.user
    return { recipientKey, organizationId: organizationForNew(handlerCtx.actor.principal), by: user ? { kind: 'user', user } : { kind: 'system' } }
  }
  const guideTitle = (target: Extract<ReviewTarget, { kind: 'pr' }>) => `Guide for ${target.owner}/${target.repo}#${target.number}`
  const prTargetFor = (ctx: IpcContext, opts?: ReviewGuideRequestOptions): Extract<ReviewTarget, { kind: 'pr' }> | null => {
    if (opts?.target?.kind === 'pr') return opts.target
    if (opts?.scope === 'session' || opts?.target) return null
    const pr = ctx.session.prReview
    return pr ? { kind: 'pr', host: pr.host, owner: pr.owner, repo: pr.repo, number: pr.number } : null
  }
  server.register('getReviewContext', async (args) => {
    const [ctx] = args
    return resolveReviewContext(reviewCheckout(ctx), ctx.session.agentSessionId)
  })

  /** A PR review session asks about its own pull request when it names no target. */
  const withPrTarget = (ctx: IpcContext, opts: ReviewGuideRequestOptions = {}): ReviewGuideRequestOptions => {
    const target = prTargetFor(ctx, opts)
    return target ? { ...opts, target } : opts
  }
  /** The requester hears when their pull request guide finishes; `forward` hears every status of the job. */
  const requestListener = (handlerCtx: HandlerCtx, opts: ReviewGuideRequestOptions, forward?: (event: ReviewGuideStatusEvent) => void) => {
    const target = opts.target?.kind === 'pr' ? opts.target : null
    if (!target) return forward
    return notifyOnReviewJobResult(requesterOf(handlerCtx), { job: 'guide', target, title: guideTitle(target) }, forward ?? (() => {}))
  }

  server.register('generateGuide', async (args, handlerCtx) => {
    const [ctx, opts] = args
    const request = withPrTarget(ctx, opts)
    const job = await guides.request({
      ctx, opts: request, dispatcher, seatFor: seatsOf(handlerCtx), onStatus: requestListener(handlerCtx, request),
    })
    return job ? job.completion : null
  })

  server.register('requestReviewGuide', async (args, handlerCtx) => {
    const [ctx, opts] = args
    const request = withPrTarget(ctx, opts)
    const reportLifecycle = (status: 'running' | 'completed') => events.broadcast('session.statusChanged', {
      sessionId: ctx.session.sessionId,
      agentSessionId: ctx.session.agentSessionId,
      status,
      at: Date.now(),
    })
    const lifecycle = opts?.reportSessionLifecycle
      ? (event: ReviewGuideStatusEvent) => reportLifecycle(reviewSessionStatus(event.status))
      : undefined
    const job = await guides.request({
      ctx, opts: request, dispatcher, seatFor: seatsOf(handlerCtx), onStatus: requestListener(handlerCtx, request, lifecycle),
    })
    if (!job && opts?.reportSessionLifecycle) reportLifecycle('completed')
    return job?.status ?? null
  })

  server.register('reviewGuideStatus', async (args) => {
    const [ctx, opts] = args
    return guides.status(ctx, withPrTarget(ctx, opts))
  })

  server.register('sessionGuideStatuses', async ([sessions]) => guides.sessionStatuses(sessions))

  server.register('prGuideStatuses', async ([ctx, requests]) =>
    Promise.all(requests.map(({ target }) => guides.savedStatus(ctx, { target }))))

  server.register('cancelGenerateGuide', async (args) => {
    const [ctx, opts] = args
    return guides.cancel(ctx, withPrTarget(ctx, opts))
  })

  server.register('readGuide', async (args) => {
    const [ctx, key, target] = args
    // A PR review session without a target names its PR guide by the checkout
    // branch, as generation through `prTargetFor` does.
    const branchKey = ctx.session.prReview?.branch.replace(/\//g, '__')
    const pr = target?.kind === 'pr' ? target : !target && key === branchKey ? prTargetFor(ctx) : null
    if (pr) return readPrGuide(pr)
    const repoRoot = await reviewRepoRoot(ctx)
    return repoRoot ? readGuideByKey(repoRoot, key) : null
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

  // ── Review lens ──
  const lenses = new ReviewLensJobs(dispatcher)
  const emitLens = (event: import('@solus/contracts/review').ReviewLensChangedEvent) =>
    events.broadcast('review.lensChanged', event)
  server.register('readReviewLens', async ([ctx, target]) => lenses.read(ctx, target))
  server.register('prLensRevisions', async ([ctx, targets]) => lenses.savedPrRevisions(ctx, targets))
  /** A PR lens run tells its requester when it is ready or failed; other targets have no PR to name. */
  const emitLensFor = (handlerCtx: HandlerCtx, target: ReviewTarget, run: Pick<ReviewJobRun, 'lensId' | 'title'>) => {
    if (target.kind !== 'pr') return emitLens
    const notify = notifyOnReviewJobResult(requesterOf(handlerCtx), { job: 'lens', target, ...run }, () => {})
    return (event: import('@solus/contracts/review').ReviewLensChangedEvent) => {
      emitLens(event)
      if (event.job) void notify(event.job)
    }
  }
  server.register('requestReviewLens', async ([ctx, request], handlerCtx) => {
    const run: Pick<ReviewJobRun, 'lensId' | 'title'> = { title: request.source.name }
    if (request.source.savedLensId) run.lensId = request.source.savedLensId
    return lenses.generate(ctx, request, emitLensFor(handlerCtx, request.target, run), seatsOf(handlerCtx))
  })
  server.register('editReviewLens', async ([ctx, request], handlerCtx) => lenses.edit(ctx, request,
    emitLensFor(handlerCtx, request.target, { title: 'Lens edit' }), seatsOf(handlerCtx)))
  server.register('cancelReviewLens', async ([ctx, target]) => lenses.cancel(ctx, target, emitLens))
  server.register('restoreReviewLens', async ([ctx, target]) => lenses.restore(ctx, target, emitLens))
  server.register('updateReviewLensComments', async ([ctx, target, change]) => lenses.changeComments(ctx, target, change, emitLens))
  server.register('postReviewLensComment', async ([ctx, target, commentId]) => lenses.postComment(ctx, target, commentId, emitLens))
  server.register('retractReviewLensComment', async ([ctx, target, commentId]) => lenses.retractComment(ctx, target, commentId, emitLens))
}
