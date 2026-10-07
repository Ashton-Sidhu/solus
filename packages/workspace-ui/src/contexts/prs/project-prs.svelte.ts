// One project's pull requests, on one host.
//
// This *is* the project, so nothing here takes a `serverId` or a context. The
// first page arrives through `PrsStore`, which asks a host for all its projects
// at once; `loadMore` continues from it one project at a time. Later changes
// arrive from PR sync on the host through `absorbSynced`.
//
// `PrsStore` is a map of these keyed by project; `PullRequest` is one of the
// pull requests in this one.

import type { HostApi } from '@solus/client-core/host-api'
import { hostKey } from '@solus/client-core/host-key'
import type { GitPullRequestStep } from '@solus/contracts/git-types'
import type * as Contracts from '@solus/contracts/providers'
import type { PrFilter, PrListPage, PrProjectListing } from '@solus/contracts/providers'
import { repositoryKeyOf } from '@solus/contracts/repository-key'
import { projectScopeOf, worktreeProjectRoot, type IpcContext } from '@solus/contracts/types'
import { SvelteMap } from 'svelte/reactivity'
import { prSurfaceError, prUnavailable, type PrSurfaceError } from '../../components/prs/lib/pr-surface-error'
import { PrMirrors } from './pr-mirror'
import { PullRequest } from './pull-request.svelte'

/** A plain, detached copy of an argument bound for the host. A `$state` proxy
 *  cannot be structured-cloned by the transport, and a live one would let a
 *  later mutation change the arguments of a request already in flight. */
export function detached<T>(value: T): T {
  // SAFETY: `$state.snapshot` returns the same shape with the proxies removed,
  // which is what `structuredClone` then copies; neither changes the type.
  return structuredClone($state.snapshot(value)) as T
}

export function projectPrsKey(serverId: string, ctx: IpcContext): string {
  return hostKey(serverId, worktreeProjectRoot(projectScopeOf(ctx.session)))
}

/** What one `query` was asked for — a page, and whether to go past what the
 *  host has already fetched. */
export interface PrQuery {
  page?: number
  force?: boolean
}

export class ProjectPrs {
  /** The rows the list is showing, in the host's order. The same objects the
   *  index holds — a response is absorbed by reference, not copied. */
  items = $state<Contracts.PullRequest[]>([])

  /**
   * Every pull request this project knows anything about, by number.
   *
   * A superset of `items`: the list fills it, and so does one read on its own
   * because a task links a pull request too old to be on the page. Lookups
   * answer from here, so an answer never depends on what the page is showing.
   */
  readonly prs = new SvelteMap<number, PullRequest>()

  /** Head branch → number, for the git rail and session PR discovery. */
  readonly byBranch = new SvelteMap<string, number>()

  // --- Where the list has got to ------------------------------------------

  filter = $state<PrFilter>({ state: 'open' })
  /** The page a `list` with none of its own would ask for next. */
  nextPage = $state(1)
  hasMore = $state(false)
  loaded = $state(false)
  loading = $state(false)
  /** Raised only while a page is being appended, so the footer can tell a
   *  refresh from pagination and not offer a "Load more" that does not exist. */
  loadingMore = $state(false)
  /** Set without clearing `items`, so a failed refresh never blanks rows that
   *  were already on screen. */
  error = $state<PrSurfaceError | null>(null)

  /** Every answer this project holds. Keys need no project in them: this store
   *  is the project. */
  readonly mirrors = new PrMirrors()

  /** The repository this project reads, as PR sync names it (lowercase
   *  `host/owner/repo`); null until a pull request of it has been seen. */
  repositoryKey: string | null = null

  private revision = 0
  private listingToken = 0
  /** `revision` when the current listing began. */
  private listingRevision = 0

  constructor(
    private api: HostApi,
    readonly serverId: string,
    private ctx: IpcContext,
    readonly projectScope: string,
  ) {}

  /** Point this at the host and context the current caller is reading through. */
  reachThrough(api: HostApi, ctx: IpcContext): void {
    this.api = api
    this.ctx = ctx
  }

  get key(): string {
    return hostKey(this.serverId, this.projectScope)
  }

  // --- Lookups. Synchronous, so safe from a render path. -------------------

  prFor(number: number): PullRequest | null {
    const pr = this.prs.get(number)
    // A number nothing has described yet is not an answer. The entity exists so
    // the reads have somewhere to land; until one arrives, this project knows
    // no such pull request and a surface renders that absence.
    return pr?.isDescribed ? pr : null
  }

  prForBranch(headRef: string | null | undefined): PullRequest | null {
    if (!headRef) return null
    const number = this.byBranch.get(headRef)
    return number === undefined ? null : this.prFor(number)
  }

  /** Open pull requests, newest activity first — everything this project has
   *  been told about, not only what one list page happened to hold. */
  get openPrs(): PullRequest[] {
    return [...this.prs.values()]
      .filter((pr) => pr.isDescribed && pr.state === 'open')
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  }

