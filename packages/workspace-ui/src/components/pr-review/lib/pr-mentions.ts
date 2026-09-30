import type { PrReviewer, PrReviewerCandidate, PullRequest, ReviewThread } from '@solus/contracts/providers'
import { isMentionableLogin, type CodeHostAccount } from '../../mentions/lib/code-host-mentions'

export interface PrMentionSources {
  author: string
  authorAvatarUrl?: string
  reviewers: readonly PrReviewer[]
  threads: readonly ReviewThread[]
  candidates: readonly PrReviewerCandidate[]
}

/**
 * The accounts `@` offers on a pull request, in GitHub's order: the people
 * already in it (the author, the reviewers, the thread authors, newest first),
 * then the repository's collaborators. Each login once; teams and bot accounts
 * are not offered.
 */
export function prMentionAccounts(sources: PrMentionSources): CodeHostAccount[] {
  const threadAuthors = sources.threads
    .flatMap((thread) => thread.comments)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((comment) => ({ login: comment.author, avatarUrl: comment.authorAvatarUrl }))
  const ordered: CodeHostAccount[] = [
    { login: sources.author, avatarUrl: sources.authorAvatarUrl || undefined },
    ...sources.reviewers.map((reviewer) => ({ login: reviewer.login, avatarUrl: reviewer.avatarUrl })),
    ...threadAuthors,
    ...sources.candidates.flatMap((candidate) =>
      candidate.kind === 'user' ? [{ login: candidate.login, avatarUrl: candidate.avatarUrl }] : []),
  ]
  const seen = new Set<string>()
  return ordered.filter((account) => {
    const key = account.login.toLowerCase()
    if (!isMentionableLogin(account.login) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The part of the pull request store the first `@` reads from. */
export interface PrMentionStore {
  reviewers?: PrReviewer[]
  reviewerCandidates?: PrReviewerCandidate[]
  capabilities: Pick<PullRequest['capabilities'], 'reviewerCandidates'>
  loadReviewers(): Promise<PrReviewer[]>
  loadReviewerCandidates(): Promise<PrReviewerCandidate[]>
}

/**
 * Reads the reviewers and the candidates into the store only when no surface
 * has read them yet. The reviewer rail loads them into the same store, so
 * `@` never asks the host a second time.
 */
export function warmPrMentions(pullRequest: PrMentionStore): void {
  if (!pullRequest.reviewers) void pullRequest.loadReviewers().catch(() => {})
  if (!pullRequest.reviewerCandidates && pullRequest.capabilities.reviewerCandidates) {
    void pullRequest.loadReviewerCandidates().catch(() => {})
  }
}
