import type {
  PullRequestSummary,
  PullRequestUpdate,
  PullRequestOverview,
  PullRequestDetail,
  PrCommit,
  PrConversationItem,
  PrFilter,
  PrListPage,
  PrLifecycleAction,
  PrReviewer,
  PrReviewerCandidate,
  ReviewThread,
} from '../../../shared/providers'
import type { ChangedFileStat, IpcContext, PrInterdiffResult, PrReviewContext } from '../../../shared/types'
import type { PrChecksSummary } from '../../../shared/checks-types'
import type { PrGuideMetadata, PrGuideStatus } from '../../../shared/review'
import type { PrChecksSnapshot } from '../../../shared/checks-rpc-types'
import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@client-core/host-api'
import { hostKey } from '@client-core/host-key'
import { subscribeAllHosts } from '@client-core/host-events'
import { OPEN_PR_STATUS_KEYS } from '../../components/prs/lib/prs-list-view'
import { prSurfaceError, type PrSurfaceError } from '../../components/prs/lib/pr-surface-error'

const PR_CACHE_TTL_MS = 30_000
export const PR_CACHE_MAX_ENTRIES = 64
const PR_LARGE_CACHE_MAX_ENTRIES = 8
const NEEDS_REVIEW_POLL_MS = 15 * 60_000

interface CacheEntry<T> {
  value?: T
  loadedAt: number
  inFlight?: Promise<T>
}

export type PrReviewTab = 'activity' | 'guide' | 'diff'

/** Everything about how the list was left, so returning from a review restores
 *  the reading position and not merely the query. */
export interface PrListView {
  query: string
  /** The lifecycle states the list and the inbox are showing. Also decides the
   *  *fetch* scope, since the server pages open and closed separately. */
  statusKeys: string[]
  sortMode: 'updated' | 'created' | 'effort'
  minesOnly: boolean
  failingOnly: boolean
  collapsedGroups: Record<string, boolean>
  selectedNumber: number | null
  scrollTop: number
  /** The pull request showing in the page's detail panel, or `null` while the
   *  list has the page to itself. Highlighting a row with the arrow keys moves
   *  `selectedNumber` only; opening one moves both. */
  openNumber: number | null
  /** The panel covers the list instead of sitting beside it. */
  panelFullScreen: boolean
}

const EMPTY_LIST_VIEW: PrListView = {
  query: '',
  statusKeys: [...OPEN_PR_STATUS_KEYS],
  sortMode: 'updated',
  minesOnly: false,
  failingOnly: false,
  collapsedGroups: {},
  selectedNumber: null,
  scrollTop: 0,
  openNumber: null,
  panelFullScreen: false,
}

export class PrsStore {
  items = $state<PullRequestSummary[]>([])
  needsReviewItems = $state<PullRequestSummary[]>([])
  needsReviewOnly = $state(false)
  loading = $state(false)
  loadingMore = $state(false)
  loaded = $state(false)
  /** When the current `items` fetch landed (ms; 0 before the first load). Feeds
   *  the inbox masthead's "Synced 2m ago" fact. */
  listLoadedAt = $state(0)
  hasMore = $state(false)
  nextPage = $state(1)
  filter = $state<PrFilter>({ state: 'open' })
  error = $state<PrSurfaceError | null>(null)
  /** Active content tab of the `pr-review` surface. Lifted out of PrReviewPane so
   *  chrome around it can react to the selection. Chat is NOT a content tab — it
   *  is the primary conversation, toggled by `maximized`. */
  prReviewTab = $state<PrReviewTab>('guide')
  /**
   * How the list was left, including which pull request is open beside it. The
   * page can still be unmounted between visits, so the reading position lives
   * here rather than in the component. Reset only when the project scope
   * changes, never on page open.
   */
  listView = $state<PrListView>({ ...EMPTY_LIST_VIEW })
  /** The visible rows in list order. The chrome band's crumb switcher and its
   *  `n of N` stepper read this, so neither can drift from the list behind them. */
  listOrder = $state<number[]>([])
  /** Fixed launch snapshot for Review Mode. The session store owns subsequent
   *  ordering and dispositions, so list refreshes cannot move the active PR. */
  reviewModeNumbers = $state<number[]>([])
  reviewModeContext = $state<IpcContext | null>(null)
  /** Lifecycle of explicitly requested guide generations, shared by the PRs
   *  page and the Activity tab so both surfaces reflect one queue. */
  guideStatus = new SvelteMap<string, PrGuideStatus>()
  guideMetadata = new SvelteMap<string, PrGuideMetadata>()