  /** One pull request — the same object every time, so what one surface reads
   *  is what another wrote. Created on first mention. */
  get(number: number): PullRequest {
    const existing = this.prs.get(number)
    if (existing) return existing
    const created = new PullRequest(this, number)
    this.prs.set(number, created)
    return created
  }

  /** The host handle this project reads through. Read by `PullRequest`, which
   *  acts against the same project this store is. */
  get hostApi(): HostApi {
    return this.api
  }

  /** The context this project reads through. */
  get hostContext(): IpcContext {
    return this.ctx
  }

  // --- Writing what a response said ---------------------------------------

  /**
   * Record what a response says about a pull request, wherever it came from — a
   * list page, a direct read, or one Solus just created.
   *
   * Every path that obtains a pull request goes through here, so a surface
   * reading one cannot be left behind by another that read it some other way.
   */
  absorb(source: Contracts.PullRequest): PullRequest {
    this.repositoryKey ??= repositoryKeyOf(source.baseRepo)
    const pr = this.get(source.number)
    pr.apply(source)
    this.byBranch.set(source.headRef, source.number)
    return pr
  }

  /**
   * Take the pull request a git action just created or found.
   *
   * The step carries the provider's own record, so this is an ordinary absorb:
   * the rail, the sidebar chip and the task row name it on the next frame with
   * nothing invented. A step whose pull request the host could not read — a
   * `gh` fallback without an API credential — is asked for by number instead.
   */
  absorbCreated(step: GitPullRequestStep): void {
    if (step.status === 'skipped') return
    if (step.pullRequest) {
      this.absorb(step.pullRequest)
      return
    }
    if (step.number === null) return
    void this.get(step.number).loadDetail({ force: true }).catch(() => {})
  }

  /** Drop a pull request from the lookups — merged, closed, or gone. */
  forget(number: number): void {
    const headRef = this.prs.get(number)?.headRef
    if (headRef) this.byBranch.delete(headRef)
    this.prs.delete(number)
  }

  /** Apply a pull request the host reported, to the index and to every list
   *  page holding a row for it. */
  applyPullRequest(source: Contracts.PullRequest): PullRequest {
    this.revision++
    // A provider event or write supersedes reads already on the wire.
    this.mirrors.list.invalidatePending()
    this.mirrors.overview.delete(String(source.number))
    const pr = this.absorb(source)
    // The host has just said this, so it is also the answer to the next read —
    // otherwise an edit leaves a warm response holding the pre-edit snapshot.
    this.mirrors.detail.seed(String(source.number), source)
    const patch = (items: Contracts.PullRequest[] | undefined): void => {
      const item = items?.find((candidate) => candidate.number === source.number)
      if (!item) return
      item.title = source.title
      item.body = source.body
      item.state = source.state
      item.draft = source.draft
      item.updatedAt = source.updatedAt
      item.headSha = source.headSha
      item.labels = source.labels
    }
    for (const page of this.mirrors.list.values('')) patch(page.items)
    patch(this.items)
    return pr
  }

  /**
   * Take a pull request PR sync reports (`pr.changed`).
   *
   * Gentler than `applyPullRequest`: a tick reports many rows, often ones
   * nothing here changed, so it does not supersede a list read on the wire.
   * An older answer than the one held is ignored. A new pull request that the
   * unsearched list would show joins it at the top.
   */
  absorbSynced(source: Contracts.PullRequest): void {
    const held = this.prs.get(source.number)
    if (held?.isDescribed && Date.parse(held.updatedAt) > Date.parse(source.updatedAt)) return
    const key = String(source.number)
    this.mirrors.overview.delete(key)
    this.mirrors.detail.delete(key)
    const pr = this.absorb(source)
    if (!this.loaded || this.items.some((item) => item.number === source.number)) return
    const { state = 'open', query, author, head } = this.filter
    if (query || author || head) return
    const shown = state === 'all' || (state === 'open' ? source.state === 'open' : source.state !== 'open')
    if (shown) this.items.unshift(pr)
  }

  // --- Reading ------------------------------------------------------------

  /**
   * Append this project's next page — what "load more" is. The first page is
   * `PrsStore`'s to read (`beginListing` / `acceptListing`).
   *
   * Dropped if the project moved under it: the filter changed, or a newer page
   * was asked for while this one was on the wire.
   */
  async loadMore(): Promise<void> {
    if (!this.hasMore || this.loadingMore) return
    const filter = structuredClone($state.snapshot(this.filter))
    const page = this.nextPage
    const startedAt = this.listKey(filter)

    this.loading = true
    this.loadingMore = true
    try {
      const result = await this.query(filter, { page })
      if (!this.mirrors.list.holds(this.listKey(filter, page), result)) return
      if (this.listKey(this.filter) !== startedAt || this.nextPage !== page) return

      this.acceptPage(result, true)
    } catch (error) {
      this.error = prSurfaceError(error)
    } finally {
      this.loading = false
      this.loadingMore = false
    }
  }

