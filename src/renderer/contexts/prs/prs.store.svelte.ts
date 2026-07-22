import type {
  PullRequestSummary,
  PullRequestOverview,
  PullRequestDetail,
  PrCommit,
  PrConversationItem,
  PrFilter,
  PrListPage,
  PrReviewer,
  ReviewThread,
} from '../../../shared/providers'
import type { ChangedFileStat, IpcContext, PrInterdiffResult, PrReviewContext } from '../../../shared/types'
import type { PrChecksSummary } from '../../../shared/checks-types'
import type { PrGuideMetadata, PrGuideStatus } from '../../../shared/review'
import type { PrChecksSnapshot } from '../../../shared/checks-rpc-types'
import { SvelteMap } from 'svelte/reactivity'
import { toasts } from '../app/toast.store.svelte'

const PR_CACHE_TTL_MS = 30_000
const NEEDS_REVIEW_POLL_MS = 5 * 60_000

interface CacheEntry<T> {
  value?: T
  loadedAt: number
  inFlight?: Promise<T>
}

export class PrsStore {
  items = $state<PullRequestSummary[]>([])
  needsReviewItems = $state<PullRequestSummary[]>([])
  needsReviewOnly = $state(false)
  loading = $state(false)
  loadingMore = $state(false)
  loaded = $state(false)
  hasMore = $state(false)
  nextPage = $state(1)
  filter = $state<PrFilter>({ state: 'open' })
  checks = new SvelteMap<number, PrChecksSummary>()
  checksLoadFailed = $state(false)
  /** Active content tab of the `pr-review` surface. Lifted out of PrReviewPane so
   *  chrome around it can react to the selection. Chat is NOT a content tab — it
   *  is the primary conversation, toggled by `maximized`. */
  prReviewTab = $state<'activity' | 'guide' | 'diff'>('guide')
  /** Fixed launch snapshot for Review Mode. The session store owns subsequent
   *  ordering and dispositions, so list refreshes cannot move the active PR. */
  reviewModeNumbers = $state<number[]>([])
  reviewModeContext = $state<IpcContext | null>(null)
  /** Lifecycle of explicitly requested guide generations, shared by the PRs
   *  page and the Activity tab so both surfaces reflect one queue. */
  guideStatus = new SvelteMap<number, PrGuideStatus>()
  guideMetadata = new SvelteMap<number, PrGuideMetadata>()

  private checksRepoKey: string | null = null
  private guideStatusRepoRoot: string | null = null
  private guideMetadataContextKey: string | null = null
  private readonly requestedGuideNumbers = new Set<number>()
  private requestedGuidesAction: (() => void) | null = null
  private needsReviewContextKey = ''
  private needsReviewLoadSeq = 0
  private needsReviewInFlight: { key: string; promise: Promise<void> } | null = null
  private reviewSurfaceOpen = false

  private readonly listCache = new Map<string, CacheEntry<PrListPage>>()
  private readonly effortLoaded = new Set<string>()
  private readonly effortInFlight = new Set<string>()
  private readonly overviewCache = new Map<string, CacheEntry<PullRequestOverview>>()
  private readonly detailCache = new Map<string, CacheEntry<PullRequestDetail>>()
  private readonly commitsCache = new Map<string, CacheEntry<PrCommit[]>>()
  private readonly reviewersCache = new Map<string, CacheEntry<PrReviewer[]>>()
  private readonly threadsCache = new Map<string, CacheEntry<ReviewThread[]>>()
  private readonly commentsCache = new Map<string, CacheEntry<PrConversationItem[]>>()
  private readonly changedFilesCache = new Map<string, CacheEntry<ChangedFileStat[]>>()
  private readonly interdiffCache = new Map<string, CacheEntry<PrInterdiffResult>>()
  private readonly viewerCache = new Map<string, CacheEntry<string>>()

  beginReviewMode(numbers: number[], ctx: IpcContext): void {
    this.reviewModeNumbers.splice(0, this.reviewModeNumbers.length, ...numbers)
    this.reviewModeContext = structuredClone($state.snapshot(ctx))
  }

  private contextKey(ctx: IpcContext): string {
    return ctx.session.projectPath || ctx.session.workingDirectory || ''
  }

  private listKey(ctx: IpcContext, filter: PrFilter, page = 1): string {
    return `${this.contextKey(ctx)}::${filter.state ?? 'open'}::${filter.author ?? ''}::${page}`
  }

  private prKey(ctx: IpcContext, number: number): string {
    return `${this.contextKey(ctx)}::${number}`
  }

