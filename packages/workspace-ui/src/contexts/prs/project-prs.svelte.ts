// One project's pull requests, on one host.
//
// This *is* the project, so nothing here takes a `serverId` or a context — which
// is why there is one `list`, and why pagination is a page number handed to it
// rather than a second function.
//
// `PrsStore` is a map of these keyed by project; `PullRequest` is one of the
// pull requests in this one.

import type { HostApi } from '@solus/client-core/host-api'
import { hostKey } from '@solus/client-core/host-key'
import type { GitPullRequestStep } from '@solus/contracts/git-types'
import type * as Contracts from '@solus/contracts/providers'
import type { PrFilter, PrListPage } from '@solus/contracts/providers'
import { projectScopeOf, worktreeProjectRoot, type IpcContext } from '@solus/contracts/types'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { prSurfaceError, type PrSurfaceError } from '../../components/prs/lib/pr-surface-error'
import { PrMirrors } from './pr-mirror'
import { PullRequest } from './pull-request.svelte'

const BACKGROUND_RETRY_MS = 5 * 60_000

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

/** What one `list` was asked for. A page past the first appends to the rows. */
export interface PrList {
  /** Absent means the first page, which replaces the list. */
  page?: number
  /** Absent keeps the filter already in use. */
  filter?: PrFilter
  /** Ask the code host again rather than sharing what it has already fetched. */
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

  /** Numbers the provider refused — deleted, private, never existed. Without it
   *  a render-driven lookup asks again every frame, because a failed read leaves
   *  nothing behind to hit. */
  readonly missing = new SvelteSet<number>()

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

  /** What `ensure*` has already asked for, so it is safe on a render path. */
  private allPageRead: Promise<void> | undefined
  private revision = 0
  private readonly backgroundRetryAt = new Map<string, number>()
  private readonly ensuredNumbers = new Set<number>()

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
    this.backgroundRetryAt.delete(`detail::${source.number}`)
    const pr = this.get(source.number)
    pr.apply(source)
    this.byBranch.set(source.headRef, source.number)
    this.missing.delete(source.number)
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

  // --- Reading ------------------------------------------------------------

  /**
   * Read this project's pull requests.
   *
   * With no page, the first — which replaces the list. With a page, that page is
   * appended, which is all "load more" is: the same call, further in.
   *
   * A response is dropped if the project moved under it: the filter changed, the
   * page being appended to is no longer the one wanted, or a newer fan-out
   * replaced the read that started it.
   */
  async list(opts: PrList = {}, isCurrent?: () => boolean): Promise<void> {
    if (opts.filter) this.filter = structuredClone(opts.filter)
    const appending = opts.page !== undefined && opts.page > 1
    if (appending && (!this.hasMore || this.loadingMore)) return

    const filter = structuredClone($state.snapshot(this.filter))
    const page = opts.page ?? 1
    const startedAt = this.listKey(filter)

    this.loading = true
    this.loadingMore = appending
    if (!appending) this.error = null
    if (opts.force) {
      this.mirrors.list.deleteByPrefix(startedAt.slice(0, startedAt.lastIndexOf('::') + 2))
      await this.forgetHostCache()
    }

    try {
      const read: PrQuery = { page }
      if (opts.force !== undefined) read.force = opts.force
      const result = await this.query(filter, read)
      if (!this.mirrors.list.holds(this.listKey(filter, page), result)) return
      if (this.listKey(this.filter) !== startedAt) return
      if (appending && this.nextPage !== page) return
      if (isCurrent && !isCurrent()) return

      this.acceptPage(result, appending)
    } catch (error) {
      if (isCurrent && !isCurrent()) return
      this.error = prSurfaceError(error)
    } finally {
      this.loading = false
      this.loadingMore = false
    }
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
    const result = await this.mirrors.list.read(
      this.listKey(safeFilter, page),
      !!opts.force,
      () => this.api.prList(ctx, safeFilter, page),
    )
    if (this.mirrors.list.holds(this.listKey(safeFilter, page), result)) {
      this.backgroundRetryAt.delete(`list::${this.listKey(safeFilter, page)}`)
      // Keep the host's first branch match when several PRs reuse a branch.
      for (const item of result.items.toReversed()) this.absorb(item)
      if (safeFilter.head && !result.items.some((item) => item.headRef === safeFilter.head)) {
        this.byBranch.delete(safeFilter.head)
      }
    }
    return result
  }