  /**
   * Mark the first page as on its way from a read that covers several projects
   * at once (`PrsStore.listProjects`). Answers a token: only the read that
   * started last may land its answer or lower the flag.
   */
  beginListing(filter: PrFilter): number {
    this.filter = structuredClone(filter)
    this.loading = true
    this.loadingMore = false
    this.error = null
    this.listingRevision = this.revision
    return ++this.listingToken
  }

  /** Take this project's part of that read. Dropped if a newer read began, the
   *  filter moved, or a host event or write superseded it while it was on the
   *  wire — a late page must not bring back a row the event already changed. */
  acceptListing(token: number, filter: PrFilter, listing: PrProjectListing): void {
    if (token !== this.listingToken || this.listKey(this.filter) !== this.listKey(filter)) return
    if (this.revision !== this.listingRevision) return
    if ('unavailable' in listing) {
      this.error = prUnavailable(listing.unavailable)
      return
    }
    if ('error' in listing) {
      this.error = prSurfaceError(listing.error)
      return
    }
    // Filed as this project's own first page, so a later `list` or `query` of
    // the same question shares it rather than asking again.
    const key = this.listKey(filter)
    this.mirrors.list.seed(key, listing.page)
    this.absorbListed(filter, listing.page)
    this.acceptPage(listing.page, false)
  }

  /** The whole read failed — the host could not answer for any project. */
  failListing(token: number, error: Parameters<typeof prSurfaceError>[0]): void {
    if (token === this.listingToken) this.error = prSurfaceError(error)
  }

  endListing(token: number): void {
    if (token === this.listingToken) this.loading = false
  }

  /** Drop this filter's pages here and on the host, so the next read asks the
   *  code host again. What a person's refresh does before it reads. */
  async forgetListing(filter: PrFilter): Promise<void> {
    const key = this.listKey(filter)
    this.mirrors.list.deleteByPrefix(key.slice(0, key.lastIndexOf('::') + 2))
    await this.refreshHost()
  }

  /**
   * Show a list remembered from an earlier visit until the first read answers.
   * Only into an empty, never-loaded list: a live answer always wins, and the
   * rows are not absorbed into the index, so no other surface mistakes a
   * remembered pull request for one the host has just described.
   */
  showCached(items: Contracts.PullRequest[]): void {
    if (this.loaded || this.items.length > 0) return
    this.items = items
  }

  /** Take a page the host answered with: appended if it continues the list,
   *  replacing it if it is the first. */
  private acceptPage(result: PrListPage, appending: boolean): void {
    const items = result.items.map((item) => this.get(item.number))
    if (appending) {
      const known = new Set(this.items.map((item) => item.number))
      for (const item of items) if (!known.has(item.number)) this.items.push(item)
    } else {
      this.items = items
      this.loaded = true
    }
    this.hasMore = result.hasMore
    this.nextPage = result.page + 1
  }

  /**
   * Ask the host a question and answer with the rows.
   *
   * Not a list load: it writes none of the state above, so a caller can narrow
   * by its own filter — a branch probe, the `#` menu's candidates — without
   * disturbing the page. Rows still reach the index, because a pull request
   * seen is a pull request known however it was asked for.
   */
  async query(filter: PrFilter, opts: PrQuery = {}): Promise<PrListPage> {
    const ctx = detached(this.ctx)
    const safeFilter = structuredClone(filter)
    const page = opts.page ?? 1
    const key = this.listKey(safeFilter, page)
    const result = await this.mirrors.list.read(key, !!opts.force, () => this.api.prList(ctx, safeFilter, page))
    if (this.mirrors.list.holds(key, result)) this.absorbListed(safeFilter, result)
    return result
  }

  private absorbListed(filter: PrFilter, result: PrListPage): void {
    // Keep the host's first branch match when several PRs reuse a branch.
    for (const item of result.items.toReversed()) this.absorb(item)
    if (filter.head && !result.items.some((item) => item.headRef === filter.head)) {
      this.byBranch.delete(filter.head)
    }
  }

  /** The connected token's user — the identity comment composers post as, with
   *  the avatar they draw. Stable per project, so the short list lifetime costs
   *  at most an occasional refetch of a value the provider caches per token. */
  async loadViewer(): Promise<Contracts.ProviderViewer> {
    const ctx = detached(this.ctx)
    return this.mirrors.viewer.read('viewer', false, () => this.api.providerViewer(ctx))
  }

  /**
   * A person's refresh: the host forgets this project's pull requests and PR
   * sync reads the repository now; what changed arrives as `pr.changed`.
   *
   * A refresh is a person asking for the code host to be asked again, and the
   * host shares its answers between clients — so clearing local state is not
   * enough. Swallowed, because a project with no repository refuses this the
   * same way it refuses the read that follows, and that read owns the message.
   */
  async refreshHost(): Promise<void> {
    try {
      await this.api.prRefresh(detached(this.ctx))
    } catch {
      // Intentionally ignored; see above.
    }
  }

  private listKey(filter: PrFilter, page = 1): string {
    return `${filter.state ?? 'open'}::${filter.author ?? ''}::${filter.head ?? ''}::${filter.query?.trim() ?? ''}::${page}`
  }
}
