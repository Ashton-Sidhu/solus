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
  PullRequest,
  PullRequestOverview,
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
  PullRequest,
  PullRequestOverview,
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
  listPullRequests(repo: RepoRef, filter?: PrFilter): Promise<PullRequest[]>
  listPullRequestsPage(repo: RepoRef, filter?: PrFilter, page?: number, perPage?: number): Promise<PrListPage>
  createPullRequest(
    repo: RepoRef,
    input: { baseRef: string; headRef: string; title: string; body: string; credentialCwd?: string },
  ): Promise<PullRequest>
  /** Open PRs that currently request or assign the given viewer's attention. */
  listPullRequestsNeedingReview(repo: RepoRef, viewer: string): Promise<PullRequest[]>
  getPullRequest(repo: RepoRef, number: number): Promise<PullRequest>
  updatePullRequest(repo: RepoRef, number: number, patch: PullRequestUpdate): Promise<PullRequest>
  getPullRequestOverview(repo: RepoRef, number: number): Promise<PullRequestOverview>
  getPullRequestDiffBase(repo: RepoRef, pullRequest: PullRequest): Promise<string>
  getPullRequestDiff(repo: RepoRef, request: PrDiffRequest): Promise<PrDiffSlice>
  getPullRequestDiffFileContents(repo: RepoRef, request: PrDiffFileContentsRequest): Promise<PrDiffFileContents>
  listReviewThreads(repo: RepoRef, number: number): Promise<ReviewThread[]>
  listCommits(repo: RepoRef, number: number): Promise<PrCommit[]>
  listReviewers(repo: RepoRef, number: number): Promise<PrReviewer[]>
  /** Takes the pull request rather than its number: every caller has already
   *  read the detail to check that the viewer may request reviewers, and the
   *  candidate list only needs the author off it. Asking for a number here made
   *  the provider read the same pull request a second time. */
  listReviewerCandidates(repo: RepoRef, pullRequest: PullRequest): Promise<PrReviewerCandidate[]>
  listComments(repo: RepoRef, number: number): Promise<PrConversationItem[]>
  listChecks(repo: RepoRef, numbers: number[]): Promise<NumberedPrChecksSummary[]>

  createReview(repo: RepoRef, number: number, review: DraftReview): Promise<void>
  addIssueComment(repo: RepoRef, number: number, body: string): Promise<void>
  /**
   * Upload one stored asset to the host and return the URL to reference from
   * Markdown.
   *
   * A screenshot taken outside a browser has nowhere a comment can point at
   * until the host holds it, so this is what lets evidence reach a pull request
   * at all. The asset is named by id rather than passed as bytes: the id is the
   * content hash and its extension is what the host validates the content type
   * against, so the adapter reads the bytes itself.
   */
  publishAsset(repo: RepoRef, assetId: string): Promise<string>
  deleteIssueComment(repo: RepoRef, commentId: string): Promise<void>
  replyToThread(repo: RepoRef, threadId: string, body: string): Promise<ReviewComment>
  resolveThread(repo: RepoRef, threadId: string): Promise<void>
  unresolveThread(repo: RepoRef, threadId: string): Promise<void>
  updatePullRequestLifecycle(
    repo: RepoRef,
    number: number,
    action: Exclude<PrLifecycleAction, 'merge'>,
    expectedHeadSha: string,
  ): Promise<PullRequest>
  requestReviewers(repo: RepoRef, number: number, logins: string[]): Promise<PrReviewer[]>
  removeRequestedReviewer(repo: RepoRef, number: number, login: string): Promise<PrReviewer[]>

  /** Merge via the host's merge button. Host refusals are returned as
   *  `merged: false` with a user-facing message. */
  mergePullRequest(repo: RepoRef, number: number, method: MergeMethod): Promise<{ merged: boolean; message?: string }>
  /** Changed files with host-reported per-file add/delete counts. */
  listPullRequestFileStats(repo: RepoRef, number: number): Promise<ChangedFileStat[]>
  /** Login for the token's viewer. A repository selects the credential that
   *  can access it before answering. Implementations cache this per token. */
  getViewer(repo?: RepoRef): Promise<string>
}

/** A host is the pair `{ auth, review }`, keyed by its `ProviderId`. */
export interface Provider {
  id: ProviderId
  auth: ProviderAuth
  review: ReviewProvider
}
