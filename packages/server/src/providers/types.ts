import type { AuthStatus, ChangedFileStat, DeviceCodePrompt, MergeMethod, ProviderId } from '@solus/contracts/types'
import type {
  DraftReview,
  DraftReviewComment,
  PrDiffFileContents,
  PrDiffFileContentsRequest,
  PrDiffRequest,
  PrDiffSlice,
  PrCommit,
  PrConversationItem,
  PrFilter,
  PrListPage,
  PrReviewer,
  PrReviewerCandidate,
  PrLifecycleAction,
  PullRequestDetail,
  PullRequestOverview,
  PullRequestSummary,
  PullRequestUpdate,
  RepoRef,
  ReviewComment,
  ReviewThread,
} from '@solus/contracts/providers'
import type { NumberedPrChecksSummary } from '@solus/contracts/checks-rpc-types'

export type { AuthStatus, DeviceCodePrompt, ProviderId }
// Host-neutral review DTOs now live in shared/ so preload + renderer can type
// them too; re-export here so existing `../providers/types` imports keep working.
export type {
  DraftReview,
  DraftReviewComment,
  PrDiffFileContents,
  PrDiffFileContentsRequest,
  PrDiffRequest,
  PrDiffSlice,
  PrCommit,
  PrConversationItem,
  PrFilter,
  PrListPage,
  PrReviewer,
  PrReviewerCandidate,
  PrLifecycleAction,
  PullRequestDetail,
  PullRequestOverview,
  PullRequestSummary,
  PullRequestUpdate,
  RepoRef,
  ReviewComment,
  ReviewThread,
}

// ─── Auth ───────────────────────────────────────────────────────────────────

/**
 * How we obtain and persist a credential for a host. Changes when a host's auth
 * story changes (OAuth App → GitHub App, PAT, …) — not when we add a feature.
 */
export interface ProviderAuth {
  /** Run the auth grant, streaming any device/user code to the caller. */
  connect(onUserCode: (c: DeviceCodePrompt) => void): Promise<AuthStatus>
  /** Abort an in-flight connect() so its promise rejects immediately. No-op when idle. */
  cancelConnect(): void
  /** Load the access token; throws if not connected. Async so an expiring-token future is a drop-in. */
  getAccessToken(): Promise<string>
  status(): Promise<AuthStatus>
  /** Forget the stored credential. */
  disconnect(): void
}

// ─── Review operations ────────────────────────────────────────────────────────

/**
 * The typed operations PR review mode needs. Method **bodies** are specified in
 * the PR Review Mode spec; this interface only fixes the **signatures** so the
 * auth layer and the review feature can be built in parallel.
 */
export interface ReviewProvider {
  listPullRequests(repo: RepoRef, filter?: PrFilter): Promise<PullRequestSummary[]>
  listPullRequestsPage(repo: RepoRef, filter?: PrFilter, page?: number, perPage?: number): Promise<PrListPage>
  /** Open PRs that currently request or assign the given viewer's attention. */
  listPullRequestsNeedingReview(repo: RepoRef, viewer: string): Promise<PullRequestSummary[]>
  getPullRequest(repo: RepoRef, number: number): Promise<PullRequestDetail>
  updatePullRequest(repo: RepoRef, number: number, patch: PullRequestUpdate): Promise<PullRequestDetail>
  getPullRequestOverview(repo: RepoRef, number: number): Promise<PullRequestOverview>
  getPullRequestDiffBase(repo: RepoRef, pullRequest: PullRequestDetail): Promise<string>
  getPullRequestDiff(repo: RepoRef, request: PrDiffRequest): Promise<PrDiffSlice>
  getPullRequestDiffFileContents(repo: RepoRef, request: PrDiffFileContentsRequest): Promise<PrDiffFileContents>
  listReviewThreads(repo: RepoRef, number: number): Promise<ReviewThread[]>
  listCommits(repo: RepoRef, number: number): Promise<PrCommit[]>
  listReviewers(repo: RepoRef, number: number): Promise<PrReviewer[]>
  listReviewerCandidates(repo: RepoRef, number: number): Promise<PrReviewerCandidate[]>
  listComments(repo: RepoRef, number: number): Promise<PrConversationItem[]>
  listChecks(repo: RepoRef, numbers: number[]): Promise<NumberedPrChecksSummary[]>

  createReview(repo: RepoRef, number: number, review: DraftReview): Promise<void>
  addIssueComment(repo: RepoRef, number: number, body: string): Promise<void>
  replyToThread(repo: RepoRef, threadId: string, body: string): Promise<ReviewComment>
  resolveThread(repo: RepoRef, threadId: string): Promise<void>
  unresolveThread(repo: RepoRef, threadId: string): Promise<void>
  updatePullRequestLifecycle(
    repo: RepoRef,
    number: number,
    action: Exclude<PrLifecycleAction, 'merge'>,
    expectedHeadSha: string,
  ): Promise<PullRequestDetail>
  requestReviewers(repo: RepoRef, number: number, logins: string[]): Promise<PrReviewer[]>
  removeRequestedReviewer(repo: RepoRef, number: number, login: string): Promise<PrReviewer[]>

  /** Merge via the host's merge button. Host refusals are returned as
   *  `merged: false` with a user-facing message. */
  mergePullRequest(repo: RepoRef, number: number, method: MergeMethod): Promise<{ merged: boolean; message?: string }>
  /** Changed files with host-reported per-file add/delete counts. */
  listPullRequestFileStats(repo: RepoRef, number: number): Promise<ChangedFileStat[]>
  /** Login for the token's viewer. Implementations cache this per token. */
  getViewer(): Promise<string>
}

/** A host is the pair `{ auth, review }`, keyed by its `ProviderId`. */
export interface Provider {
  id: ProviderId
  auth: ProviderAuth
  review: ReviewProvider
}
