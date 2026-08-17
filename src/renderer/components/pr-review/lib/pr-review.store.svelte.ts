import { untrack } from 'svelte'
import type { PrCommit, PrDiffSlice, PrReviewTarget, ReviewComment, ReviewThread } from '../../../../shared/providers'
import type { DiffScope, IpcContext, PrCheckoutContext, PrInterdiffResult, PrRepoCheckoutFailureReason, PrRepoCheckoutResult, PrReviewContext } from '../../../../shared/types'
import { worktreeProjectRoot } from '../../../../shared/types'
import type { DiffBase, StackGraph } from '../../../../shared/stack-types'
import { reviewGuideKeyForBase } from '../../../../shared/review'
import { ReviewDrafts } from '../../review/lib/review-drafts.svelte'
import { interdiffReviewThreads } from '../../diff/lib/interdiff-annotations'
import { matchedReviewComments } from './since-review'
import type { HostApi } from '@client-core/host-api'
import { hostKey } from '@client-core/host-key'
import { TransportDisconnectedError } from '@client-core/ws-transport'
import type { FileDiffLoadedFiles, FileDiffMetadata } from '@pierre/diffs'

/**
 * One pull request's review state, shared by every surface that shows it.
 *
 * The review pane and its popped-out diff are two panes over the *same* review,
 * so this cannot be component-local: two `ReviewDrafts` instances over one
 * `.solus/review-state/<key>.json` would silently diverge, and a comment
 * written in the diff would not exist for the review that submits it. The
 * threads and the interdiff are merely wasteful to fetch twice; the drafts are
 * wrong to own twice.
 *
 * Instances are keyed by PR number and live for as long as the app does — the
 * loads underneath are all cached in `PrsStore` anyway, so a re-entered review
 * costs nothing and keeps whatever was already read.
 */
export class PrReviewState {
  readonly number: number

  /** Host identity is available without a checkout. */
  pr = $state<PrReviewTarget | null>(null)
  checkout = $state<PrCheckoutContext | null>(null)
  checkoutStatus = $state<'idle' | 'preparing' | 'ready' | 'failed'>('idle')
  checkoutError = $state<string | null>(null)

  // ── Explicit "check out in the current repository" destination ──
  // A distinct status from `checkoutStatus`: the two destinations run
  // independently, and the UI needs to know which one a failure belongs to.
  repoCheckoutStatus = $state<'idle' | 'preparing' | 'ready' | 'failed'>('idle')
  repoCheckoutError = $state<string | null>(null)
  repoCheckoutReason = $state<PrRepoCheckoutFailureReason | null>(null)
  /** Set only when `repoCheckoutReason` is `'branch-in-use'`. */
  repoCheckoutWorktreePath = $state<string | null>(null)

  // ── Host diff ──
  diffPatch = $state<string | null>(null)
  diffLoading = $state(false)
  diffError = $state<string | null>(null)
  diffTruncated = $state(false)

  // ── Commit scope ──
  // One commit of the change rather than the whole of it. Scoped state lives
  // apart from the full diff so leaving the commit returns to an intact review.
  commitScope = $state<PrCommit | null>(null)
  commitDiffPatch = $state<string | null>(null)
  commitDiffLoading = $state(false)
  commitDiffError = $state<string | null>(null)
  commitDiffTruncated = $state(false)

  // ── Threads ──
  // Existing GitHub inline review comments. Fetched once and shared with the
  // diff (anchored at their line) and Activity (which owns reply / resolve,
  // mutating these objects in place) — the heaviest read, made once.
  threads = $state<ReviewThread[]>([])
  threadsLoadFailed = $state(false)

  // ── Since-review interdiff ──
  interdiff = $state<PrInterdiffResult | null>(null)
  showingSinceReview = $state(false)

  // ── Stack / diff base ──
  stackReady = $state(false)
  stackLoadFailed = $state(false)
  /** Whether the stacked view is showing the full diff rather than own-delta. */
  showingFullDiff = $state(false)
  ownDeltaFileCount = $state<number | null>(null)

