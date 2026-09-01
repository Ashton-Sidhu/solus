// One pull request, as this client can read and act on it.
//
// One of these per pull request per project, held in that project's `ProjectPrs`,
// so what one surface writes is what every other surface reads.
//
// **This is the pull request.** Its title, state, branches and revisions are its
// own fields, not a record held inside it: a pull request and the facts about a
// pull request are the same thing, and holding them apart is what let one
// surface draw a pull request open while another drew it merged.
// `Contracts.PullRequest` below is the same pull request as it crosses the
// transport — the payload the host sends, which `apply` becomes.
//
// It carries no host handle of its own: the store it belongs to *is* the
// project, so `api` and `ctx` are read from there.
//
// Responses to individual requests still live in `PrMirrors`, keyed and shared,
// because those are answers with a lifetime rather than the pull request itself.

import type { HostApi } from '@solus/client-core/host-api'
import type * as Contracts from '@solus/contracts/providers'
import type {
  DraftReview,
  PrCommit,
  PrConversationItem,
  PrLifecycleAction,
  PrReviewer,
  PrReviewerCandidate,
  PullRequestOverview,
  PullRequestUpdate,
  ReviewComment,
  ReviewThread,
} from '@solus/contracts/providers'
import type {
  ChangedFileStat,
  IpcContext,
  MergeMethod,
  PrInterdiffResult,
  PrMergeResult,
  PrReviewContext,
} from '@solus/contracts/types'
import { detached, type ProjectPrs } from './project-prs.svelte'

/** What the Activity tab can paint immediately, without awaiting anything. */
export interface CachedPrActivity {
  detail?: Contracts.PullRequest
  commits?: PrCommit[]
  reviewers?: PrReviewer[]
  comments?: PrConversationItem[]
  changedFiles?: ChangedFileStat[]
}

type ReadOptions = { force?: boolean }

/**
 * What the fields below hold before any response has described the pull
 * request. Nothing renders them: `ProjectPrs.prFor` answers null until
 * `isDescribed`, so a surface sees absence rather than an empty pull request.
 */
const UNDESCRIBED_REPO = { host: '', owner: '', repo: '' }
const UNDESCRIBED_HEAD_REPO = { owner: '', repo: '', isFork: false }
const UNDESCRIBED_CAPABILITIES: Contracts.PullRequest['capabilities'] = {
  diff: false,
  diffFileContents: false,
  inlineComments: false,
  threadReplies: false,
  threadResolution: false,
  reviewVerdicts: [],
  actions: [],
  mergeMethods: [],
  reviewerRequests: false,
  reviewerCandidates: false,
}
const UNDESCRIBED_PERMISSIONS: Contracts.PullRequest['viewerPermissions'] = {
  actions: [],
  reviewVerdicts: [],
  comment: false,
  resolveThreads: false,
  requestReviewers: false,
}

export class PullRequest implements Contracts.PullRequest {
  // What the host has said about this pull request, field by field, because
  // every one of them can change on its own and a surface reads them one at a
  // time. Declared rather than spread so each is its own reactive signal: a
  // merge landing invalidates the state chip, not the whole row.
  url = $state('')
  title = $state('')
  body = $state('')
  state = $state<Contracts.PullRequest['state']>('open')
  draft = $state(false)
  headSha = $state('')
  baseSha = $state('')
  baseRef = $state('')
  headRef = $state('')
  baseRepo = $state<Contracts.PullRequest['baseRepo']>(UNDESCRIBED_REPO)
  headRepo = $state<Contracts.PullRequest['headRepo']>(UNDESCRIBED_HEAD_REPO)
  author = $state('')
  authorAvatarUrl = $state('')
  createdAt = $state('')
  updatedAt = $state('')
  labels = $state<Contracts.PullRequest['labels']>([])
  additions = $state(0)
  deletions = $state(0)
  changedFiles = $state<number | null>(null)
  mergeable = $state<boolean | null>(null)
  mergeStateStatus = $state<string | null>(null)
  capabilities = $state<Contracts.PullRequest['capabilities']>(UNDESCRIBED_CAPABILITIES)
  viewerPermissions = $state<Contracts.PullRequest['viewerPermissions']>(UNDESCRIBED_PERMISSIONS)
  effort = $state<Contracts.PullRequest['effort']>()
  requestedReviewers = $state<string[]>()
  assignees = $state<string[]>()
  reviewAttention = $state<Contracts.PullRequest['reviewAttention']>()
  needsMyReview = $state<boolean>()

  /**
   * False between a number entering the index and the first response about it.
   *
   * A number is not a pull request. Something naming one — a task link, a
   * branch probe, a deep link — creates this so the reads have somewhere to
   * land, and until a response arrives the fields above are defaults rather
   * than anything the host said.
   */
  #described = $state(false)

  constructor(
    private readonly store: ProjectPrs,
    readonly number: number,
  ) {}

  /** True once a host response has described this pull request. */
  get isDescribed(): boolean {
    return this.#described
  }

