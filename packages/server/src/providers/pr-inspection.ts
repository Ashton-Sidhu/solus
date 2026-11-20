import { z } from 'zod'
import { parseGitHubPullRequestUrl, type RepoRef } from '@solus/contracts/providers'
import type { PrUrlInspection } from '@solus/contracts/pr-social'
import type { ReviewProvider } from './types'
import { prRepoSchema } from './github/pr-social'

type InspectionProvider = Pick<
  ReviewProvider,
  'getPullRequestOverview' | 'listComments' | 'listReviewThreads'
>

/** The URL inspection has only provider reads. It has no project or checkout dependency. */
export async function inspectPullRequestUrl(
  address: string,
  providerFor: (repo: RepoRef) => InspectionProvider | null
): Promise<PrUrlInspection> {
  const parsed = parseGitHubPullRequestUrl(z.string().trim().max(2048).parse(address))
  if (!parsed) throw new Error('Use a public GitHub pull request URL.')
  const target = prRepoSchema.safeParse(parsed.baseRepo)
  if (!target.success) throw new Error('Use a GitHub PR URL with a valid repository name.')
  const repo = target.data
  const provider = providerFor(repo)
  if (!provider) throw new Error('Connect GitHub before inspecting this pull request.')
  const [overview, comments, threads] = await Promise.all([
    provider.getPullRequestOverview(repo, parsed.number),
    provider.listComments(repo, parsed.number),
    provider.listReviewThreads(repo, parsed.number)
  ])
  // Bound the snapshot over IPC and remote transports. The UI names omitted content.
  let remainingText = 256_000
  let remainingInline = 100
  let truncated =
    comments.length > 100 ||
    threads.length > 50 ||
    overview.commits.length > 100 ||
    overview.reviewers.length > 100
  const text = (value: string): string => {
    const kept = value.slice(0, remainingText)
    remainingText -= kept.length
    if (kept.length < value.length) truncated = true
    return kept
  }
  const boundedOverview = {
    ...overview,
    pullRequest: { ...overview.pullRequest, body: text(overview.pullRequest.body) },
    commits: overview.commits
      .slice(0, 100)
      .map((commit) => ({ ...commit, message: text(commit.message) })),
    reviewers: overview.reviewers.slice(0, 100)
  }
  const boundedComments = comments
    .slice(0, 100)
    .map((comment) =>
      comment.kind === 'label' ? comment : { ...comment, body: text(comment.body) }
    )
  const boundedThreads = threads.slice(0, 50).map((thread) => {
    const kept = thread.comments.slice(0, remainingInline)
    remainingInline -= kept.length
    if (kept.length < thread.comments.length) truncated = true
    return {
      ...thread,
      comments: kept.map((comment) => ({
        ...comment,
        body: text(comment.body),
        diffHunk: undefined
      }))
    }
  })
  return {
    overview: boundedOverview,
    comments: boundedComments,
    threads: boundedThreads,
    readOnly: true,
    truncated
  }
}
