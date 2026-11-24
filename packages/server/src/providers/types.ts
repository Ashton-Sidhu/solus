import type { CheckItem } from '@solus/contracts/checks-types'
import type { AuthStatus, ChangedFileStat, DeviceCodePrompt, MergeMethod, ProviderId } from '@solus/contracts/types'
import type {
  DraftReview,
  PrDiffFileContents,
  PrDiffFileContentsRequest,
  PrDiffRequest,
  PrDiffSlice,
  PrConversationItem,
  PrCommit,
  PrFilter,
  PrFilterChoice,
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
import type { PullRequestHead } from '@solus/contracts/repository-key'

export interface PullRequestOverviewPage extends PullRequestOverview {
  completeCommits?: () => Promise<PrCommit[]>
}

export interface CheckLogResult {
  name: string
  url: string | null
  log: string | null
  truncated: boolean
  detail: string | null
}

export interface CheckRerunResult {
  name: string
  rerun: boolean
  detail: string | null
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

/** Which pull requests of a repository are the viewer's. Numbers only: the
 *  reader already holds most of these rows from the page it just read. */
export interface PriorityNumbers {
  /** The first page of the viewer's own pull requests, as the author search pages it. */
  authored: { numbers: number[]; hasMore: boolean }
  /** Every open pull request that requests or assigns the viewer, newest first.
   *  Null where the read could not answer it whole; the reader then asks for
   *  it alone. */
  needsReview: number[] | null
}

/**
 * The typed operations PR review mode needs. Method **bodies** are specified in
 * the PR Review Mode spec; this interface only fixes the **signatures** so the
 * auth layer and the review feature can be built in parallel.
 */
export interface AgentPullRequestSummary {
  number: number
  url: string
  title: string
  state: PullRequest['state']
  isDraft: boolean
  author: string | null
  headBranch: string
  baseBranch: string
  headSha: string
  baseSha: string
  mergeability: 'mergeable' | 'conflicting' | 'unknown'
  behindBy: number | null
  autoMergeEnabled: boolean | null
  checkRuns: Array<{ check: CheckItem; name: string; required: boolean }>
  checksIncomplete: boolean
  unresolvedThreads: number
  unresolvedThreadsTruncated: boolean
  body?: string
}

export interface AgentPullRequestListInput {
  state: 'open' | 'closed' | 'merged' | 'all'
  involvement: 'all' | 'reviewing' | 'authored'
  query?: string
  limit: number
  cursor?: string
}

export interface AgentPullRequestListRow {
  number: number
  url: string
  title: string
  author: string | null
  headBranch: string
  baseBranch: string
  state: PullRequest['state']
  isDraft: boolean
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | null
  checksState: 'passing' | 'failing' | 'pending' | null
  updatedAt: string
}

export interface AgentPullRequestConversationInput {
  threads?: string | null
  comments?: string | null
  reviews?: string | null
}

export type AgentLinkedPullRequest = Pick<PullRequest, 'headRef' | 'baseRef' | 'stack'> & { isFork: boolean }

export interface AgentReviewThread extends Pick<ReviewThread, 'id' | 'filePath' | 'line' | 'isResolved' | 'isOutdated'> {
  comments: Array<Pick<ReviewComment, 'author' | 'body' | 'createdAt'>>
  pullRequestId: string
  nextCommentsCursor?: string
}

export interface AgentPullRequestConversationPage {
  reviewThreads?: AgentReviewThread[]
  comments?: Array<{
    id: string
    kind: 'issue-comment' | 'review' | 'review-comment'
    author: string
    body: string
    createdAt: string
    path: string | null
    reviewState: string | null
  }>
  next: AgentPullRequestConversationInput
}

export interface ReviewProvider {
  /** Apply a dispatched checkout's credential policy inside the current acting identity. */
  agentPullRequestSummary?(repo: RepoRef, number: number, input: { body: boolean; fresh?: boolean; checksOnly?: boolean }): Promise<AgentPullRequestSummary>
  agentPullRequestConversation?(repo: RepoRef, number: number, input: AgentPullRequestConversationInput): Promise<AgentPullRequestConversationPage>
  agentReviewThreadComments?(repo: RepoRef, thread: AgentReviewThread): Promise<Pick<AgentReviewThread, 'comments' | 'nextCommentsCursor'>>
  agentPullRequestList?(repo: RepoRef, input: AgentPullRequestListInput): Promise<{ pullRequests: AgentPullRequestListRow[]; nextCursor: string | null }>
  agentPullRequestNumberForHead?(repo: RepoRef, head: PullRequestHead, fresh: boolean): Promise<number | undefined>
  agentMergePullRequest?(repo: RepoRef, pullRequest: PullRequest, method: MergeMethod, auto: boolean): Promise<PullRequest['state']>
  agentLinkedPullRequests?(repo: RepoRef, numbers: number[]): Promise<Map<number, AgentLinkedPullRequest | null>>
  forCheckout?(cwd: string): ReviewProvider
  /**
   * A page of each repository's pull requests, in the order asked, in as few
   * requests as the host allows. Null for a repository the read could not
   * answer; the reader lists that one alone.
   */
  listPullRequestPages(
    requests: PrPageRequest[],
    filter: PrFilter | undefined,
    viewer: string,
  ): Promise<Array<PrListPage | null>>
  /** Which pull requests of each repository are the viewer's, in the order
   *  asked. Null for a repository the read could not answer. */
  listPriorityNumbers(
    repos: RepoRef[],
    state: NonNullable<PrFilter['state']>,
    viewer: string,
  ): Promise<Array<PriorityNumbers | null>>
  defaultPullRequestBase?(repo: RepoRef): Promise<string>
  createPullRequest(
    repo: RepoRef,
    input: { baseRef?: string; headRef: string; headRepo?: string; title: string; body: string; draft?: boolean; credentialCwd?: string },
  ): Promise<PullRequest>
  /** Open PRs that currently request or assign the given viewer's attention. */
  listPullRequestsNeedingReview(repo: RepoRef, viewer: string): Promise<PullRequest[]>
  /** The pull request with its complete commit list and reviewers. */
  getPullRequest?(repo: RepoRef, number: number): Promise<PullRequest>
  getPullRequestOverview(repo: RepoRef, number: number): Promise<PullRequestOverview>
  /** A provider can let header readers finish before the commit list does. */
  getPullRequestOverviewPage?(
    repo: RepoRef, number: number
  ): Promise<PullRequestOverviewPage>
  updatePullRequest(repo: RepoRef, number: number, patch: PullRequestUpdate): Promise<PullRequest>
  getPullRequestDiffBase(repo: RepoRef, pullRequest: Pick<PullRequest, 'number' | 'baseSha' | 'headSha'>): Promise<string>
  /** Take the pull request rather than its number, like `listReviewerCandidates`:
   *  the caller holds the detail the page was opened with, and re-reading it
   *  here cost a second host round trip per diff page. */
  getPullRequestDiff(repo: RepoRef, pullRequest: Pick<PullRequest, 'number' | 'baseSha' | 'headSha'>, request: PrDiffRequest): Promise<PrDiffSlice>
  getPullRequestDiffFileContents(repo: RepoRef, pullRequest: PullRequest, request: PrDiffFileContentsRequest): Promise<PrDiffFileContents>
  listReviewThreads(repo: RepoRef, number: number): Promise<ReviewThread[]>
  containsReviewThread?(repo: RepoRef, number: number, threadId: string): Promise<boolean>
  /** The stack `number` is in, bottom to top; null when it is in none or the
   *  host keeps no stacks. */
  getPullRequestStack(repo: RepoRef, number: number, options?: { headsOnly?: boolean }): Promise<PrStack | null>
  /** Takes the pull request rather than its number: every caller has already
   *  read the detail to check that the viewer may request reviewers, and the
   *  candidate list only needs the author off it. Asking for a number here made
   *  the provider read the same pull request a second time. */
  listReviewerCandidates(repo: RepoRef, pullRequest: PullRequest): Promise<PrReviewerCandidate[]>
  listLabelCandidates(repo: RepoRef): Promise<PrLabel[]>
  /** People who can be mentioned in the repository whose login or name
   *  matches `query`, at most `limit`: the list's author filter choices. */
  listMentionableUsers(repo: RepoRef, query: string, limit: number): Promise<PrFilterChoice[]>
  changeLabels?(repo: RepoRef, number: number, change: { add: string[]; remove: string[] }): Promise<void>
  setLabels(repo: RepoRef, number: number, names: string[]): Promise<PrLabel[]>
  /** The pull requests into `repo` opened from each exact head, in every
   *  state, newest first, by head key, in as few requests as the host allows
   *  (docs/plans/pr-sync.md §3.2). */
  getPullRequestsByHead(repo: RepoRef, heads: readonly PullRequestHead[]): Promise<Map<string, PullRequest[]>>
  /** Pull requests by number, in as few requests as the host allows. Null for
   *  a number the repository does not have. */
  getPullRequests(repo: RepoRef, numbers: number[]): Promise<Map<number, PullRequest | null>>
  listComments(repo: RepoRef, number: number): Promise<PrConversationItem[]>
  readCheckLog?(repo: RepoRef, check: CheckItem, headSha: string, tailLines: number): Promise<CheckLogResult>
  rerunChecks?(repo: RepoRef, checks: CheckItem[], headSha: string): Promise<CheckRerunResult[]>
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
  mergePullRequest(repo: RepoRef, number: number, method: MergeMethod, expectedHeadSha?: string): Promise<{ merged: boolean; message?: string }>
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
  mergePullRequestStack(repo: RepoRef, request: PrStackMergeRequest, options?: { byStackNumber?: boolean }): Promise<{ status: 'merged' | 'queued'; layers: number[] }>
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