  /**
   * Take what a response says about this pull request.
   *
   * Field by field rather than by replacing an object, so a surface reading one
   * field is not invalidated by a response that changed another.
   */
  apply(source: Contracts.PullRequest): void {
    this.url = source.url
    this.title = source.title
    this.body = source.body
    this.state = source.state
    this.draft = source.draft
    this.headSha = source.headSha
    this.baseSha = source.baseSha
    this.baseRef = source.baseRef
    this.headRef = source.headRef
    this.baseRepo = source.baseRepo
    this.headRepo = source.headRepo
    this.author = source.author
    this.authorAvatarUrl = source.authorAvatarUrl
    this.createdAt = source.createdAt
    this.updatedAt = source.updatedAt
    this.labels = source.labels
    this.additions = source.additions
    this.deletions = source.deletions
    this.changedFiles = source.changedFiles
    this.mergeable = source.mergeable
    this.mergeStateStatus = source.mergeStateStatus
    this.capabilities = source.capabilities
    this.viewerPermissions = source.viewerPermissions
    this.effort = source.effort
    this.requestedReviewers = source.requestedReviewers
    this.assignees = source.assignees
    this.reviewAttention = source.reviewAttention
    this.needsMyReview = source.needsMyReview
    this.#described = true
  }

  /** The host and context this project reads through. */
  private get api(): HostApi {
    return this.store.hostApi
  }

  private get ctx(): IpcContext {
    return this.store.hostContext
  }

  /** Keyed by number alone: the store this belongs to is the project. */
  private get key(): string {
    return String(this.number)
  }

  /**
   * The parts of the Activity tab already held and still worth showing.
   *
   * Awaiting the loaders would flash every section's skeleton for a microtask
   * even when nothing needs fetching, so the view seeds from this and marks
   * only the misses as loading.
   */
  cachedActivity(): CachedPrActivity {
    return {
      detail: this.store.mirrors.detail.fresh(this.key),
      commits: this.store.mirrors.commits.fresh(this.key),
      reviewers: this.store.mirrors.reviewers.fresh(this.key),
      comments: this.store.mirrors.comments.fresh(this.key),
      changedFiles: this.store.mirrors.changedFiles.fresh(this.key),
    }
  }

  // --- Reads ---------------------------------------------------------------

  /**
   * Detail, commits and reviewers in one request.
   *
   * The response is spread across those three mirrors on arrival, so asking for
   * any of them afterwards costs nothing — and nothing has to consult the
   * overview to find out.
   */
  async loadOverview(opts: ReadOptions = {}): Promise<PullRequestOverview> {
    const ctx = detached(this.ctx)
    const overview = await this.store.mirrors.overview.read(
      this.key,
      !!opts.force,
      () => this.api.prGetOverview(ctx, this.number),
    )
    this.store.mirrors.detail.seed(this.key, overview.pullRequest)
    this.store.mirrors.commits.seed(this.key, overview.commits)
    this.store.mirrors.reviewers.seed(this.key, overview.reviewers)
    this.store.absorb(overview.pullRequest)
    return overview
  }

  async loadDetail(opts: ReadOptions = {}): Promise<PullRequest> {
    const ctx = detached(this.ctx)
    // Every detail response feeds the lookups, the same rule list responses
    // follow — no caller has to remember to index what it read.
    const detail = await this.store.mirrors.detail.read(
      this.key,
      !!opts.force,
      () => this.api.prGetDetail(ctx, this.number),
    )
    return this.store.absorb(detail)
  }

  /**
   * Ask the code host for the current detail rather than trusting either cache.
   *
   * A merge uses the detail's head SHA as its concurrency token. Clearing only
   * this client's mirror can still reach the server's remembered answer, so a
   * pre-merge refresh must invalidate both layers before it reads again.
   */
  async refreshDetail(): Promise<PullRequest> {
    await this.store.forgetHostCache()
    return this.loadDetail({ force: true })
  }

  async loadCommits(opts: ReadOptions = {}): Promise<PrCommit[]> {
    const ctx = detached(this.ctx)
    return this.store.mirrors.commits.read(this.key, !!opts.force, () => this.api.prListCommits(ctx, this.number))
  }

  async loadReviewers(opts: ReadOptions = {}): Promise<PrReviewer[]> {
    const ctx = detached(this.ctx)
    return this.store.mirrors.reviewers.read(this.key, !!opts.force, () => this.api.prListReviewers(ctx, this.number))
  }

  async loadReviewerCandidates(opts: ReadOptions = {}): Promise<PrReviewerCandidate[]> {
    const ctx = detached(this.ctx)
    return this.store.mirrors.reviewerCandidates.read(
      this.key,
      !!opts.force,
      () => this.api.prListReviewerCandidates(ctx, this.number),
    )
  }

  async loadThreads(opts: ReadOptions = {}): Promise<ReviewThread[]> {
    const ctx = detached(this.ctx)
    return this.store.mirrors.threads.read(this.key, !!opts.force, () => this.api.prListThreads(ctx, this.number))
  }

