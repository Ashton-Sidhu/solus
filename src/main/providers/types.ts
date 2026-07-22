import type { AuthStatus, ChangedFileStat, DeviceCodePrompt, MergeMethod, ProviderId } from '../../shared/types'
import type {
  DraftReview,
  DraftReviewComment,
  PrCommit,
  PrConversationItem,
  PrFilter,
  PrListPage,
  PrReviewer,
  PullRequestDetail,
  PullRequestOverview,
  PullRequestSummary,
  RepoRef,
  ReviewComment,
  ReviewThread,
} from '../../shared/providers'
import type { NumberedPrChecksSummary } from '../../shared/checks-rpc-types'

export type { AuthStatus, DeviceCodePrompt, ProviderId }
// Host-neutral review DTOs now live in shared/ so preload + renderer can type
// them too; re-export here so existing `../providers/types` imports keep working.
export type {
  DraftReview,
  DraftReviewComment,
  PrCommit,
  PrConversationItem,
  PrFilter,
  PrListPage,
  PrReviewer,
  PullRequestDetail,
  PullRequestOverview,
  PullRequestSummary,
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
  getPullRequest(repo: RepoRef, number: number): Promise<PullRequestDetail>
  getPullRequestOverview(repo: RepoRef, number: number): Promise<PullRequestOverview>
  listReviewThreads(repo: RepoRef, number: number): Promise<ReviewThread[]>
  listCommits(repo: RepoRef, number: number): Promise<PrCommit[]>
  listReviewers(repo: RepoRef, number: number): Promise<PrReviewer[]>
  listComments(repo: RepoRef, number: number): Promise<PrConversationItem[]>
  listChecks(repo: RepoRef, numbers: number[]): Promise<NumberedPrChecksSummary[]>

  createReview(repo: RepoRef, number: number, review: DraftReview): Promise<void>
  addIssueComment(repo: RepoRef, number: number, body: string): Promise<void>
  replyToThread(repo: RepoRef, threadId: string, body: string): Promise<ReviewComment>
  resolveThread(repo: RepoRef, threadId: string): Promise<void>
  unresolveThread(repo: RepoRef, threadId: string): Promise<void>

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
