import type { IpcContext } from '@solus/contracts/types'
import type { ReviewTarget } from '@solus/contracts/review'
import { providerForRepo } from '../providers/registry'
import { buildPrReviewTarget } from '../providers/pr-review-target'
import { ensureManagedPrCheckout } from './managed-pr-checkout'

export type PrGuideTarget = Extract<ReviewTarget, { kind: 'pr' }>
export type ResolvedPrGuideTarget = PrGuideTarget & { baseSha: string; headSha: string }

/** Query the provider without materializing or changing a checkout. */
export async function currentPrGuideTarget(target: PrGuideTarget): Promise<ResolvedPrGuideTarget> {
  const provider = providerForRepo(target)
  if (!provider) throw new Error(`PR review is not supported for ${target.host} yet.`)
  const detail = await provider.review.getPullRequest(target, target.number)
  return {
    kind: 'pr', host: target.host, owner: target.owner, repo: target.repo, number: target.number,
    baseSha: await provider.review.getPullRequestDiffBase(target, detail),
    headSha: detail.headSha,
  }
}

/** Review an exact revision in host-owned storage. Local edits and branch
 * checkouts cannot change either the generated patch or agent file reads. */
export async function prepareReviewGuidePrContext(
  ctx: IpcContext,
  requested: PrGuideTarget,
): Promise<{ ctx: IpcContext; target: ResolvedPrGuideTarget }> {
  const provider = providerForRepo(requested)
  if (!provider) throw new Error(`PR review is not supported for ${requested.host} yet.`)
  const detail = await provider.review.getPullRequest(requested, requested.number)
  const current = buildPrReviewTarget(requested, detail,
    await provider.review.getPullRequestDiffBase(requested, detail))
  const target: ResolvedPrGuideTarget = {
    ...requested,
    baseSha: requested.baseSha ?? current.baseSha,
    headSha: requested.headSha ?? current.headSha,
  }
  const checkout = await ensureManagedPrCheckout(target, target)
  return {
    target,
    ctx: {
      ...ctx,
      session: {
        ...ctx.session,
        workingDirectory: checkout.worktreePath,
        gitContext: {
          repoRoot: checkout.worktreePath,
          branch: checkout.branch,
          targetBranch: current.baseRef,
          worktreePath: checkout.worktreePath,
        },
        prReview: { ...current, ...checkout },
      },
    },
  }
}
