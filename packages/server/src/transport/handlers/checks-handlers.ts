import type { PrChecksSnapshot } from '@solus/contracts/checks-rpc-types'
import { createLogger } from '../../logger'
import type { Provider } from '../../providers/types'
import type { RepoRef } from '@solus/contracts/providers'
import { reviewTargetFor } from './provider-handlers'
import { prIndex } from '../../prs/pr-index'
import type { SolusServer } from '../server'

const log = createLogger('main', 'checks-handlers')
/** How long a pull request's checks are shared before the next read asks again. */
const STALE_MS = 30_000
/** A number not read for this long is forgotten. */
const FORGET_MS = 10 * STALE_MS
/** Repositories held at once; the one read least recently goes first. */
const CACHE_CAPACITY = 64

/**
 * What the reads learned about a repository's pull requests — not where the
 * check runs are kept. Those live on each `PullRequest` in `PrIndex`, because
 * a pull request's checks are a fact about that pull request.
 *
 * Each pull request has its own read time, so a read asks the code host only
 * for the numbers it names that are unknown or stale. A number that no read
 * names again costs nothing.
 */
interface RepoChecksCache {
  repo: RepoRef
  provider: Provider
  readAt: Map<number, number>
  /** The read in flight for each number; true when that read failed. */
  reading: Map<number, Promise<boolean>>
}

const caches = new Map<string, RepoChecksCache>()

function ensureCache(repo: RepoRef, provider: Provider): RepoChecksCache {
  const key = repoKey(repo)
  const cache = caches.get(key) ?? { repo, provider, readAt: new Map(), reading: new Map() }
  // A Map keeps insertion order: moved to the end, the oldest stays first.
  caches.delete(key)
  caches.set(key, cache)
  const oldest = caches.keys().next()
  if (caches.size > CACHE_CAPACITY && !oldest.done) caches.delete(oldest.value)
  return cache
}

/** Reads the stale numbers in one call, shares a read already in flight, and
 *  answers whether any read of these numbers failed. */
async function readChecks(cache: RepoChecksCache, numbers: readonly number[]): Promise<boolean> {
  const now = Date.now()
  for (const [number, readAt] of cache.readAt) if (now - readAt >= FORGET_MS) cache.readAt.delete(number)
  const stale = numbers.filter((number) =>
    !cache.reading.has(number) && now - (cache.readAt.get(number) ?? 0) >= STALE_MS)
  if (stale.length > 0) {
    const read = (async () => {
      try {
        const checks = await cache.provider.review.listChecks(cache.repo, stale)
        prIndex.absorbChecks(cache.repo, cache.provider, checks)
        const readAt = Date.now()
        for (const number of stale) cache.readAt.set(number, readAt)
        return false
      } catch (err) {
        log.warn('checks_read_failed', { key: repoKey(cache.repo), error: err instanceof Error ? err.message : String(err) })
        return true
      } finally {
        for (const number of stale) cache.reading.delete(number)
      }
    })()
    for (const number of stale) cache.reading.set(number, read)
  }
  const reads = new Set(numbers.flatMap((number) => cache.reading.get(number) ?? []))
  const failed = await Promise.all(reads)
  return failed.some(Boolean)
}

interface ChecksHandlersDeps {
  resolveReviewTarget?: typeof reviewTargetFor
}

/**
 * Check runs as a read. A list asks for the rows it shows and gets the checks
 * of those rows only; an answer younger than `STALE_MS` is shared. An open
 * review pane's checks are kept fresh by PR sync (docs/plans/pr-sync.md), not
 * by this handler.
 */
export function registerChecksHandlers(server: SolusServer, deps: ChecksHandlersDeps = {}): void {
  const resolveReviewTarget = deps.resolveReviewTarget ?? reviewTargetFor
  server.register('prChecks', async (args) => {
    const [ctx, numbers = []] = args
    const { repo, provider } = await resolveReviewTarget(ctx)
    const cache = ensureCache(repo, provider)
    const loadFailed = await readChecks(cache, numbers)
    return {
      repo: cache.repo,
      checks: prIndex.checksFor(cache.repo, numbers),
      loadFailed,
    } satisfies PrChecksSnapshot
  })
}

function repoKey(repo: RepoRef): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`
}