  /**
   * A file the review asked its popped-out diff to show. Carried here rather
   * than called on the pane, because the jump is usually made in the same tick
   * the diff pane is opened — before it exists to be called. The pane consumes
   * whatever is set once it mounts; `epoch` makes asking for the same file
   * twice a second request rather than a no-op.
   */
  pendingJump = $state<{ path: string; line?: number; side: 'old' | 'new'; epoch: number } | null>(null)

  readonly drafts: ReviewDrafts

  #deps: PrReviewDeps
  #interdiffKey = ''
  #diffKey = ''
  #commitDiffKey = ''
  #checkoutPromise: Promise<PrReviewContext> | null = null
  #repoCheckoutPromise: Promise<PrRepoCheckoutResult> | null = null

  constructor(number: number, deps: PrReviewDeps) {
    this.number = number
    this.#deps = deps
    this.drafts = new ReviewDrafts({
      getApi: deps.getApi,
      getCtx: () => this.ctx,
      getKey: () => this.effectiveGuideKey,
    })
  }

  get api(): HostApi {
    return this.#deps.getApi()
  }

  /** Provider data belongs to the project host. Source-dependent reads switch
   * to the optional checkout context after a requesting action prepares it. */
  get ctx(): IpcContext {
    const checkout = this.checkout
    return checkout
      ? this.#deps.ctxForDirectory(worktreeProjectRoot(checkout.worktreePath))
      : this.#deps.fallbackCtx()
  }

  get sourceContext(): PrReviewContext | null {
    const target = this.pr
    const checkout = this.checkout
    return target && checkout && target.headSha === checkout.headSha && target.baseSha === checkout.baseSha
      ? { ...target, ...checkout }
      : null
  }

  setTarget(target: PrReviewTarget | null): void {
    // This command is called from an effect that tracks the target prop. Do not
    // also subscribe that effect to the state it updates, or each assignment
    // schedules the target sync again and repeatedly reloads the stack.
    const changedRevision = untrack(() => {
      const previous = this.pr
      return previous?.host !== target?.host
        || previous?.owner !== target?.owner
        || previous?.repo !== target?.repo
        || previous?.number !== target?.number
        || previous?.baseSha !== target?.baseSha
        || previous?.headSha !== target?.headSha
    })
    this.pr = target
    if (!changedRevision) return
    this.checkout = null
    this.checkoutStatus = 'idle'
    this.checkoutError = null
    this.interdiff = null
    this.showingSinceReview = false
    this.stackReady = false
    this.stackLoadFailed = false
    // A moved head may have dropped the scoped commit (force push / new PR);
    // never strand the reader on a commit the revision no longer has.
    this.commitScope = null
    this.commitDiffPatch = null
    this.commitDiffError = null
    this.commitDiffTruncated = false
    this.commitDiffLoading = false
    this.#commitDiffKey = ''
  }

  get liveDiffBase(): DiffBase {
    const review = this.pr
    return this.#deps.stackedPrsEnabled() && review && this.stackReady && !this.stackLoadFailed
      ? this.#deps.resolveDiffBase(review.number, review.baseRef)
      : { kind: 'target', ref: review?.baseRef ?? '' }
  }

  get ownDeltaBase(): { parent: number; headSha: string } | null {
    const base = this.liveDiffBase
    return base.kind === 'own-delta' && base.parent
      ? { parent: base.parent, headSha: base.ref }
      : null
  }

