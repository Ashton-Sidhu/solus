import type {
  PullRequestSummary,
  PullRequestOverview,
  PullRequestDetail,
  PrCommit,
  PrFilter,
  PrReviewer,
} from '../../shared/providers'
import type { IpcContext } from '../../shared/types'

const PR_CACHE_TTL_MS = 30_000

interface CacheEntry<T> {
  value?: T
  loadedAt: number
  inFlight?: Promise<T>
}

export class PrsStore {
  items = $state<PullRequestSummary[]>([])
  loading = $state(false)
  loaded = $state(false)
  filter = $state<PrFilter>({ state: 'open' })

  private readonly listCache = new Map<string, CacheEntry<PullRequestSummary[]>>()
  private readonly overviewCache = new Map<string, CacheEntry<PullRequestOverview>>()
  private readonly detailCache = new Map<string, CacheEntry<PullRequestDetail>>()
  private readonly commitsCache = new Map<string, CacheEntry<PrCommit[]>>()
  private readonly reviewersCache = new Map<string, CacheEntry<PrReviewer[]>>()

  private contextKey(ctx: IpcContext): string {
    return ctx.session.projectPath || ctx.session.workingDirectory || ''
  }

  private listKey(ctx: IpcContext, filter: PrFilter): string {
    return `${this.contextKey(ctx)}::${filter.state ?? 'open'}::${filter.author ?? ''}`
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

  async loadFor(ctx: IpcContext, filter: PrFilter, opts: { force?: boolean } = {}): Promise<PullRequestSummary[]> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    const safeFilter = JSON.parse(JSON.stringify(filter)) as PrFilter
    return this.readCached(
      this.listCache,
      this.listKey(ctx, safeFilter),
      !!opts.force,
      () => window.solus.prList(safeCtx, safeFilter),
    )
  }

  async loadAll(ctx: IpcContext, opts: { force?: boolean } = {}): Promise<void> {
    const filter = JSON.parse(JSON.stringify(this.filter)) as PrFilter
    const key = this.listKey(ctx, filter)
    this.loading = true
    try {
      const items = await this.loadFor(ctx, filter, opts)
      if (this.listKey(ctx, this.filter) !== key) return
      this.items = items
      this.loaded = true
    } finally {
      this.loading = false
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

  get(number: number): PullRequestSummary | undefined {
    return this.items.find((p) => p.number === number)
  }
}