  /** Share one summary page, then recover linked PRs absent from that page.
   * Full detail surfaces can also request fields omitted from summaries. */
  async refreshObserved(numbers: number[], branches: string[], details: number[] = [], linkedNumbers: number[] = []): Promise<boolean> {
    const revision = this.revision
    const needsPage = numbers.length > 0 || linkedNumbers.length > 0
    const page = needsPage
      ? await this.readBackground(`list::${this.listKey({ state: 'all' })}`, () => this.query({ state: 'all' }))
      : null
    // A failed project lookup cannot justify a fan-out of detail reads against
    // that same unavailable project (including stale non-directory scopes).
    if (needsPage && !page) return false
    const missingLinks = linkedNumbers.filter((number) => !page?.items.some((pr) => pr.number === number))
    for (const number of new Set([...details, ...missingLinks])) {
      if (revision !== this.revision) return false
      await this.readBackground(`detail::${number}`, () => this.get(number).loadDetail())
    }
    for (const head of branches) {
      if (revision !== this.revision) return false
      if (page && (!page.hasMore || page.items.some((pr) => pr.headRef === head))) continue
      await this.readBackground(`list::${this.listKey({ state: 'all', head })}`, () => this.query({ state: 'all', head }))
    }
    return revision === this.revision
  }

  private async readBackground<T>(key: string, read: () => Promise<T>): Promise<T | undefined> {
    if ((this.backgroundRetryAt.get(key) ?? 0) > Date.now()) return
    const revision = this.revision
    try {
      return await read()
    } catch {
      if (revision === this.revision) this.backgroundRetryAt.set(key, Date.now() + BACKGROUND_RETRY_MS)
    }
  }

  /**
   * Make sure these pull requests are known, then stop asking.
   *
   * Cheap by construction and safe on every render: one `state: 'all'` page
   * answers most numbers at once, only the stragglers cost an individual read,
   * and a number the provider refuses is remembered rather than re-requested.
   */
  ensureNumbers(numbers: number[]): Promise<void> {
    const wanted = numbers.filter((number) => number > 0)
    return wanted.length ? this.ensureNumbersAsync(wanted).catch(() => {}) : Promise.resolve()
  }

  private async ensureNumbersAsync(numbers: number[]): Promise<void> {
    // Allocating an entity does not load its status. A linked PR remains
    // unknown until a provider response describes it.
    const unknown = () => numbers.filter((number) => !this.prFor(number) && !this.missing.has(number))
    if (!unknown().length) return

    // Every row must wait for the shared page. A boolean set before the read
    // completes lets later rows race ahead and request each detail separately.
    this.allPageRead ??= this.query({ state: 'all' }).then(() => {}, () => {})
    await this.allPageRead

    for (const number of unknown()) {
      if (this.ensuredNumbers.has(number)) continue
      this.ensuredNumbers.add(number)
      try {
        await this.get(number).loadDetail()
      } catch {
        this.missing.add(number)
      }
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
   * Tell the host to forget this project's pull requests.
   *
   * A refresh is a person asking for the code host to be asked again, and the
   * host shares its answers between clients — so clearing local state is not
   * enough. Swallowed, because a project with no repository refuses this the
   * same way it refuses the read that follows, and that read owns the message.
   */
  async forgetHostCache(): Promise<void> {
    try {
      await this.api.prInvalidate(detached(this.ctx))
    } catch {
      // Intentionally ignored; see above.
    }
  }

  /** Forget everything read for this project, keeping its identity. */
  forgetAll(): void {
    this.revision++
    this.backgroundRetryAt.clear()
    this.mirrors.forgetPrefix('')
    this.mirrors.viewer.delete('viewer')
    this.allPageRead = undefined
    this.ensuredNumbers.clear()
  }

  private listKey(filter: PrFilter, page = 1): string {
    return `${filter.state ?? 'open'}::${filter.author ?? ''}::${filter.head ?? ''}::${filter.query?.trim() ?? ''}::${page}`
  }
}