  /** The deterministic review branch key also finds a cached guide before the
   * checkout exists. Generating a new guide still requires `ensureCheckout`. */
  get guideKey(): string {
    return this.pr ? (this.checkout?.branch ?? `solus/pr-${this.pr.number}`).replace(/\//g, '__') : ''
  }

  get effectiveGuideKey(): string {
    return reviewGuideKeyForBase(this.guideKey, this.ownDeltaBase?.headSha)
  }

  get diffScope(): DiffScope {
    const base = this.ownDeltaBase
    const review = this.pr
    return base && !this.showingFullDiff
      ? {
          kind: 'pr',
          baseSha: review?.baseSha ?? '',
          ownDeltaBaseSha: base.headSha,
          parentPr: base.parent,
        }
      : { kind: 'pr', baseSha: review?.baseSha ?? '' }
  }

  get hasReviewCheckpointNotice(): boolean {
    return this.interdiff?.state === 'changed' || this.interdiff?.state === 'invalid'
  }

  /** "Since your last review" only applies to a plain target diff — an
   *  own-delta base is already a narrowed view. */
  get isSinceReviewMode(): boolean {
    return !this.ownDeltaBase && this.interdiff?.state === 'changed' && this.showingSinceReview
  }

  get sinceReviewThreads(): ReviewThread[] {
    return this.isSinceReviewMode && this.interdiff
      ? interdiffReviewThreads(matchedReviewComments(this.interdiff))
      : []
  }

  get unresolvedCount(): number {
    return this.threads.filter((thread) => !thread.isResolved).length
  }

  // ── Loads ──

  loadStack(): void {
    this.stackReady = false
    this.stackLoadFailed = false
    if (!this.pr) return
    if (!this.checkout) {
      this.stackReady = true
      return
    }
    void this.#deps
      .loadStacks(this.ctx)
      .catch(() => (this.stackLoadFailed = true))
      .finally(() => (this.stackReady = true))
  }

  loadThreads(force = false): void {
    this.threadsLoadFailed = false
    void this.#deps
      .loadThreads(this.ctx, this.number, force)
      .then((threads) => (this.threads = threads))
      .catch(() => {
        // Surfaced through the Activity tab's error banner rather than a toast,
        // so a dead provider doesn't read as "no threads".
        this.threadsLoadFailed = true
      })
  }

  loadInterdiff(force = false): void {
    const review = this.sourceContext
    if (!review) return
    const key = `${review.number}:${review.baseSha}:${review.headSha}`
    const shouldDefaultMode = key !== this.#interdiffKey || force
    this.#interdiffKey = key
    void this.#deps
      .loadInterdiff(this.ctx, review, force)
      .then((result) => {
        if (`${this.pr?.number}:${this.pr?.baseSha}:${this.pr?.headSha}` !== key) return
        this.interdiff = result
        if (shouldDefaultMode) this.showingSinceReview = result.state === 'changed'
      })
      .catch(() => {
        if (`${this.pr?.number}:${this.pr?.baseSha}:${this.pr?.headSha}` === key) this.interdiff = null
      })
  }

  loadDrafts(): void {
    if (!this.stackReady) return
    void untrack(() => this.drafts.load())
  }

  loadOwnDeltaFileCount(): void {
    const base = this.ownDeltaBase
    const review = this.pr
    if (!base || !review || !this.checkout) {
      this.ownDeltaFileCount = null
      return
    }
    const key = `${review.number}:${review.headSha}:${base.headSha}`
    this.ownDeltaFileCount = null
    void this.#deps
      .diffStats(this.ctx, {
        kind: 'pr',
        baseSha: review.baseSha,
        ownDeltaBaseSha: base.headSha,
        parentPr: base.parent,
      })
      .then((count) => {
        if (`${this.pr?.number}:${this.pr?.headSha}:${this.ownDeltaBase?.headSha ?? ''}` === key) {
          this.ownDeltaFileCount = count
        }
      })
      .catch(() => {})
  }

  requestJump(path: string, line?: number | null, side: 'old' | 'new' = 'new'): void {
    this.pendingJump = {
      path,
      line: line ?? undefined,
      side,
      epoch: (this.pendingJump?.epoch ?? 0) + 1,
    }
  }

  loadDiff(force = false): void {
    const target = this.pr
    if (!target) return
    const key = `${target.host}/${target.owner}/${target.repo}:${target.number}:${target.baseSha}:${target.headSha}`
    if (!force && (this.#diffKey === key && (this.diffPatch !== null || this.diffLoading))) return
    this.#diffKey = key
    this.diffPatch = null
    this.diffError = null
    this.diffTruncated = false
    this.diffLoading = true
    const context = this.#deps.fallbackCtx()
    void (async () => {
      const patches: string[] = []
      let cursor: string | undefined
      do {
        const request: import('../../../../shared/providers').PrDiffRequest = {
          number: target.number,
          baseSha: target.baseSha,
          headSha: target.headSha,
        }
        if (cursor) request.cursor = cursor
        const slice: PrDiffSlice = await this.#deps.loadDiff(context, request)
        if (`${this.pr?.host}/${this.pr?.owner}/${this.pr?.repo}:${this.pr?.number}:${this.pr?.baseSha}:${this.pr?.headSha}` !== key) return
        if (slice.patch) patches.push(slice.patch)
        this.diffTruncated ||= slice.truncated
        cursor = slice.nextCursor ?? undefined
      } while (cursor)
      if (`${this.pr?.host}/${this.pr?.owner}/${this.pr?.repo}:${this.pr?.number}:${this.pr?.baseSha}:${this.pr?.headSha}` === key) {
        this.diffPatch = patches.join('\n')
      }
    })().catch((error) => {
      if (`${this.pr?.host}/${this.pr?.owner}/${this.pr?.repo}:${this.pr?.number}:${this.pr?.baseSha}:${this.pr?.headSha}` === key) {
        this.diffError = error instanceof Error ? error.message : String(error)
      }
    }).finally(() => {
      if (`${this.pr?.host}/${this.pr?.owner}/${this.pr?.repo}:${this.pr?.number}:${this.pr?.baseSha}:${this.pr?.headSha}` === key) this.diffLoading = false
    })
  }

  /** Scope the diff surfaces to one commit of the pull request. */
  viewCommit(commit: PrCommit): void {
    this.commitScope = commit
    this.loadCommitDiff()
  }

  clearCommitScope(): void {
    this.commitScope = null
  }

  loadCommitDiff(force = false): void {
    const target = this.pr
    const commit = this.commitScope
    if (!target || !commit) return
    const key = `${target.host}/${target.owner}/${target.repo}:${target.number}:${commit.sha}`
    if (!force && this.#commitDiffKey === key && (this.commitDiffPatch !== null || this.commitDiffLoading)) return
    this.#commitDiffKey = key
    this.commitDiffPatch = null
    this.commitDiffError = null
    this.commitDiffTruncated = false
    this.commitDiffLoading = true
    const context = this.#deps.fallbackCtx()
    // Guarded on the key, not the scope: clearing the scope mid-load lets the
    // load finish into the cache, so re-opening the same commit is instant.
    const current = () => this.#commitDiffKey === key
    void (async () => {
      const patches: string[] = []
      let cursor: string | undefined
      do {
        const slice: PrDiffSlice = await this.#deps.loadDiff(context, {
          number: target.number,
          baseSha: target.baseSha,
          headSha: target.headSha,
          commitSha: commit.sha,
          ...(cursor ? { cursor } : {}),
        })
        if (!current()) return
        if (slice.patch) patches.push(slice.patch)
        this.commitDiffTruncated ||= slice.truncated
        cursor = slice.nextCursor ?? undefined
      } while (cursor)
      if (current()) this.commitDiffPatch = patches.join('\n')
    })().catch((error) => {
      if (current()) this.commitDiffError = error instanceof Error ? error.message : String(error)
    }).finally(() => {
      if (current()) this.commitDiffLoading = false
    })
  }

  ensureCheckout(): Promise<PrReviewContext> {
    const target = this.pr
    if (!target) return Promise.reject(new Error('The pull request is not ready.'))
    const ready = this.sourceContext
    if (ready) return Promise.resolve(ready)
    if (this.#checkoutPromise) return this.#checkoutPromise
    this.checkoutStatus = 'preparing'
    this.checkoutError = null
    const headSha = target.headSha
    const baseSha = target.baseSha
    const promise = this.#deps.prepareCheckout(this.#deps.fallbackCtx(), target)
      .then((checkout) => {
        if (this.pr?.headSha !== headSha || this.pr?.baseSha !== baseSha || checkout.headSha !== headSha || checkout.baseSha !== baseSha) {
          throw new Error('The pull request changed while its checkout was being prepared.')
        }
        this.checkout = checkout
        this.checkoutStatus = 'ready'
        this.loadStack()
        return { ...target, ...checkout }
      })
      .catch((error) => {
        this.checkoutStatus = 'failed'
        this.checkoutError = error instanceof Error ? error.message : String(error)
        throw error
      })
      .finally(() => {
        if (this.#checkoutPromise === promise) this.#checkoutPromise = null
      })
    this.#checkoutPromise = promise
    return promise
  }

  /** The explicit "check out in the current repository" destination. Unlike
   *  `ensureCheckout`, a structured failure (stale head, dirty, conflicted,
   *  branch in use) is not thrown — it is reported through `repoCheckout*`
   *  state so the confirm UI can show the specific reason. Only a transport
   *  failure (a disconnected host) throws. */
  async checkoutInRepo(): Promise<PrRepoCheckoutResult> {
    const target = this.pr
    if (!target) throw new Error('The pull request is not ready.')
    if (this.#repoCheckoutPromise) return this.#repoCheckoutPromise
    this.repoCheckoutStatus = 'preparing'
    this.repoCheckoutError = null
    this.repoCheckoutReason = null
    this.repoCheckoutWorktreePath = null
    const promise = this.#deps.checkoutInRepo(this.#deps.fallbackCtx(), target)
      .then((result) => {
        if (result.success) {
          this.repoCheckoutStatus = 'ready'
        } else {
          this.repoCheckoutStatus = 'failed'
          this.repoCheckoutReason = result.reason ?? 'generic'
          this.repoCheckoutError = result.error ?? 'Checkout failed.'
          this.repoCheckoutWorktreePath = result.worktreePath ?? null
        }
        return result
      })
      .catch((error) => {
        this.repoCheckoutStatus = 'failed'
        this.repoCheckoutReason = error instanceof TransportDisconnectedError ? 'disconnected' : 'generic'
        this.repoCheckoutError = error instanceof Error ? error.message : String(error)
        throw error
      })
      .finally(() => {
        if (this.#repoCheckoutPromise === promise) this.#repoCheckoutPromise = null
      })
    this.#repoCheckoutPromise = promise
    return promise
  }

  loadDiffFiles = async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
    const target = this.pr
    if (!target) throw new Error('The pull request is not ready.')
    const result = await this.api.prGetDiffFileContents(this.#deps.fallbackCtx(), {
      number: target.number,
      baseSha: target.baseSha,
      headSha: target.headSha,
      oldPath: fileDiff.prevName ?? fileDiff.name,
      newPath: fileDiff.name,
      changeType: fileDiff.type,
    })
    if (this.pr?.headSha !== target.headSha) {
      throw new Error('The pull request changed while file contents were loading.')
    }
    const oldFile = {
      name: fileDiff.prevName ?? fileDiff.name,
      contents: result.oldContents,
      cacheKey: `${target.baseSha}:${fileDiff.prevName ?? fileDiff.name}`,
    }
    const newFile = {
      name: fileDiff.name,
      contents: result.newContents,
      cacheKey: `${target.headSha}:${fileDiff.name}`,
    }
    return { oldFile: fileDiff.type === 'rename-pure' ? null : oldFile, newFile }
  }

  /** Context expansion for a commit-scoped patch: the old side of every file is
   *  the commit's parent, which the provider resolves from the sha. */
  loadCommitDiffFiles = async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
    const target = this.pr
    const commit = this.commitScope
    if (!target || !commit) throw new Error('The pull request is not ready.')
    const result = await this.api.prGetDiffFileContents(this.#deps.fallbackCtx(), {
      number: target.number,
      baseSha: target.baseSha,
      headSha: target.headSha,
      commitSha: commit.sha,
      oldPath: fileDiff.prevName ?? fileDiff.name,
      newPath: fileDiff.name,
      changeType: fileDiff.type,
    })
    const oldFile = {
      name: fileDiff.prevName ?? fileDiff.name,
      contents: result.oldContents,
      cacheKey: `${commit.sha}^:${fileDiff.prevName ?? fileDiff.name}`,
    }
    const newFile = {
      name: fileDiff.name,
      contents: result.newContents,
      cacheKey: `${commit.sha}:${fileDiff.name}`,
    }
    return { oldFile: fileDiff.type === 'rename-pure' ? null : oldFile, newFile }
  }

  // ── Thread mutation ──

  replyToThread(threadId: string, body: string): Promise<ReviewComment> {
    return this.#deps.replyThread(this.ctx, this.number, threadId, body)
  }

  resolveThread(threadId: string, resolved: boolean): Promise<void> {
    return this.#deps.resolveThread(this.ctx, this.number, threadId, resolved)
  }
}

/** Everything the state needs from the workspace, passed in rather than reached
 *  for, so this stays a plain class the panes can construct and test. */
export interface PrReviewDeps {
  getApi: () => HostApi
  fallbackCtx: () => IpcContext
  ctxForDirectory: (path: string) => IpcContext
  stackedPrsEnabled: () => boolean
  resolveDiffBase: (number: number, baseRef: string) => DiffBase
  loadStacks: (ctx: IpcContext) => Promise<StackGraph>
  loadThreads: (ctx: IpcContext, number: number, force: boolean) => Promise<ReviewThread[]>
  loadDiff: (ctx: IpcContext, request: import('../../../../shared/providers').PrDiffRequest) => Promise<PrDiffSlice>
  prepareCheckout: (ctx: IpcContext, target: PrReviewTarget) => Promise<PrCheckoutContext>
  checkoutInRepo: (ctx: IpcContext, target: PrReviewTarget) => Promise<PrRepoCheckoutResult>
  loadInterdiff: (ctx: IpcContext, pr: PrReviewContext, force: boolean) => Promise<PrInterdiffResult>
  diffStats: (ctx: IpcContext, scope: DiffScope) => Promise<number>
  replyThread: (ctx: IpcContext, number: number, threadId: string, body: string) => Promise<ReviewComment>
  resolveThread: (ctx: IpcContext, number: number, threadId: string, resolved: boolean) => Promise<void>
}

// This is an identity cache, not renderer state. Making the map reactive causes
// the first lookup from a `$derived` consumer to mutate Svelte state while that
// derived is being evaluated (`state_unsafe_mutation`). The values themselves
// remain reactive `PrReviewState` instances.
const states = new Map<string, PrReviewState>()

/** The review state for one PR — the same instance for every surface showing
 *  it, which is what keeps the review and its popped-out diff one review. */
export function prReviewState(serverId: string, projectScope: string, number: number, deps: PrReviewDeps): PrReviewState {
  const key = hostKey(serverId, `${projectScope}::${number}`)
  const existing = states.get(key)
  if (existing) return existing
  const created = new PrReviewState(number, deps)
  states.set(key, created)
  return created
}

/** Read-only lookup for surfaces that must not create state they can't fill —
 *  the popped-out diff exists only alongside a review that already opened. */
export function existingPrReviewState(serverId: string, projectScope: string, number: number): PrReviewState | undefined {
  return states.get(hostKey(serverId, `${projectScope}::${number}`))
}
