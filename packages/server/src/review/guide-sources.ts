import type { ReviewContext } from '@solus/contracts/review'
import { projectScopeOf, type IpcContext } from '@solus/contracts/types'
import type { GuideIdentity, GuideSource } from './guide-jobs'
import { authorGuide, changeSnapshotFor, resolveTargetBase } from './guide-producer'
import { currentPrGuideTarget, prepareReviewGuidePrContext, type PrGuideTarget } from './pr-guide-context'
import { prGuideKey, readPrGuide, writePrGuide } from './pr-guide-store'
import { readGuideByKey, resolveReviewContext, reviewCheckout, writeGuide } from './review-context'
import { reviewedSessionId } from './review-target'

function prTargetOf(identity: GuideIdentity): PrGuideTarget {
  if (identity.target?.kind !== 'pr') throw new Error('A pull request guide needs a pull request target.')
  return identity.target
}

/**
 * Pull request guides belong to the remote repository, not to a checkout, and
 * are written from a managed checkout of the exact revision. The live revision
 * is the code host's. They run one at a time: each prepares a checkout.
 */
export const prGuideSource: GuideSource = {
  serial: true,
  async identify(ctx, opts) {
    if (opts.target?.kind !== 'pr') return null
    const target = opts.target
    const key = prGuideKey(target)
    return {
      jobKey: key,
      identity: {
        repoRoot: ctx.session.gitContext?.repoRoot ?? projectScopeOf(ctx.session),
        key, scope: 'pr', target, headSha: target.headSha ?? '', baseSha: target.baseSha,
      },
    }
  },
  read: (identity) => readPrGuide(prTargetOf(identity)),
  async live(_ctx, identity) {
    const current = await currentPrGuideTarget(prTargetOf(identity))
    return { target: current, headSha: current.headSha, baseSha: current.baseSha }
  },
  async author(run) {
    const target = await currentPrGuideTarget(prTargetOf(run.identity))
    if (run.signal.aborted) return null
    run.reading({ target, headSha: target.headSha, baseSha: target.baseSha })
    const prepared = await prepareReviewGuidePrContext(run.ctx, target)
    if (run.signal.aborted) return null
    return authorGuide(run.dispatcher, prepared.ctx, { ...run.opts, target }, run.signal, run.progress, run.seatFor)
  },
  write: (identity, guide, canCommit) =>
    writePrGuide(guide, { ...prTargetOf(identity), headSha: identity.headSha, baseSha: identity.baseSha }, canCommit),
}

type GuideBase = Awaited<ReturnType<typeof resolveTargetBase>>

/** What `identify` resolved for a status probe, so its `live` read does not
 * resolve the checkout and base a second time. */
const resolvedBases = new WeakMap<GuideIdentity, { review: ReviewContext; base: GuideBase }>()

function workTreeOf(ctx: Pick<IpcContext, 'session'>, review: ReviewContext): string {
  return reviewCheckout(ctx) ?? review.repoRoot
}

/**
 * Working-tree, branch, and session guides belong to the project's checkout.
 * Their revision is the exact patch, so an edit that does not move HEAD still
 * changes it. They run in parallel.
 */
export const localGuideSource: GuideSource = {
  serial: false,
  async identify(ctx, opts, { withRevision, checkouts }) {
    const review = await resolveReviewContext(reviewCheckout(ctx), reviewedSessionId(ctx), checkouts)
    if (!review) return null
    const base = await resolveTargetBase(ctx, review, opts)
    const identity: GuideIdentity = {
      repoRoot: review.repoRoot, key: base.guideKey, scope: base.scope, target: base.target,
      headSha: review.headSha, baseSha: base.base,
    }
    if (withRevision) identity.changeFingerprint = (await changeSnapshotFor(workTreeOf(ctx, review), review, base)).changeFingerprint
    resolvedBases.set(identity, { review, base })
    return { jobKey: `${review.repoRoot}::${base.guideKey}`, identity }
  },
  read: (identity) => readGuideByKey(identity.repoRoot, identity.key),
  async live(ctx, identity) {
    const known = resolvedBases.get(identity)
    const review = known?.review ?? await resolveReviewContext(reviewCheckout(ctx), reviewedSessionId(ctx))
    if (!review) throw new Error('The checkout is no longer available.')
    const base = known?.base ?? await resolveTargetBase(ctx, review, { target: identity.target })
    const { changeFingerprint } = await changeSnapshotFor(workTreeOf(ctx, review), review, base)
    return { headSha: review.headSha, baseSha: base.base, changeFingerprint }
  },
  author: (run) => authorGuide(run.dispatcher, run.ctx, run.opts, run.signal, run.progress, run.seatFor, (target, review) =>
    run.reading({ headSha: review.headSha, baseSha: target.base, changeFingerprint: target.changeFingerprint })),
  write: (identity, guide, canCommit) => writeGuide(identity.repoRoot, guide, canCommit),
}
