import type { AuthStatus, ChangedFileStat, DeviceCodePrompt, MergeMethod, ProviderId } from '@solus/contracts/types'
import type {
  DraftReview,
  PrDiffFileContents,
  PrDiffFileContentsRequest,
  PrDiffRequest,
  PrDiffSlice,
  PrConversationItem,
  PrFilter,
  PrLabel,
  PrListPage,
  PrReviewer,
  PrPendingWorkflowRun,
  PrReviewerCandidate,
  PrRevertResult,
  PrStack,
  PrStackMergeRequest,
  PrStateAction,
  PrViewedFileChange,
  PrViewedFiles,
  ProviderRepository,
  ProviderViewer,
  PullRequest,
  PullRequestUpdate,
  RepoRef,
  ReviewComment,
  ReviewThread,
  PullRequestOverview,
} from '@solus/contracts/providers'
import type { NumberedPrChecksSummary } from '@solus/contracts/checks-rpc-types'

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
  /**
   * Whether any credential can act on `host` from `cwd` — this host's own
   * connection, a paired device's delegation for that checkout, or the CLI the
   * user is signed in to. `status()` answers the narrower question of what this
   * host connected as, so it is what Settings reports; ask this one before
   * refusing to make a request.
   */
  hasCredential(host: string, cwd?: string): Promise<boolean>
  /** Forget the stored credential. */
  disconnect(): Promise<void>
}

// ─── Review operations ────────────────────────────────────────────────────────

/** Two halves, so a watch reads only what moved: `status` (state,
 *  mergeability, head, check counts) and `remarks` (comment and review counts
 *  and edit times). */
export interface PullRequestWatchFingerprint {
  status: string
  remarks: string
  /** What the watch rules read of the pull request, as `status` holds it. A
   *  row held on the server that agrees needs no read. */
  pullRequest: Pick<PullRequest, 'state' | 'mergeable' | 'headSha'>
}

/** One repository's place in a list read: page one has no cursor. */
export interface PrPageRequest {
  repo: RepoRef
  page: number
  /** The cursor the page before this one answered; null for page one. */
  cursor: string | null
}

/**
 * A page of a repository's pull requests, with the viewer's own and the ones
 * waiting on their review where the read asked for them. A priority part is
 * null where the read could not answer it whole; the reader then asks for that
 * part alone.
 */
export interface RepositoryPage {
  page: PrListPage
  /** The first page of the viewer's own pull requests, as the author search pages it. */
  authored: PrListPage | null
  /** Every open pull request that requests or assigns the viewer. */
  needsReview: PullRequest[] | null
}

/**
 * The typed operations PR review mode needs. Method **bodies** are specified in
 * the PR Review Mode spec; this interface only fixes the **signatures** so the
 * auth layer and the review feature can be built in parallel.
 */
export interface ReviewProvider {
  /**
   * A page of each repository's pull requests, in the order asked, in as few
   * requests as the host allows. `withPriority` asks for the viewer's own and
   * review-requested rows of page one of an unsearched list too. Null for a
   * repository the read could not answer; the reader lists that one alone.
   */
  listPullRequestPages(
    requests: PrPageRequest[],
    filter: PrFilter | undefined,
    viewer: string,
    withPriority: boolean,
  ): Promise<Array<RepositoryPage | null>>
  createPullRequest(
    repo: RepoRef,
    input: { baseRef: string; headRef: string; title: string; body: string; credentialCwd?: string },
  ): Promise<PullRequest>
  /** Open PRs that currently request or assign the given viewer's attention. */
  listPullRequestsNeedingReview(repo: RepoRef, viewer: string): Promise<PullRequest[]>
  /** The pull request with its commits and reviewers, in as few requests as
   *  the host allows. Every read of one pull request goes through this. */
  getPullRequestOverview(repo: RepoRef, number: number): Promise<PullRequestOverview>
  updatePullRequest(repo: RepoRef, number: number, patch: PullRequestUpdate): Promise<PullRequest>
  getPullRequestDiffBase(repo: RepoRef, pullRequest: PullRequest): Promise<string>
  /** Take the pull request rather than its number, like `listReviewerCandidates`:
   *  the caller holds the detail the page was opened with, and re-reading it
   *  here cost a second host round trip per diff page. */
  getPullRequestDiff(repo: RepoRef, pullRequest: PullRequest, request: PrDiffRequest): Promise<PrDiffSlice>
  getPullRequestDiffFileContents(repo: RepoRef, pullRequest: PullRequest, request: PrDiffFileContentsRequest): Promise<PrDiffFileContents>
  listReviewThreads(repo: RepoRef, number: number): Promise<ReviewThread[]>
  /** The stack `number` is in, bottom to top; null when it is in none or the
   *  host keeps no stacks. */
  getPullRequestStack(repo: RepoRef, number: number): Promise<PrStack | null>
  /** Takes the pull request rather than its number: every caller has already
   *  read the detail to check that the viewer may request reviewers, and the
   *  candidate list only needs the author off it. Asking for a number here made
   *  the provider read the same pull request a second time. */
  listReviewerCandidates(repo: RepoRef, pullRequest: PullRequest): Promise<PrReviewerCandidate[]>
  listLabelCandidates(repo: RepoRef): Promise<PrLabel[]>
  setLabels(repo: RepoRef, number: number, names: string[]): Promise<PrLabel[]>
  /** The pull requests opened from each branch, in every state, newest first,
   *  in as few requests as the host allows. Only PR sync calls this
   *  (docs/plans/pr-sync.md §3.2). */
  getPullRequestsByHead(repo: RepoRef, heads: string[]): Promise<Map<string, PullRequest[]>>
  /** Pull requests by number, in as few requests as the host allows. Null for
   *  a number the repository does not have. */
  getPullRequests(repo: RepoRef, numbers: number[]): Promise<Map<number, PullRequest | null>>
  listComments(repo: RepoRef, number: number): Promise<PrConversationItem[]>
  listChecks(repo: RepoRef, numbers: number[]): Promise<NumberedPrChecksSummary[]>
  /** A fingerprint of each pull request a watch reads, in as few requests as
   *  the host allows (docs/plans/pr-watch.md §11). A number the host did not
   *  answer is absent. */
  readWatchFingerprints(repo: RepoRef, numbers: number[]): Promise<Map<number, PullRequestWatchFingerprint>>

