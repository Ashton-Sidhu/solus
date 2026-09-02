import type { NumberedPrChecksSummary } from '@solus/contracts/checks-rpc-types'
import type * as Contracts from '@solus/contracts/providers'
import type { PrFilter, PrListPage, RepoRef } from '@solus/contracts/providers'
import type { Provider } from '../providers/types'
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

  /**
   * The entity for one pull request, created on first touch.
   *
   * Synchronous, and deliberately so: the checks poller writes here without
   * acting for any client, so needing an account to find a pull request would
   * be a question it has no answer to.
   */
  pullRequest(repo: RepoRef, provider: Provider, number: number): PullRequest {
    const key = `${repoKeyOf(repo)}::${number}`
    const existing = this.entities.get(key)
    if (existing) {
      touch(this.entities, key, existing, ENTITY_CAPACITY)
      return existing
    }
    const created = new PullRequest(repo, number, provider)
    touch(this.entities, key, created, ENTITY_CAPACITY)
    return created
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
      const summary = this.entities.get(`${prefix}::${number}`)?.checks()
      if (summary) found.push(summary)
    }
    return found
  }

  async list(repo: RepoRef, provider: Provider, filter: PrFilter | undefined, page: number): Promise<PrListPage> {
    const viewerLogin = await provider.review.getViewer(repo)
    const key = [
      repoKeyOf(repo),
      viewerLogin,
      filter?.state ?? 'open',
      filter?.author ?? '',
      filter?.head ?? '',
      page,
    ].join('::')
    return this.listingField(key).read(() => provider.review.listPullRequestsPage(repo, filter, page))
  }

  async listNeedsReview(repo: RepoRef, provider: Provider, viewer: string): Promise<Contracts.PullRequest[]> {
    const key = `${repoKeyOf(repo)}::${viewer}`
    let field = this.needsReview.get(key)
    if (!field) field = new CachedField<Contracts.PullRequest[]>(NEEDS_REVIEW_TTL_MS)
    touch(this.needsReview, key, field, LISTING_CAPACITY)
    return field.read(() => provider.review.listPullRequestsNeedingReview(repo, viewer))
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
    const prefix = `${repoKeyOf(repo)}::`
    for (const [key, entity] of this.entities) {
      if (key.startsWith(prefix)) entity.forget()
    }
    for (const key of this.listings.keys()) if (key.startsWith(prefix)) this.listings.delete(key)
    for (const key of this.needsReview.keys()) if (key.startsWith(prefix)) this.needsReview.delete(key)
  }

  /** Exposed for tests: how many entities are held right now. */
  get size(): number {
    return this.entities.size
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
