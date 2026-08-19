import type { PrReviewTarget, PullRequestDetail, RepoRef } from '@solus/contracts/providers'

/** Keep provider identity separate from every local checkout fact. */
export function buildPrReviewTarget(
  repo: RepoRef,
  detail: PullRequestDetail,
  diffBaseSha: string,
): PrReviewTarget {
  return {
    host: repo.host,
    owner: repo.owner,
    repo: repo.repo,
    number: detail.number,
    title: detail.title,
    baseRef: detail.baseRef,
    headRef: detail.headRef,
    headSha: detail.headSha,
    baseSha: diffBaseSha,
    headRepo: detail.headRepo,
  }
}