  private activeContextKey = ''
  private readonly checksByContext = new SvelteMap<string, PrChecksSnapshot>()
  private readonly checksRepoByContext = new Map<string, string>()
  private readonly requestedGuideNumbers = new Set<number>()
  private requestedGuideContextKey = ''
  private requestedGuidesOnSettled: ((outcome: { total: number; failed: number }) => void) | null = null
  private needsReviewContextKey = ''
  private needsReviewLoadSeq = 0
  private needsReviewInFlight: { key: string; promise: Promise<void> } | null = null
  private reviewSurfaceOpen = false

  private readonly listCache = new Map<string, CacheEntry<PrListPage>>()
  private readonly effortByKey = new Map<string, {
    effort: NonNullable<PullRequestSummary['effort']>
    additions: number
    deletions: number
  }>()
  private readonly effortInFlight = new Set<string>()
  private readonly overviewCache = new Map<string, CacheEntry<PullRequestOverview>>()
  private readonly detailCache = new Map<string, CacheEntry<PullRequestDetail>>()
  private readonly commitsCache = new Map<string, CacheEntry<PrCommit[]>>()
  private readonly reviewersCache = new Map<string, CacheEntry<PrReviewer[]>>()
  private readonly reviewerCandidatesCache = new Map<string, CacheEntry<PrReviewerCandidate[]>>()
  private readonly threadsCache = new Map<string, CacheEntry<ReviewThread[]>>()
  private readonly commentsCache = new Map<string, CacheEntry<PrConversationItem[]>>()
  private readonly changedFilesCache = new Map<string, CacheEntry<ChangedFileStat[]>>()
  private readonly interdiffCache = new Map<string, CacheEntry<PrInterdiffResult>>()
  private readonly viewerCache = new Map<string, CacheEntry<string>>()

  reviewModeServerId = $state<string | null>(null)

  beginReviewMode(numbers: number[], ctx: IpcContext, serverId: string): void {
    this.reviewModeNumbers.splice(0, this.reviewModeNumbers.length, ...numbers)
    this.reviewModeContext = structuredClone($state.snapshot(ctx))
    this.reviewModeServerId = serverId
  }

  private contextKey(ctx: IpcContext): string {
    return ctx.session.projectPath || ctx.session.workingDirectory || ''
  }

  private contextHostKey(serverId: string, ctx: IpcContext): string {
    return hostKey(serverId, this.contextKey(ctx))
  }

  private listKey(serverId: string, ctx: IpcContext, filter: PrFilter, page = 1): string {
    return `${this.contextHostKey(serverId, ctx)}::${filter.state ?? 'open'}::${filter.author ?? ''}::${page}`
  }

  private prKey(serverId: string, ctx: IpcContext, number: number): string {
    return `${this.contextHostKey(serverId, ctx)}::${number}`
  }

  private effortKey(serverId: string, ctx: IpcContext, item: Pick<PullRequestSummary, 'number' | 'headSha'>): string {
    return `${this.contextHostKey(serverId, ctx)}::${item.number}::${item.headSha}`
  }

  private guideKey(serverId: string, ctx: IpcContext, number: number): string {
    return `${this.contextHostKey(serverId, ctx)}::${number}`
  }

  private applyStoredEffort(serverId: string, ctx: IpcContext, item: PullRequestSummary): void {
    const stored = this.effortByKey.get(this.effortKey(serverId, ctx, item))
    if (!stored) return
    item.effort = stored.effort
    item.additions = stored.additions
    item.deletions = stored.deletions
  }

  private isFresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> & { value: T } {
    return entry?.value !== undefined && Date.now() - entry.loadedAt < PR_CACHE_TTL_MS
  }

