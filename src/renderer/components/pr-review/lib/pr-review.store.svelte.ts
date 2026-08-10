import { untrack } from 'svelte'
import type { ReviewComment, ReviewThread } from '../../../../shared/providers'
import type { DiffScope, IpcContext, PrInterdiffResult, PrReviewContext } from '../../../../shared/types'
import { worktreeProjectRoot } from '../../../../shared/types'
import type { DiffBase } from '../../../../shared/stack-types'
import { reviewGuideKeyForBase } from '../../../../shared/review'
import { ReviewDrafts } from '../../review/lib/review-drafts.svelte'
import { interdiffReviewThreads } from '../../diff/lib/interdiff-annotations'
import { matchedReviewComments } from './since-review'
import type { HostApi } from '@client-core/host-api'
import { hostKey } from '@client-core/host-key'

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

  /** The checked-out worktree. Null through the pending phase, before the
   *  fetch/checkout lands; everything that reads the checkout waits for it. */
  pr = $state<PrReviewContext | null>(null)

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

  /**
   * Review data belongs to the checked-out worktree, not to whichever chat
   * happens to be attached. Both contexts key `PrsStore`'s caches by project
   * root, so reads made while the worktree is still checking out stay warm once
   * it lands.
   */
  get ctx(): IpcContext {
    const review = this.pr
    return review
      ? this.#deps.ctxForDirectory(worktreeProjectRoot(review.worktreePath))
      : this.#deps.fallbackCtx()
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

  /** Guides are keyed by the local review branch, so one exists only once the
   *  worktree does. Every read is gated on `stackReady`, which the pending phase
   *  never reaches, so the empty key is never used. */
  get guideKey(): string {
    return this.pr ? this.pr.branch.replace(/\//g, '__') : ''
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
    const review = this.pr
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
    if (!base || !review) {
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
  loadStacks: (ctx: IpcContext) => Promise<unknown>
  loadThreads: (ctx: IpcContext, number: number, force: boolean) => Promise<ReviewThread[]>
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
export function prReviewState(serverId: string, number: number, deps: PrReviewDeps): PrReviewState {
  const key = hostKey(serverId, String(number))
  const existing = states.get(key)
  if (existing) return existing
  const created = new PrReviewState(number, deps)
  states.set(key, created)
  return created
}

/** Read-only lookup for surfaces that must not create state they can't fill —
 *  the popped-out diff exists only alongside a review that already opened. */
export function existingPrReviewState(serverId: string, number: number): PrReviewState | undefined {
  return states.get(hostKey(serverId, String(number)))
}