  createReview(repo: RepoRef, number: number, review: DraftReview): Promise<void>
  /** Returns the new comment's node id (what `deleteIssueComment` takes) and
   *  its page URL. */
  addIssueComment(repo: RepoRef, number: number, body: string): Promise<{ id: string; url: string }>
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
    action: PrStateAction,
    expectedHeadSha: string,
  ): Promise<PullRequest>
  requestReviewers(repo: RepoRef, number: number, logins: string[]): Promise<PrReviewer[]>
  removeRequestedReviewer(repo: RepoRef, number: number, reviewerId: string, kind?: 'user' | 'team'): Promise<PrReviewer[]>

  /** Merge via the host's merge button. Host refusals are returned as
   *  `merged: false` with a user-facing message. */
  mergePullRequest(repo: RepoRef, number: number, method: MergeMethod): Promise<{ merged: boolean; message?: string }>
  /** Arm the host's auto-merge with `method`, checked against the head the
   *  viewer saw. Answers the pull request as the mutation left it. */
  enablePullRequestAutoMerge(repo: RepoRef, number: number, method: MergeMethod, expectedHeadSha: string): Promise<PullRequest>
  disablePullRequestAutoMerge(repo: RepoRef, number: number): Promise<PullRequest>
  /** Bring the base into the head with a merge commit or a rebase, refused by
   *  the host when the head moved past `expectedHeadSha`. */
  updatePullRequestBranch(repo: RepoRef, number: number, method: 'merge' | 'rebase', expectedHeadSha: string): Promise<void>
  /** Open a pull request that reverses a merged one. */
  revertPullRequest(repo: RepoRef, number: number): Promise<PrRevertResult>
  /** Merge `request.number` and every open layer below it in its stack, after
   *  a check that each open layer still has the head the viewer saw. Answers
   *  the merged layers, bottom to top. A host without stacks refuses it. */
  mergePullRequestStack(repo: RepoRef, request: PrStackMergeRequest): Promise<{ status: 'merged' | 'queued'; layers: number[] }>
  /** The workflow runs that wait for a maintainer on the head of a fork pull request. */
  listPendingWorkflowRuns(repo: RepoRef, pullRequest: PullRequest): Promise<PrPendingWorkflowRun[]>
  /** Approve those runs. Answers how many the host approved. */
  approvePendingWorkflowRuns(repo: RepoRef, pullRequest: PullRequest): Promise<number>
  /** Which files the viewer marked viewed, as the host keeps it. */
  listViewedFiles(repo: RepoRef, number: number): Promise<PrViewedFiles>
  setFilesViewed(repo: RepoRef, number: number, changes: PrViewedFileChange[]): Promise<void>
  /** Changed files with host-reported per-file add/delete counts. */
  listPullRequestFileStats(repo: RepoRef, number: number): Promise<ChangedFileStat[]>
  /** Login for the token's viewer. A repository selects the credential that
   *  can access it before answering. Implementations cache this per token. */
  getViewer(repo?: RepoRef): Promise<string>
  /** The token's viewer as a client draws it: login plus host avatar. */
  getViewerProfile(): Promise<ProviderViewer>
  /** The repositories the token can read, newest push first. */
  listRepositories(): Promise<ProviderRepository[]>
}

/** A host is the pair `{ auth, review }`, keyed by its `ProviderId`. */
export interface Provider {
  id: ProviderId
  auth: ProviderAuth
  review: ReviewProvider
}