  private setCacheEntry<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    entry: CacheEntry<T>,
    maxEntries = PR_CACHE_MAX_ENTRIES,
  ): void {
    const now = Date.now()
    for (const [cacheKey, candidate] of cache) {
      if (!candidate.inFlight && candidate.value !== undefined && now - candidate.loadedAt >= PR_CACHE_TTL_MS) {
        cache.delete(cacheKey)
      }
    }
    // Reinsertion makes the map's iteration order an inexpensive LRU order.
    cache.delete(key)
    cache.set(key, entry)
    while (cache.size > maxEntries) {
      let evicted = false
      for (const [cacheKey, candidate] of cache) {
        if (candidate.inFlight) continue
        cache.delete(cacheKey)
        evicted = true
        break
      }
      // Do not cancel or detach an in-flight provider request merely to meet a
      // transient cap. Its settlement will immediately run this pruning again.
      if (!evicted) break
    }
  }

  private async readCached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    force: boolean,
    load: () => Promise<T>,
    maxEntries = PR_CACHE_MAX_ENTRIES,
  ): Promise<T> {
    const entry = cache.get(key)
    if (!force) {
      if (this.isFresh(entry)) {
        this.setCacheEntry(cache, key, entry, maxEntries)
        return entry.value
      }
      if (entry?.inFlight) return entry.inFlight
    }

    const inFlight = load()
      .then((value) => {
        this.setCacheEntry(cache, key, { value, loadedAt: Date.now() }, maxEntries)
        return value
      })
      .finally(() => {
        const current = cache.get(key)
        if (current?.inFlight !== inFlight) return
        if (current.value !== undefined) {
          this.setCacheEntry(cache, key, { value: current.value, loadedAt: current.loadedAt }, maxEntries)
        }
        else cache.delete(key)
      })
    this.setCacheEntry(cache, key, { value: entry?.value, loadedAt: entry?.loadedAt ?? 0, inFlight }, maxEntries)
    return inFlight
  }

  private seed<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
    this.setCacheEntry(cache, key, { value, loadedAt: Date.now() })
  }

  private cached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key)
    if (!this.isFresh(entry)) return undefined
    this.setCacheEntry(cache, key, entry)
    return entry.value
  }

  private seedOverview(serverId: string, ctx: IpcContext, number: number, overview: PullRequestOverview): void {
    const key = this.prKey(serverId, ctx, number)
    this.seed(this.detailCache, key, overview.detail)
    this.seed(this.commitsCache, key, overview.commits)
    this.seed(this.reviewersCache, key, overview.reviewers)
  }

  async loadFor(
    api: HostApi,
    serverId: string,
    ctx: IpcContext,
    filter: PrFilter,
    opts: { force?: boolean; page?: number } = {},
  ): Promise<PrListPage> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    const safeFilter = JSON.parse(JSON.stringify(filter)) as PrFilter
    const page = opts.page ?? 1
    return this.readCached(
      this.listCache,
      this.listKey(serverId, ctx, safeFilter, page),
      !!opts.force,
      () => api.prList(safeCtx, safeFilter, page),
    )
  }

  async loadAll(api: HostApi, serverId: string, ctx: IpcContext, opts: { force?: boolean } = {}): Promise<void> {
    const filter = JSON.parse(JSON.stringify(this.filter)) as PrFilter
    const key = this.listKey(serverId, ctx, filter, 1)
    if (opts.force) {
      const prefix = key.slice(0, key.lastIndexOf('::') + 2)
      for (const cacheKey of this.listCache.keys()) if (cacheKey.startsWith(prefix)) this.listCache.delete(cacheKey)
    }
    this.activeContextKey = this.contextHostKey(serverId, ctx)
    this.loading = true
    this.error = null
    try {
      const result = await this.loadFor(api, serverId, ctx, filter, opts)
      if (this.listKey(serverId, ctx, this.filter, 1) !== key || this.activeContextKey !== this.contextHostKey(serverId, ctx)) return
      for (const item of result.items) this.applyStoredEffort(serverId, ctx, item)
      this.items = result.items
      this.hasMore = result.hasMore
      this.nextPage = result.page + 1
      this.loaded = true
      this.listLoadedAt = Date.now()
      void this.loadChecks(api, serverId, ctx, result.items.map((item) => item.number)).catch(() => {})
      void this.loadGuideMetadata(api, serverId, ctx, result.items).catch(() => {})
    } catch (error) {
      if (this.activeContextKey === this.contextHostKey(serverId, ctx)) this.error = prSurfaceError(error)
    } finally {
      this.loading = false
    }
  }

  async loadMore(api: HostApi, serverId: string, ctx: IpcContext): Promise<void> {
    if (!this.hasMore || this.loadingMore) return
    const filter = JSON.parse(JSON.stringify(this.filter)) as PrFilter
    const key = this.listKey(serverId, ctx, filter, 1)
    const page = this.nextPage
    this.loadingMore = true
    try {
      const result = await this.loadFor(api, serverId, ctx, filter, { page })
      if (this.listKey(serverId, ctx, this.filter, 1) !== key || this.nextPage !== page) return
      const known = new Set(this.items.map((item) => item.number))
      for (const item of result.items) {
        this.applyStoredEffort(serverId, ctx, item)
        if (!known.has(item.number)) this.items.push(item)
      }
      this.hasMore = result.hasMore
      this.nextPage = result.page + 1
      void this.loadChecks(api, serverId, ctx, result.items.map((item) => item.number)).catch(() => {})
      void this.loadGuideMetadata(api, serverId, ctx, result.items).catch(() => {})
    } catch (error) {
      this.error = prSurfaceError(error)
    } finally {
      this.loadingMore = false
    }
  }

  async loadEfforts(api: HostApi, serverId: string, ctx: IpcContext, numbers: number[]): Promise<void> {
    const requests = numbers
      .map((number) => this.get(number))
      .filter((item): item is PullRequestSummary => !!item && item.state === 'open' && !item.effort)
      .filter((item) => {
        const key = this.effortKey(serverId, ctx, item)
        return !this.effortByKey.has(key) && !this.effortInFlight.has(key)
      })
      .slice(0, 30)
    if (requests.length === 0) return
    const keys = requests.map((item) => this.effortKey(serverId, ctx, item))
    for (const key of keys) this.effortInFlight.add(key)
    try {
      const results = await api.prGetEfforts(snapshotCtx(ctx), requests.map(({ number, headSha }) => ({ number, headSha })))
      for (const result of results) {
        if (!result.effort || result.additions === undefined || result.deletions === undefined) continue
        const key = this.effortKey(serverId, ctx, result)
        this.effortByKey.set(key, {
          effort: result.effort,
          additions: result.additions,
          deletions: result.deletions,
        })
        const item = this.get(result.number)
        if (item?.headSha !== result.headSha) continue
        this.applyStoredEffort(serverId, ctx, item)
      }
    } finally {
      for (const key of keys) this.effortInFlight.delete(key)
    }
  }

  async loadOverview(api: HostApi, serverId: string, ctx: IpcContext, number: number, opts: { force?: boolean } = {}): Promise<PullRequestOverview> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    const overview = await this.readCached(
      this.overviewCache,
      this.prKey(serverId, ctx, number),
      !!opts.force,
      () => api.prGetOverview(safeCtx, number),
    )
    this.seedOverview(serverId, ctx, number, overview)
    return overview
  }

  /**
   * Warm every provider read the review surface makes, at the moment a PR is
   * opened. The worktree fetch/checkout that gates the pane is far slower than
   * these, so they land first and the Activity tab paints filled instead of
   * starting its own requests once the worktree is ready. Rejections are
   * swallowed: the surface re-requests through this same cache and owns the
   * error banner.
   */
  prefetchReview(api: HostApi, serverId: string, ctx: IpcContext, number: number): void {
    void this.loadOverview(api, serverId, ctx, number).catch(() => {})
    void this.loadComments(api, serverId, ctx, number).catch(() => {})
    void this.loadChangedFiles(api, serverId, ctx, number).catch(() => {})
    void this.loadThreads(api, serverId, ctx, number).catch(() => {})
    void this.loadViewer(api, serverId, ctx).catch(() => {})
  }

  /**
   * The Activity tab's data, for the parts of it already cached and fresh.
   * Awaiting the loaders would flash every section's skeleton for a microtask
   * even on a pure cache hit, so the view seeds its state from this first and
   * only marks the misses as loading.
   */
  cachedActivity(serverId: string, ctx: IpcContext, number: number): {
    detail?: PullRequestDetail
    commits?: PrCommit[]
    reviewers?: PrReviewer[]
    comments?: PrConversationItem[]
    changedFiles?: ChangedFileStat[]
  } {
    const key = this.prKey(serverId, ctx, number)
    const overview = this.cached(this.overviewCache, key)
    return {
      detail: overview?.detail ?? this.cached(this.detailCache, key),
      commits: overview?.commits ?? this.cached(this.commitsCache, key),
      reviewers: overview?.reviewers ?? this.cached(this.reviewersCache, key),
      comments: this.cached(this.commentsCache, key),
      changedFiles: this.cached(this.changedFilesCache, key),
    }
  }

  async loadDetail(api: HostApi, serverId: string, ctx: IpcContext, number: number, opts: { force?: boolean } = {}): Promise<PullRequestDetail> {
    const key = this.prKey(serverId, ctx, number)
    const overview = this.overviewCache.get(key)
    if (!opts.force) {
      if (this.isFresh(overview)) return overview.value.detail
      if (overview?.inFlight) return (await overview.inFlight).detail
    }
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    return this.readCached(this.detailCache, key, !!opts.force, () => api.prGetDetail(safeCtx, number))
  }

  async updatePullRequest(
    api: HostApi,
    serverId: string,
    ctx: IpcContext,
    number: number,
    patch: PullRequestUpdate,
  ): Promise<PullRequestDetail> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    const updated = await api.prUpdate(safeCtx, number, patch)
    const key = this.prKey(serverId, ctx, number)
    this.seed(this.detailCache, key, updated)
    const overview = this.overviewCache.get(key)?.value
    if (overview) {
      overview.detail = updated
      this.seed(this.overviewCache, key, overview)
    }
    const visibleLists = this.activeContextKey === this.contextHostKey(serverId, ctx)
      ? [this.items, this.needsReviewItems]
      : []
    for (const items of visibleLists) {
      const item = items.find((candidate) => candidate.number === number)
      if (!item) continue
      item.title = updated.title
      item.body = updated.body
      item.updatedAt = updated.updatedAt
    }
    return updated
  }

  async loadCommits(api: HostApi, serverId: string, ctx: IpcContext, number: number, opts: { force?: boolean } = {}): Promise<PrCommit[]> {
    const key = this.prKey(serverId, ctx, number)
    const overview = this.overviewCache.get(key)
    if (!opts.force) {
      if (this.isFresh(overview)) return overview.value.commits
      if (overview?.inFlight) return (await overview.inFlight).commits
    }
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    return this.readCached(this.commitsCache, key, !!opts.force, () => api.prListCommits(safeCtx, number))
  }

  async loadReviewers(api: HostApi, serverId: string, ctx: IpcContext, number: number, opts: { force?: boolean } = {}): Promise<PrReviewer[]> {
    const key = this.prKey(serverId, ctx, number)
    const overview = this.overviewCache.get(key)
    if (!opts.force) {
      if (this.isFresh(overview)) return overview.value.reviewers
      if (overview?.inFlight) return (await overview.inFlight).reviewers
    }
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    return this.readCached(this.reviewersCache, key, !!opts.force, () => api.prListReviewers(safeCtx, number))
  }

  async loadReviewerCandidates(
    api: HostApi,
    serverId: string,
    ctx: IpcContext,
    number: number,
    opts: { force?: boolean } = {},
  ): Promise<PrReviewerCandidate[]> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    return this.readCached(
      this.reviewerCandidatesCache,
      this.prKey(serverId, ctx, number),
      !!opts.force,
      () => api.prListReviewerCandidates(safeCtx, number),
    )
  }

  async requestReviewers(
    api: HostApi,
    serverId: string,
    ctx: IpcContext,
    number: number,
    logins: string[],
  ): Promise<PrReviewer[]> {
    const reviewers = await api.prRequestReviewers(snapshotCtx(ctx), number, logins)
    this.seedReviewers(serverId, ctx, number, reviewers)
    return reviewers
  }

  async removeRequestedReviewer(
    api: HostApi,
    serverId: string,
    ctx: IpcContext,
    number: number,
    login: string,
  ): Promise<PrReviewer[]> {
    const reviewers = await api.prRemoveRequestedReviewer(snapshotCtx(ctx), number, login)
    this.seedReviewers(serverId, ctx, number, reviewers)
    return reviewers
  }

  async updateLifecycle(
    api: HostApi,
    serverId: string,
    ctx: IpcContext,
    number: number,
    action: Exclude<PrLifecycleAction, 'merge'>,
    expectedHeadSha: string,
  ): Promise<PullRequestDetail> {
    const detail = await api.prUpdateLifecycle(snapshotCtx(ctx), number, action, expectedHeadSha)
    this.applyDetail(serverId, ctx, number, detail)
    return detail
  }

  private seedReviewers(serverId: string, ctx: IpcContext, number: number, reviewers: PrReviewer[]): void {
    const key = this.prKey(serverId, ctx, number)
    this.seed(this.reviewersCache, key, reviewers)
    const overview = this.overviewCache.get(key)?.value
    if (!overview) return
    overview.reviewers = reviewers
    this.seed(this.overviewCache, key, overview)
  }

  applyDetail(serverId: string, ctx: IpcContext, number: number, detail: PullRequestDetail): void {
    const key = this.prKey(serverId, ctx, number)
    this.seed(this.detailCache, key, detail)
    const overview = this.overviewCache.get(key)?.value
    if (overview) {
      overview.detail = detail
      this.seed(this.overviewCache, key, overview)
    }
    if (this.activeContextKey !== this.contextHostKey(serverId, ctx)) return
    for (const items of [this.items, this.needsReviewItems]) {
      const item = items.find((candidate) => candidate.number === number)
      if (!item) continue
      item.state = detail.state
      item.draft = detail.draft
      item.updatedAt = detail.updatedAt
      item.headSha = detail.headSha
    }
    if (detail.state !== 'open') {
      const needsReviewIndex = this.needsReviewItems.findIndex((item) => item.number === number)
      if (needsReviewIndex >= 0) this.needsReviewItems.splice(needsReviewIndex, 1)
    }
  }

  /** Login for the connected provider token's user — the identity comment
   *  composers post as. Stable per project, so the short PR TTL only costs an
   *  occasional refetch of a value the provider caches per token anyway. */
  async loadViewer(api: HostApi, serverId: string, ctx: IpcContext): Promise<string> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    return this.readCached(this.viewerCache, this.contextHostKey(serverId, ctx), false, () => api.providerViewer(safeCtx))
  }

  async loadThreads(api: HostApi, serverId: string, ctx: IpcContext, number: number, opts: { force?: boolean } = {}): Promise<ReviewThread[]> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    return this.readCached(
      this.threadsCache,
      this.prKey(serverId, ctx, number),
      !!opts.force,
      () => api.prListThreads(safeCtx, number),
    )
  }

  async loadComments(api: HostApi, serverId: string, ctx: IpcContext, number: number, opts: { force?: boolean } = {}): Promise<PrConversationItem[]> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    return this.readCached(
      this.commentsCache,
      this.prKey(serverId, ctx, number),
      !!opts.force,
      () => api.prListComments(safeCtx, number),
    )
  }

  async loadChangedFiles(
    api: HostApi,
    serverId: string,
    ctx: IpcContext,
    number: number,
    opts: { force?: boolean } = {},
  ): Promise<ChangedFileStat[]> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    return this.readCached(
      this.changedFilesCache,
      this.prKey(serverId, ctx, number),
      !!opts.force,
      () => api.prChangedFiles(safeCtx, number),
    )
  }

  async loadInterdiff(
    api: HostApi,
    serverId: string,
    ctx: IpcContext,
    pr: PrReviewContext,
    opts: { force?: boolean } = {},
  ): Promise<PrInterdiffResult> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    const safePr = JSON.parse(JSON.stringify(pr)) as PrReviewContext
    const key = `${this.prKey(serverId, ctx, pr.number)}::${pr.baseSha}::${pr.headSha}`
    return this.readCached(
      this.interdiffCache,
      key,
      !!opts.force,
      () => api.prInterdiff(safeCtx, safePr),
      PR_LARGE_CACHE_MAX_ENTRIES,
    )
  }

  get(number: number): PullRequestSummary | undefined {
    return this.items.find((p) => p.number === number)
  }

  /** Forget how the list was left. Only a change of project scope earns this —
   *  opening the page must not throw away the reading position a review
   *  returned to. */
  resetListView(): void {
    this.listView = { ...EMPTY_LIST_VIEW }
    this.listOrder = []
  }

  needsReviewCountFor(serverId: string, ctx: IpcContext): number {
    return this.needsReviewContextKey === this.contextHostKey(serverId, ctx) ? this.needsReviewItems.length : 0
  }

  needsReviewMinutesFor(serverId: string, ctx: IpcContext): number | undefined {
    if (this.needsReviewContextKey !== this.contextHostKey(serverId, ctx)) return undefined
    const known = this.needsReviewItems.flatMap((pr) => pr.effort ? [pr.effort.minutes] : [])
    return known.length > 0 ? known.reduce((sum, minutes) => sum + minutes, 0) : undefined
  }

  async refreshNeedsReview(api: HostApi, serverId: string, ctx: IpcContext): Promise<void> {
    const contextPath = this.contextKey(ctx)
    const key = this.contextHostKey(serverId, ctx)
    if (!contextPath) {
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
    const promise: Promise<void> = api.prNeedsReview(snapshotCtx(ctx))
      .then((items) => {
        if (seq !== this.needsReviewLoadSeq || this.needsReviewContextKey !== key) return
        this.needsReviewItems = items
      })
      .finally(() => {
        if (this.needsReviewInFlight?.promise === promise) this.needsReviewInFlight = null
      })
    this.needsReviewInFlight = { key, promise }
    return promise
  }

  subscribeNeedsReview(getScope: () => { api: HostApi; serverId: string; ctx: IpcContext }): () => void {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return
      const scope = getScope()
      void this.refreshNeedsReview(scope.api, scope.serverId, scope.ctx).catch(() => {})
    }
    const unsubscribe = subscribeAllHosts('prs.invalidated', (serverId, { projectRoot: cwd }) => {
      this.invalidateHostContext(serverId, cwd)
      const scope = getScope()
      if (serverId === scope.serverId && cwd === this.contextKey(scope.ctx)) refresh()
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

  checksFor(serverId: string, ctx: IpcContext, number: number): PrChecksSummary | undefined {
    return this.checksByContext.get(this.contextHostKey(serverId, ctx))?.checks
      .find((item) => item.number === number)?.summary
  }

  checksLoadFailedFor(serverId: string, ctx: IpcContext): boolean {
    return this.checksByContext.get(this.contextHostKey(serverId, ctx))?.loadFailed ?? false
  }

  guideStatusFor(serverId: string, ctx: IpcContext, number: number): PrGuideStatus | undefined {
    return this.guideStatus.get(this.guideKey(serverId, ctx, number))
  }

  guideMetadataFor(serverId: string, ctx: IpcContext, number: number): PrGuideMetadata | undefined {
    return this.guideMetadata.get(this.guideKey(serverId, ctx, number))
  }

  async loadGuideMetadata(api: HostApi, serverId: string, ctx: IpcContext, prs: PullRequestSummary[]): Promise<void> {
    if (prs.length === 0) return
    const contextKey = this.contextHostKey(serverId, ctx)
    const requests = prs.map(({ number, headSha }) => ({ number, headSha }))
    const metadata = await api.prGuideMetadata(snapshotCtx(ctx), requests)
    const byNumber = new Map(metadata.map((item) => [item.number, item]))
    for (const request of requests) {
      if (this.get(request.number)?.headSha !== request.headSha) continue
      const item = byNumber.get(request.number)
      const key = `${contextKey}::${request.number}`
      if (item) this.guideMetadata.set(key, item)
      else this.guideMetadata.delete(key)
    }
  }

  /** Queue background guide generation for these PRs (explicit opt-in). PRs
   *  already queued or generating are skipped; the resolved call only means
   *  "queued" — completion arrives over the guide-status subscription. */
  async requestGuides(
    api: HostApi,
    serverId: string,
    ctx: IpcContext,
    numbers: number[],
    options: {
      onSettled?: (outcome: { total: number; failed: number }) => void
    } = {},
  ): Promise<void> {
    if (options.onSettled) {
      this.requestedGuideContextKey = this.contextHostKey(serverId, ctx)
      this.requestedGuideNumbers.clear()
      for (const number of numbers) this.requestedGuideNumbers.add(number)
      this.requestedGuidesOnSettled = options.onSettled
    }
    const targets = numbers.filter((number) => {
      const status = this.guideStatusFor(serverId, ctx, number)
      return status !== 'queued' && status !== 'generating'
    })
    if (targets.length === 0) {
      this.settleRequestedGuides()
      return
    }
    // Optimistic: the broadcast back confirms (or corrects) these.
    for (const number of targets) this.guideStatus.set(this.guideKey(serverId, ctx, number), 'queued')
    try {
      await api.prGenerateGuides(snapshotCtx(ctx), targets)
    } catch (err) {
      if (options.onSettled) {
        this.requestedGuideNumbers.clear()
        this.requestedGuidesOnSettled = null
      }
      for (const number of targets) {
        const key = this.guideKey(serverId, ctx, number)
        if (this.guideStatus.get(key) === 'queued') this.guideStatus.delete(key)
      }
      throw err
    }
  }

  subscribeGuideStatus(): () => void {
    return subscribeAllHosts('pr.guideStatusChanged', (serverId, event) => {
      const contextKey = hostKey(serverId, event.repoRoot)
      const key = `${contextKey}::${event.number}`
      this.guideStatus.set(key, event.status)
      this.settleRequestedGuides(contextKey)
      if (event.metadata) this.guideMetadata.set(key, event.metadata)
    })
  }

  private settleRequestedGuides(contextKey = this.requestedGuideContextKey): void {
    if (contextKey !== this.requestedGuideContextKey) return
    if (this.requestedGuideNumbers.size === 0) return
    const statuses = [...this.requestedGuideNumbers].map((number) =>
      this.guideStatus.get(`${contextKey}::${number}`),
    )
    if (statuses.some((status) => status !== 'ready' && status !== 'failed')) return

    const total = this.requestedGuideNumbers.size
    const failed = statuses.filter((status) => status === 'failed').length
    const onSettled = this.requestedGuidesOnSettled
    this.requestedGuideNumbers.clear()
    this.requestedGuideContextKey = ''
    this.requestedGuidesOnSettled = null
    onSettled?.({ total, failed })
  }

  async loadChecks(api: HostApi, serverId: string, ctx: IpcContext, numbers: number[] = []): Promise<void> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    this.applyChecks(serverId, await api.prChecks(safeCtx, numbers), this.contextHostKey(serverId, ctx))
  }

  subscribeChecks(getScope: () => { api: HostApi; serverId: string; ctx: IpcContext }): () => void {
    const unsubscribe = subscribeAllHosts('pr.checksChanged', (serverId, snapshot) => this.applyChecks(serverId, snapshot))
    const reportActivity = () => {
      const scope = getScope()
      this.reportChecksActivity(scope.api, scope.ctx)
    }
    window.addEventListener('focus', reportActivity)
    window.addEventListener('blur', reportActivity)
    document.addEventListener('visibilitychange', reportActivity)
    reportActivity()
    return () => {
      unsubscribe()
      window.removeEventListener('focus', reportActivity)
      window.removeEventListener('blur', reportActivity)
      document.removeEventListener('visibilitychange', reportActivity)
      const scope = getScope()
      if (this.contextKey(scope.ctx)) void scope.api.prChecksActivity(snapshotCtx(scope.ctx), false, false).catch(() => {})
    }
  }

  setChecksReviewSurface(open: boolean, api: HostApi, ctx: IpcContext): void {
    this.reviewSurfaceOpen = open
    this.reportChecksActivity(api, ctx)
  }

  private applyChecks(serverId: string, snapshot: PrChecksSnapshot, contextKey?: string): void {
    const repoKey = checksRepoKey(snapshot)
    if (contextKey) {
      this.checksRepoByContext.set(contextKey, repoKey)
      this.checksByContext.set(contextKey, snapshot)
      return
    }
    const hostPrefix = hostKey(serverId, '')
    for (const [cachedContextKey, cachedRepoKey] of this.checksRepoByContext) {
      if (!cachedContextKey.startsWith(hostPrefix) || cachedRepoKey !== repoKey) continue
      this.checksByContext.set(cachedContextKey, snapshot)
    }
  }

  reportChecksActivity(api: HostApi, ctx: IpcContext): void {
    if (!this.contextKey(ctx)) return
    const active = document.visibilityState === 'visible' && document.hasFocus()
    void api.prChecksActivity(snapshotCtx(ctx), this.reviewSurfaceOpen, active)
      .catch(() => {})
  }

  private invalidateHostContext(serverId: string, contextPath: string): void {
    const contextKey = hostKey(serverId, contextPath)
    const prefix = `${contextKey}::`
    for (const cache of [
      this.listCache,
      this.overviewCache,
      this.detailCache,
      this.commitsCache,
      this.reviewersCache,
      this.reviewerCandidatesCache,
      this.threadsCache,
      this.commentsCache,
      this.changedFilesCache,
      this.interdiffCache,
    ]) {
      for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key)
    }
    this.viewerCache.delete(contextKey)
    for (const key of this.effortByKey.keys()) if (key.startsWith(prefix)) this.effortByKey.delete(key)
  }
}

function checksRepoKey(snapshot: PrChecksSnapshot): string {
  return `${snapshot.repo.host}/${snapshot.repo.owner}/${snapshot.repo.repo}`
}

function snapshotCtx(ctx: IpcContext): IpcContext {
  return JSON.parse(JSON.stringify(ctx)) as IpcContext
}