  async loadComments(opts: ReadOptions = {}): Promise<PrConversationItem[]> {
    const ctx = detached(this.ctx)
    return this.store.mirrors.comments.read(this.key, !!opts.force, () => this.api.prListComments(ctx, this.number))
  }

  async loadChangedFiles(opts: ReadOptions = {}): Promise<ChangedFileStat[]> {
    const ctx = detached(this.ctx)
    return this.store.mirrors.changedFiles.read(this.key, !!opts.force, () => this.api.prChangedFiles(ctx, this.number))
  }

  async loadInterdiff(pr: PrReviewContext, opts: ReadOptions = {}): Promise<PrInterdiffResult> {
    const ctx = detached(this.ctx)
    const target = detached(pr)
    return this.store.mirrors.interdiff.read(
      `${this.key}::${pr.headSha}::${pr.baseSha}`,
      !!opts.force,
      () => this.api.prInterdiff(ctx, target),
    )
  }

  /**
   * Warm every read the review surface makes, at the moment this is opened.
   *
   * The worktree fetch that gates the pane is far slower than these, so they
   * land first and the Activity tab paints filled. Rejections are swallowed:
   * the surface re-requests through the same mirrors and owns the error banner.
   */
  prefetch(): void {
    void this.loadOverview().catch(() => {})
    void this.loadComments().catch(() => {})
    void this.loadChangedFiles().catch(() => {})
    void this.loadThreads().catch(() => {})
    void this.store.loadViewer().catch(() => {})
  }

  // --- Writes --------------------------------------------------------------

  /** Rewrite the title or body. */
  async update(patch: PullRequestUpdate): Promise<PullRequest> {
    const updated = await this.api.prUpdate(detached(this.ctx), this.number, patch)
    return this.store.applyPullRequest(updated)
  }

  async requestReviewers(logins: string[]): Promise<PrReviewer[]> {
    const reviewers = await this.api.prRequestReviewers(detached(this.ctx), this.number, logins)
    this.store.mirrors.reviewers.seed(this.key, reviewers)
    return reviewers
  }

  async removeRequestedReviewer(login: string): Promise<PrReviewer[]> {
    const reviewers = await this.api.prRemoveRequestedReviewer(detached(this.ctx), this.number, login)
    this.store.mirrors.reviewers.seed(this.key, reviewers)
    return reviewers
  }

  /** Close, reopen, mark ready, or return to draft. */
  async updateLifecycle(
    action: Exclude<PrLifecycleAction, 'merge'>,
    expectedHeadSha: string,
  ): Promise<PullRequest> {
    const detail = await this.api.prUpdateLifecycle(detached(this.ctx), this.number, action, expectedHeadSha)
    return this.store.applyPullRequest(detail)
  }

  /**
   * Merge, and index whatever the host says the pull request became.
   *
   * The head this client last saw is the concurrency token, so it is read here
   * rather than passed in: a caller holding an older copy than the index would
   * otherwise send a head the user never actually looked at.
   */
  async merge(method: MergeMethod): Promise<PrMergeResult> {
    const expectedHeadSha = this.headSha
    if (!expectedHeadSha) throw new Error('The pull request is not loaded.')
    const result = await this.api.prMerge(detached(this.ctx), this.number, method, expectedHeadSha)
    if (result.detail) this.store.applyPullRequest(result.detail)
    return result
  }

  /**
   * Reply to a review thread.
   *
   * The threads mirror is dropped rather than patched: the reply's position in
   * its thread, and whether posting it resolved the thread, are the host's to
   * say. Callers re-read through `loadThreads`.
   */
  async replyToThread(threadId: string, body: string): Promise<ReviewComment> {
    const comment = await this.api.prReplyThread(detached(this.ctx), this.number, threadId, body)
    this.store.mirrors.threads.delete(this.key)
    return comment
  }

  async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
    const ctx = detached(this.ctx)
    if (resolved) await this.api.prResolveThread(ctx, this.number, threadId)
    else await this.api.prUnresolveThread(ctx, this.number, threadId)
    this.store.mirrors.threads.delete(this.key)
  }

  /** Post a conversation comment. The comment list is dropped rather than
   *  extended: the host copy is the one that survives a reload. */
  async addComment(body: string): Promise<void> {
    await this.api.prAddIssueComment(detached(this.ctx), this.number, body)
    this.store.mirrors.comments.delete(this.key)
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.api.prDeleteIssueComment(detached(this.ctx), this.number, commentId)
    this.store.mirrors.comments.delete(this.key)
  }

  /** Submit a draft review. Its body joins the conversation and its comments
   *  become threads, so both mirrors are dropped. */
  async submitReview(review: DraftReview): Promise<void> {
    await this.api.prSubmitReview(detached(this.ctx), this.number, review)
    this.store.mirrors.threads.delete(this.key)
    this.store.mirrors.comments.delete(this.key)
  }
}
