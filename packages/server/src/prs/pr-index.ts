import type { NumberedPrChecksSummary } from '@solus/contracts/checks-rpc-types'
import type * as Contracts from '@solus/contracts/providers'
import type { PrFilter, PrListPage, RepoRef } from '@solus/contracts/providers'
import type { PrPageRequest, PriorityNumbers, Provider } from '../providers/types'
import { CachedField } from './cached-field'
import { PullRequest } from './pull-request'

/** Sized like the clients' own stale time; a listing reorders when anything on it moves. */
const LIST_TTL_MS = 30_000
const NEEDS_REVIEW_TTL_MS = 30_000

/**
 * **Must exceed a repository's open pull request count.** The checks poll files
 * one entity per open pull request, so a cap below that would evict the earliest
 * of them before the poll had finished filing the rest — and the snapshot it
 * then assembles would silently be missing rows. A thousand is past any real
 * repository, and an entity holding only a checks summary costs very little; the
 * ones that grow are the ones somebody opened.
 */
const ENTITY_CAPACITY = 1024
const LISTING_CAPACITY = 64

export function repoKeyOf(repo: RepoRef): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`
}

function listingKey(repo: RepoRef, viewer: string, filter: PrFilter | undefined, page: number, cursor: string | null): string {
  return [
    repoKeyOf(repo),
    viewer,
    filter?.state ?? 'open',
    filter?.author ?? '',
    filter?.head ?? '',
    filter?.query?.trim() ?? '',
    page,
    cursor ?? '',
  ].join('::')
}

/** The answers `PrIndex.listPriority` gives for one repository. */
export interface PriorityReads {
  authored: Promise<PrListPage>
  /** Null for closed pull requests, which no review request stands on. */
  needsReview: Promise<Contracts.PullRequest[]> | null
}

/** Hears one new answer about the open pull requests waiting on `viewer`. */
type NeedsReviewListener = (repo: RepoRef, viewer: string, rows: Contracts.PullRequest[]) => void

/** One repository read on its own, down the provider's whole credential chain. */
async function readAlone(provider: Provider, request: PrPageRequest, filter: PrFilter | undefined, viewer: string): Promise<PrListPage> {
  const [found] = await provider.review.listPullRequestPages([request], filter, viewer)
  if (!found) throw new Error(`Could not read the pull requests of ${request.repo.owner}/${request.repo.repo}.`)
  return found
}

/** GitHub owners and repositories are case-insensitive, and the same pull
 *  request arrives spelled both ways — from a remote URL and from a task link. */
function entityKey(scope: string, number: number): string {
  return `${scope.toLowerCase()}::${number}`
}

/**
 * Least-recently-used, by insertion order. A `Map` preserves the order keys were
 * added, so touching an entry means deleting and re-adding it — which moves it
 * to the end and leaves the oldest at the front for eviction.
 */
function touch<T>(entries: Map<string, T>, key: string, value: T, capacity: number): void {
  entries.delete(key)
  entries.set(key, value)
  if (entries.size > capacity) {
    const oldest = entries.keys().next()
    if (!oldest.done) entries.delete(oldest.value)
  }
}

/**
 * Every pull request this server has read, and the listings that found them.
 *
 * **Identity is `(repo, number)`, not the project path and not the account.**
 * Two worktrees of one repository are two checkouts of the same pull requests,
 * so keying by project made one server read the same host twice for one answer.
 * The account is not in the key because nearly nothing about a pull request
 * depends on who is asking — see `PullRequest`, which holds the one field that
 * does, `viewerPermissions`, per viewer inside itself.
 *
 * Listings *are* keyed by viewer: which pull requests are yours to review is a
 * question about you.
 */
export class PrIndex {
  private readonly entities = new Map<string, PullRequest>()
  private readonly listings = new Map<string, CachedField<PrListPage>>()
  private readonly needsReview = new Map<string, CachedField<Contracts.PullRequest[]>>()
  private readonly readListeners = new Set<(repo: RepoRef, pullRequest: Contracts.PullRequest) => void>()
  private readonly needsReviewListeners = new Set<NeedsReviewListener>()

  /**
   * Hear every pull request answer an entity reads or is handed: a review pane's
   * fresh read, a watch's read, a write's response. PR sync listens, so a state
   * that one read path sees reaches the links and every client without waiting
   * for its next repository read.
   */
  onPullRequestRead(listener: (repo: RepoRef, pullRequest: Contracts.PullRequest) => void): () => void {
    this.readListeners.add(listener)
    return () => { this.readListeners.delete(listener) }
  }

  /**
   * Hear every new answer about the pull requests waiting on a viewer: the
   * review-requested search of a list read, and PR sync's own read. A
   * remembered answer is not heard again. PR sync listens, so the sidebar
   * count and the notifications hub get what a list read found, and no clock
   * asks the code host for it.
   */
  onNeedsReviewRead(listener: NeedsReviewListener): () => void {
    this.needsReviewListeners.add(listener)
    return () => { this.needsReviewListeners.delete(listener) }
  }

  /**
   * The entity for one pull request, created on first touch.
   *
   * Synchronous, and deliberately so: the checks poller writes here without
   * acting for any client, so needing an account to find a pull request would
   * be a question it has no answer to.
   */
  pullRequest(repo: RepoRef, provider: Provider, number: number): PullRequest {
    const key = entityKey(repoKeyOf(repo), number)
    const existing = this.entities.get(key)
    if (existing) {
      touch(this.entities, key, existing, ENTITY_CAPACITY)
      return existing
    }
    const created = new PullRequest(repo, number, provider, (pullRequest) => {
      for (const listener of this.readListeners) listener(repo, pullRequest)
    })
    touch(this.entities, key, created, ENTITY_CAPACITY)
    return created
  }

  /**
   * The last answer read for a pull request named by its repository key, or
   * undefined if nothing on this server has read it. Never costs a request and
   * never creates an entity: this is for the task sidebar, which names pull
   * requests by the scope a link was saved with and has no provider in hand.
   */
  lastRead(scope: string, number: number): Contracts.PullRequest | undefined {
    return this.entities.get(entityKey(scope, number))?.lastRead()
  }

  /** A detail read of a pull request that is in flight or younger than
   *  `maxAgeMs` (`PullRequest.recentDetail`). Never creates an entity. */
  recentDetail(repo: RepoRef, number: number, maxAgeMs: number): Promise<Contracts.PullRequest> | null {
    return this.entities.get(entityKey(repoKeyOf(repo), number))?.recentDetail(maxAgeMs) ?? null
  }

  /**
   * File what one checks poll returned, and answer with the pull requests it
   * covered so the caller can publish them.
   *
   * The poll asks about a whole repository at once, so this is where a batch
   * becomes per-pull-request facts. Numbers it names that nothing has opened get
   * an entity here: they are real pull requests, and the surface showing their
   * check marks is the pull request list.
   */
  absorbChecks(repo: RepoRef, provider: Provider, summaries: ReadonlyArray<NumberedPrChecksSummary>): void {
    for (const summary of summaries) {
      this.pullRequest(repo, provider, summary.number).absorbChecks(summary)
    }
  }

  /** The check runs held for these pull requests, in the order asked for. */
  checksFor(repo: RepoRef, numbers: ReadonlyArray<number>): NumberedPrChecksSummary[] {
    const prefix = repoKeyOf(repo)
    const found: NumberedPrChecksSummary[] = []
    for (const number of numbers) {
      const summary = this.entities.get(entityKey(prefix, number))?.checks()
      if (summary) found.push(summary)
    }
    return found
  }

  /** `viewer` is the caller's login: the listing is cached per account, and the
   *  caller has already resolved it to attach review attention. A page past
   *  the first needs the cursor the page before it answered. */
  async list(
    repo: RepoRef,
    provider: Provider,
    viewer: string,
    filter: PrFilter | undefined,
    page: number,
    cursor: string | null = null,
  ): Promise<PrListPage> {
    // A later page with no place to start from has nothing to continue.
    if (page > 1 && !cursor) return { items: [], page, hasMore: false }
    return this.listingField(listingKey(repo, viewer, filter, page, cursor))
      .read(() => readAlone(provider, { repo, page, cursor }, filter, viewer))
  }

  async listNeedsReview(repo: RepoRef, provider: Provider, viewer: string): Promise<Contracts.PullRequest[]> {
    return this.readNeedsReview(repo, viewer, () => provider.review.listPullRequestsNeedingReview(repo, viewer))
  }

  /**
   * A page of each repository: page one, or the page its cursor names. The
   * same answers `list` gives, filed under the same keys.
   *
   * What is still young costs nothing. Every repository with a page to read
   * goes into one provider read, so many projects cost one search instead of
   * several requests each.
   *
   * A repository the read could not see at all is left out of the answer, so
   * the caller reads it the ordinary way: with the credential, and the viewer,
   * that can see it. Its page is still read alone here, so a reader that joined
   * it gets an answer. Keyed by `repoKeyOf`.
   */
  async listPages(
    provider: Provider,
    requests: PrPageRequest[],
    viewer: string,
    filter: PrFilter | undefined,
  ): Promise<Map<string, Promise<PrListPage>>> {
    const pending: PrPageRequest[] = []
    let startBatch: (rows: Promise<Array<PrListPage | null>>) => void = () => {}
    const batch = new Promise<Array<PrListPage | null>>((resolve) => { startBatch = resolve })

    const reads = new Map<string, { request: PrPageRequest; read: Promise<PrListPage> }>()
    for (const request of requests) {
      const { repo, page, cursor } = request
      const key = repoKeyOf(repo)
      if (reads.has(key)) continue
      reads.set(key, {
        request,
        read: page > 1 && !cursor
          ? Promise.resolve({ items: [], page, hasMore: false })
          // Called only if the page is not young; the batch starts once the
          // loop has named every repository it needs.
          : this.listingField(listingKey(repo, viewer, filter, page, cursor)).read(() => {
              const index = pending.push(request) - 1
              return batch.then((rows) => rows[index] ?? readAlone(provider, request, filter, viewer))
            }),
      })
    }
    startBatch(pending.length > 0
      // A failed read answers nothing: each project is then read alone.
      ? provider.review.listPullRequestPages(pending, filter, viewer).catch(() => pending.map(() => null))
      : Promise.resolve([]))

    const rows = await batch
    const answered = new Map<string, Promise<PrListPage>>()
    for (const [key, entry] of reads) {
      const index = pending.indexOf(entry.request)
      if (index < 0 || rows[index]) answered.set(key, entry.read)
      // The caller reads this one itself; this read answers whoever joined it.
      else entry.read.catch(() => {})
    }
    return answered
  }

  /**
   * Each repository's priority rows, the same answers `list` and
   * `listNeedsReview` give, filed under the same keys. One search names the
   * pull requests of every repository with a part to read. A row comes from
   * the first page where that page holds it, and only the others are read, so
   * a person whose pull requests are all on the page costs no row twice.
   */
  listPriority(
    provider: Provider,
    repos: RepoRef[],
    viewer: string,
    state: NonNullable<PrFilter['state']>,
  ): Map<string, PriorityReads> {
    const pending: RepoRef[] = []
    let startBatch: (rows: Promise<Array<PriorityNumbers | null>>) => void = () => {}
    const batch = new Promise<Array<PriorityNumbers | null>>((resolve) => { startBatch = resolve })
    const batched = (repo: RepoRef): Promise<PriorityNumbers | null> => {
      let index = pending.indexOf(repo)
      if (index < 0) index = pending.push(repo) - 1
      return batch.then((rows) => rows[index] ?? null)
    }
    const rowsOf = async (repo: RepoRef, numbers: number[]): Promise<Contracts.PullRequest[]> => {
      const held = new Map((await this.list(repo, provider, viewer, { state }, 1)).items.map((row) => [row.number, row]))
      const missing = numbers.filter((number) => !held.has(number))
      const read = missing.length > 0 ? await provider.review.getPullRequests(repo, missing) : new Map<number, Contracts.PullRequest | null>()
      return numbers.flatMap((number) => held.get(number) ?? read.get(number) ?? [])
    }

    const reads = new Map<string, PriorityReads>()
    for (const repo of repos) {
      const key = repoKeyOf(repo)
      if (reads.has(key)) continue
      const authoredFilter: PrFilter = { state, query: `author:${viewer}` }
      reads.set(key, {
        authored: this.listingField(listingKey(repo, viewer, authoredFilter, 1, null)).read(() => batched(repo).then(async (found) => found
          ? { items: await rowsOf(repo, found.authored.numbers), page: 1, hasMore: found.authored.hasMore }
          : readAlone(provider, { repo, page: 1, cursor: null }, authoredFilter, viewer))),
        needsReview: state === 'closed' ? null : this.readNeedsReview(repo, viewer, () => batched(repo).then(async (found) => {
          if (!found?.needsReview) return provider.review.listPullRequestsNeedingReview(repo, viewer)
          const rows = await rowsOf(repo, [...new Set(found.needsReview)])
          return rows.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        })),
      })
    }
    startBatch(pending.length > 0
      // A failed read answers nothing: each part is then read alone.
      ? provider.review.listPriorityNumbers(pending, state, viewer).catch(() => pending.map(() => null))
      : Promise.resolve([]))
    return reads
  }

  /**
   * Forget what was read for a repository, for every viewer of it.
   *
   * Called after a write, so the client that made it and every other client see
   * the action on their next read without asking. Whole-repository rather than
   * one pull request, because a write reorders the listings its pull request
   * appears on and can change a neighbour — a merge moves what is behind it.
   */
  invalidate(repo: RepoRef): void {
    const prefix = `${repoKeyOf(repo).toLowerCase()}::`
    for (const [key, entity] of this.entities) {
      if (key.startsWith(prefix)) entity.forget()
    }
    this.invalidateListings(repo)
  }

  /**
   * Forget the listings of a repository, for every viewer, and keep each pull
   * request. A turn that pushed can add a pull request or reorder a list, but
   * a pull request it changed is read again by PR sync.
   */
  invalidateListings(repo: RepoRef): void {
    // Listing keys keep the remote's case; the same repository arrives spelled both ways.
    const prefix = `${repoKeyOf(repo).toLowerCase()}::`
    for (const key of this.listings.keys()) if (key.toLowerCase().startsWith(prefix)) this.listings.delete(key)
    for (const key of this.needsReview.keys()) if (key.toLowerCase().startsWith(prefix)) this.needsReview.delete(key)
  }

  /** Exposed for tests: how many entities are held right now. */
  get size(): number {
    return this.entities.size
  }

  /** The remembered answer, or a new one that every listener hears. */
  private readNeedsReview(
    repo: RepoRef,
    viewer: string,
    load: () => Promise<Contracts.PullRequest[]>,
  ): Promise<Contracts.PullRequest[]> {
    return this.needsReviewField(repo, viewer).read(() => load().then((rows) => {
      for (const listener of this.needsReviewListeners) listener(repo, viewer, rows)
      return rows
    }))
  }

  private needsReviewField(repo: RepoRef, viewer: string): CachedField<Contracts.PullRequest[]> {
    const key = `${repoKeyOf(repo)}::${viewer}`
    const field = this.needsReview.get(key) ?? new CachedField<Contracts.PullRequest[]>(NEEDS_REVIEW_TTL_MS)
    touch(this.needsReview, key, field, LISTING_CAPACITY)
    return field
  }

  private listingField(key: string): CachedField<PrListPage> {
    const existing = this.listings.get(key)
    const field = existing ?? new CachedField<PrListPage>(LIST_TTL_MS)
    touch(this.listings, key, field, LISTING_CAPACITY)
    return field
  }
}

/**
 * The server's index. A module singleton for the same reason the checks cache is
 * one: it is shared by every client on this server, which is the whole point —
 * two clients reading one pull request cost one host request.
 */
export const prIndex = new PrIndex()