  private isFresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> & { value: T } {
    return entry?.value !== undefined && Date.now() - entry.loadedAt < PR_CACHE_TTL_MS
  }

  private async readCached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    force: boolean,
    load: () => Promise<T>,
  ): Promise<T> {
    const entry = cache.get(key)
    if (!force) {
      if (this.isFresh(entry)) return entry.value
      if (entry?.inFlight) return entry.inFlight
    }

    const inFlight = load()
      .then((value) => {
        cache.set(key, { value, loadedAt: Date.now() })
        return value
      })
      .finally(() => {
        const current = cache.get(key)
        if (current?.inFlight !== inFlight) return
        if (current.value !== undefined) cache.set(key, { value: current.value, loadedAt: current.loadedAt })
        else cache.delete(key)
      })
    cache.set(key, { value: entry?.value, loadedAt: entry?.loadedAt ?? 0, inFlight })
    return inFlight
  }

  private seed<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
    cache.set(key, { value, loadedAt: Date.now() })
  }

  private seedOverview(ctx: IpcContext, number: number, overview: PullRequestOverview): void {
    const key = this.prKey(ctx, number)
    this.seed(this.detailCache, key, overview.detail)
    this.seed(this.commitsCache, key, overview.commits)
    this.seed(this.reviewersCache, key, overview.reviewers)
  }

  async loadFor(
    ctx: IpcContext,
    filter: PrFilter,
    opts: { force?: boolean; page?: number } = {},
  ): Promise<PrListPage> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    const safeFilter = JSON.parse(JSON.stringify(filter)) as PrFilter
    const page = opts.page ?? 1
    return this.readCached(
      this.listCache,
      this.listKey(ctx, safeFilter, page),
      !!opts.force,
      () => window.solus.prList(safeCtx, safeFilter, page),
    )
  }

  private async loadEveryPage(ctx: IpcContext, filter: PrFilter, force = false): Promise<PullRequestSummary[]> {
    const items: PullRequestSummary[] = []
    for (let page = 1; ; page++) {
      const result = await this.loadFor(ctx, filter, { force, page })
      items.push(...result.items)
      if (!result.hasMore) return items
    }
  }

  async loadAll(ctx: IpcContext, opts: { force?: boolean } = {}): Promise<void> {
    const filter = JSON.parse(JSON.stringify(this.filter)) as PrFilter
    const key = this.listKey(ctx, filter, 1)
    if (opts.force) {
      const prefix = key.slice(0, key.lastIndexOf('::') + 2)
      for (const cacheKey of this.listCache.keys()) if (cacheKey.startsWith(prefix)) this.listCache.delete(cacheKey)
    }
    this.loading = true
    try {
      const result = await this.loadFor(ctx, filter, opts)
      if (this.listKey(ctx, this.filter, 1) !== key) return
      this.items = result.items
      this.hasMore = result.hasMore
      this.nextPage = result.page + 1
      this.loaded = true
      void this.loadChecks(ctx, result.items.map((item) => item.number)).catch(() => { this.checksLoadFailed = true })
      void this.loadGuideMetadata(ctx, result.items).catch(() => {})
    } finally {
      this.loading = false
    }
  }

  async loadMore(ctx: IpcContext): Promise<void> {
    if (!this.hasMore || this.loadingMore) return
    const filter = JSON.parse(JSON.stringify(this.filter)) as PrFilter
    const key = this.listKey(ctx, filter, 1)
    const page = this.nextPage
    this.loadingMore = true
    try {
      const result = await this.loadFor(ctx, filter, { page })
      if (this.listKey(ctx, this.filter, 1) !== key || this.nextPage !== page) return
      const known = new Set(this.items.map((item) => item.number))
      for (const item of result.items) if (!known.has(item.number)) this.items.push(item)
      this.hasMore = result.hasMore
      this.nextPage = result.page + 1
      void this.loadChecks(ctx, result.items.map((item) => item.number)).catch(() => { this.checksLoadFailed = true })
      void this.loadGuideMetadata(ctx, result.items).catch(() => {})
    } finally {
      this.loadingMore = false
    }
  }

  async loadEfforts(ctx: IpcContext, numbers: number[]): Promise<void> {
    const requests = numbers
      .map((number) => this.get(number))
      .filter((item): item is PullRequestSummary => !!item && item.state === 'open' && !item.effort)
      .filter((item) => {
        const key = `${this.contextKey(ctx)}::${item.number}::${item.headSha}`
        return !this.effortLoaded.has(key) && !this.effortInFlight.has(key)
      })
      .slice(0, 30)
    if (requests.length === 0) return
    const keys = requests.map((item) => `${this.contextKey(ctx)}::${item.number}::${item.headSha}`)
    for (const key of keys) this.effortInFlight.add(key)
    try {
      const results = await window.solus.prGetEfforts(snapshotCtx(ctx), requests.map(({ number, headSha }) => ({ number, headSha })))
      for (const result of results) {
        const key = `${this.contextKey(ctx)}::${result.number}::${result.headSha}`
        this.effortLoaded.add(key)
        const item = this.get(result.number)
        if (item?.headSha !== result.headSha) continue
        if (result.effort) item.effort = result.effort
        if (result.additions !== undefined) item.additions = result.additions
        if (result.deletions !== undefined) item.deletions = result.deletions
      }
    } finally {
      for (const key of keys) this.effortInFlight.delete(key)
    }
  }

  async loadOverview(ctx: IpcContext, number: number, opts: { force?: boolean } = {}): Promise<PullRequestOverview> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    const overview = await this.readCached(
      this.overviewCache,
      this.prKey(ctx, number),
      !!opts.force,
      () => window.solus.prGetOverview(safeCtx, number),
    )
    this.seedOverview(ctx, number, overview)
    return overview
  }

  async loadDetail(ctx: IpcContext, number: number, opts: { force?: boolean } = {}): Promise<PullRequestDetail> {
    const key = this.prKey(ctx, number)
    const overview = this.overviewCache.get(key)
    if (!opts.force) {
      if (this.isFresh(overview)) return overview.value.detail
      if (overview?.inFlight) return (await overview.inFlight).detail
    }
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    return this.readCached(this.detailCache, key, !!opts.force, () => window.solus.prGetDetail(safeCtx, number))
  }

  async loadCommits(ctx: IpcContext, number: number, opts: { force?: boolean } = {}): Promise<PrCommit[]> {
    const key = this.prKey(ctx, number)
    const overview = this.overviewCache.get(key)
    if (!opts.force) {
      if (this.isFresh(overview)) return overview.value.commits
      if (overview?.inFlight) return (await overview.inFlight).commits
    }
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    return this.readCached(this.commitsCache, key, !!opts.force, () => window.solus.prListCommits(safeCtx, number))
  }

  async loadReviewers(ctx: IpcContext, number: number, opts: { force?: boolean } = {}): Promise<PrReviewer[]> {
    const key = this.prKey(ctx, number)
    const overview = this.overviewCache.get(key)
    if (!opts.force) {
      if (this.isFresh(overview)) return overview.value.reviewers
      if (overview?.inFlight) return (await overview.inFlight).reviewers
    }
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    return this.readCached(this.reviewersCache, key, !!opts.force, () => window.solus.prListReviewers(safeCtx, number))
  }

  /** Login for the connected provider token's user — the identity comment
   *  composers post as. Stable per project, so the short PR TTL only costs an
   *  occasional refetch of a value the provider caches per token anyway. */
  async loadViewer(ctx: IpcContext): Promise<string> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    return this.readCached(this.viewerCache, this.contextKey(ctx), false, () => window.solus.providerViewer(safeCtx))
  }

  async loadThreads(ctx: IpcContext, number: number, opts: { force?: boolean } = {}): Promise<ReviewThread[]> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    return this.readCached(
      this.threadsCache,
      this.prKey(ctx, number),
      !!opts.force,
      () => window.solus.prListThreads(safeCtx, number),
    )
  }

  async loadComments(ctx: IpcContext, number: number, opts: { force?: boolean } = {}): Promise<PrConversationItem[]> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    return this.readCached(
      this.commentsCache,
      this.prKey(ctx, number),
      !!opts.force,
      () => window.solus.prListComments(safeCtx, number),
    )
  }

  async loadChangedFiles(
    ctx: IpcContext,
    number: number,
    opts: { force?: boolean } = {},
  ): Promise<ChangedFileStat[]> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    return this.readCached(
      this.changedFilesCache,
      this.prKey(ctx, number),
      !!opts.force,
      () => window.solus.prChangedFiles(safeCtx, number),
    )
  }

  async loadInterdiff(
    ctx: IpcContext,
    pr: PrReviewContext,
    opts: { force?: boolean } = {},
  ): Promise<PrInterdiffResult> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    const safePr = JSON.parse(JSON.stringify(pr)) as PrReviewContext
    const key = `${this.prKey(ctx, pr.number)}::${pr.baseSha}::${pr.headSha}`
    return this.readCached(
      this.interdiffCache,
      key,
      !!opts.force,
      () => window.solus.prInterdiff(safeCtx, safePr),
    )
  }

  get(number: number): PullRequestSummary | undefined {
    return this.items.find((p) => p.number === number)
  }

  needsReviewCountFor(ctx: IpcContext): number {
    return this.needsReviewContextKey === this.contextKey(ctx) ? this.needsReviewItems.length : 0
  }

  needsReviewMinutesFor(ctx: IpcContext): number | undefined {
    if (this.needsReviewContextKey !== this.contextKey(ctx)) return undefined
    const known = this.needsReviewItems.flatMap((pr) => pr.effort ? [pr.effort.minutes] : [])
    return known.length > 0 ? known.reduce((sum, minutes) => sum + minutes, 0) : undefined
  }

  async refreshNeedsReview(ctx: IpcContext): Promise<void> {
    const key = this.contextKey(ctx)
    if (!key) {
      this.needsReviewLoadSeq++
      this.needsReviewContextKey = ''
      this.needsReviewItems = []
      return
    }
    if (this.needsReviewInFlight?.key === key) return this.needsReviewInFlight.promise
    const seq = ++this.needsReviewLoadSeq
    if (this.needsReviewContextKey !== key) {
      this.needsReviewContextKey = key
      this.needsReviewItems = []
    }
    const promise: Promise<void> = this.loadEveryPage(ctx, { state: 'open' }, true)
      .then((items) => {
        if (seq !== this.needsReviewLoadSeq || this.needsReviewContextKey !== key) return
        this.needsReviewItems = items.filter((pr) => pr.needsMyReview)
      })
      .finally(() => {
        if (this.needsReviewInFlight?.promise === promise) this.needsReviewInFlight = null
      })
    this.needsReviewInFlight = { key, promise }
    return promise
  }

  subscribeNeedsReview(getCtx: () => IpcContext): () => void {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return
      void this.refreshNeedsReview(getCtx()).catch(() => {})
    }
    const unsubscribe = window.solus.onPrsChanged((cwd) => {
      if (cwd === this.contextKey(getCtx())) refresh()
    })
    const interval = window.setInterval(refresh, NEEDS_REVIEW_POLL_MS)
    window.addEventListener('focus', refresh)
    refresh()
    return () => {
      unsubscribe()
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
  }

  checksFor(number: number): PrChecksSummary | undefined {
    return this.checks.get(number)
  }

  guideStatusFor(number: number): PrGuideStatus | undefined {
    return this.guideStatus.get(number)
  }

  guideMetadataFor(number: number): PrGuideMetadata | undefined {
    return this.guideMetadata.get(number)
  }

  async loadGuideMetadata(ctx: IpcContext, prs: PullRequestSummary[]): Promise<void> {
    if (prs.length === 0) return
    const contextKey = this.contextKey(ctx)
    if (this.guideMetadataContextKey !== contextKey) {
      this.guideMetadataContextKey = contextKey
      this.guideMetadata.clear()
    }
    const requests = prs.map(({ number, headSha }) => ({ number, headSha }))
    const metadata = await window.solus.prGuideMetadata(snapshotCtx(ctx), requests)
    if (this.guideMetadataContextKey !== contextKey) return
    const byNumber = new Map(metadata.map((item) => [item.number, item]))
    for (const request of requests) {
      if (this.get(request.number)?.headSha !== request.headSha) continue
      const item = byNumber.get(request.number)
      if (item) this.guideMetadata.set(request.number, item)
      else this.guideMetadata.delete(request.number)
    }
  }

  /** Queue background guide generation for these PRs (explicit opt-in). PRs
   *  already queued or generating are skipped; the resolved call only means
   *  "queued" — completion arrives over the guide-status subscription. */
  async requestGuides(
    ctx: IpcContext,
    numbers: number[],
    options: {
      notifyWhenDone?: boolean
      onNotificationAction?: () => void
    } = {},
  ): Promise<void> {
    if (options.notifyWhenDone) {
      this.requestedGuideNumbers.clear()
      for (const number of numbers) this.requestedGuideNumbers.add(number)
      this.requestedGuidesAction = options.onNotificationAction ?? null
    }
    const targets = numbers.filter((number) => {
      const status = this.guideStatus.get(number)
      return status !== 'queued' && status !== 'generating'
    })
    if (targets.length === 0) {
      this.notifyIfRequestedGuidesFinished()
      return
    }
    // Optimistic: the broadcast back confirms (or corrects) these.
    for (const number of targets) this.guideStatus.set(number, 'queued')
    try {
      await window.solus.prGenerateGuides(snapshotCtx(ctx), targets)
    } catch (err) {
      if (options.notifyWhenDone) {
        this.requestedGuideNumbers.clear()
        this.requestedGuidesAction = null
      }
      for (const number of targets) {
        if (this.guideStatus.get(number) === 'queued') this.guideStatus.delete(number)
      }
      throw err
    }
  }

  subscribeGuideStatus(): () => void {
    return window.solus.onPrGuideStatus((event) => {
      // Statuses are keyed by PR number only, so a request in another repo
      // resets the map rather than bleeding into this one's numbers.
      if (this.guideStatusRepoRoot !== event.repoRoot) {
        this.guideStatusRepoRoot = event.repoRoot
        this.guideStatus.clear()
      }
      this.guideStatus.set(event.number, event.status)
      this.notifyIfRequestedGuidesFinished()
      if (event.metadata && this.guideMetadataContextKey === event.repoRoot) {
        this.guideMetadata.set(event.number, event.metadata)
      }
    })
  }

  private notifyIfRequestedGuidesFinished(): void {
    if (this.requestedGuideNumbers.size === 0) return
    const statuses = [...this.requestedGuideNumbers].map((number) =>
      this.guideStatus.get(number),
    )
    if (statuses.some((status) => status !== 'ready' && status !== 'failed')) return

    const total = this.requestedGuideNumbers.size
    const failed = statuses.filter((status) => status === 'failed').length
    const action = this.requestedGuidesAction
    this.requestedGuideNumbers.clear()
    this.requestedGuidesAction = null
    const toastOptions = action
      ? { action: { label: 'View', onAction: action } }
      : undefined
    if (failed > 0) {
      toasts.error(
        failed === total
          ? `Couldn't generate ${total === 1 ? 'the review guide' : `${total} review guides`}`
          : `${total - failed} of ${total} review guides ready; ${failed} failed`,
        toastOptions,
      )
      return
    }
    toasts.success(
      total === 1 ? 'Review guide ready' : `${total} review guides ready`,
      toastOptions,
    )
  }

  async loadChecks(ctx: IpcContext, numbers: number[] = []): Promise<void> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    this.applyChecks(await window.solus.prChecks(safeCtx, numbers), true)
  }

  subscribeChecks(getCtx: () => IpcContext): () => void {
    const unsubscribe = window.solus.onPrChecksUpdate((snapshot) => this.applyChecks(snapshot))
    const reportActivity = () => this.reportChecksActivity(getCtx())
    window.addEventListener('focus', reportActivity)
    window.addEventListener('blur', reportActivity)
    document.addEventListener('visibilitychange', reportActivity)
    reportActivity()
    return () => {
      unsubscribe()
      window.removeEventListener('focus', reportActivity)
      window.removeEventListener('blur', reportActivity)
      document.removeEventListener('visibilitychange', reportActivity)
      const ctx = getCtx()
      if (this.contextKey(ctx)) void window.solus.prChecksActivity(snapshotCtx(ctx), false, false).catch(() => {})
    }
  }

  setChecksReviewSurface(open: boolean, ctx: IpcContext): void {
    this.reviewSurfaceOpen = open
    this.reportChecksActivity(ctx)
  }

  private applyChecks(snapshot: PrChecksSnapshot, activate = false): void {
    const key = checksRepoKey(snapshot)
    if (!activate && this.checksRepoKey && this.checksRepoKey !== key) return
    this.checksRepoKey = key
    this.checks.clear()
    for (const { number, summary } of snapshot.checks) this.checks.set(number, summary)
    this.checksLoadFailed = snapshot.loadFailed
  }

  private reportChecksActivity(ctx: IpcContext): void {
    if (!this.contextKey(ctx)) return
    const active = document.visibilityState === 'visible' && document.hasFocus()
    void window.solus
      .prChecksActivity(snapshotCtx(ctx), this.reviewSurfaceOpen, active)
      .catch(() => {})
  }
}

function checksRepoKey(snapshot: PrChecksSnapshot): string {
  return `${snapshot.repo.host}/${snapshot.repo.owner}/${snapshot.repo.repo}`
}

function snapshotCtx(ctx: IpcContext): IpcContext {
  return JSON.parse(JSON.stringify(ctx)) as IpcContext
}
