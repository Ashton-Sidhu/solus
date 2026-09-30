import type { PrChecksSnapshot } from '@solus/contracts/checks-rpc-types'
import { createLogger } from '../../logger'
import type { Provider, RepoRef } from '../../providers/types'
import { reviewTargetFor } from './provider-handlers'
import { prIndex } from '../../prs/pr-index'
import type { SolusServer } from '../server'

const log = createLogger('main', 'checks-handlers')
/** How long a read's answer is shared before the next read asks again. */
const STALE_MS = 30_000

/**
 * What the last read learned about a repository — not where the check runs are
 * kept. Those live on each `PullRequest` in `PrIndex`, because a pull request's
 * checks are a fact about that pull request.
 */
interface RepoChecksCache {
  repo: RepoRef
  provider: Provider
  loadFailed: boolean
  lastAttemptAt: number
  trackedPrNumbers: number[]
  refresh?: Promise<void>
}

const caches = new Map<string, RepoChecksCache>()

function ensureCache(repo: RepoRef, provider: Provider): RepoChecksCache {
  const key = repoKey(repo)
  let cache = caches.get(key)
  if (!cache) {
    cache = {
      repo,
      provider,
      loadFailed: false,
      lastAttemptAt: 0,
      trackedPrNumbers: [],
    }
    caches.set(key, cache)
  }
  return cache
}

async function refreshCache(
  cache: RepoChecksCache,
  requestedNumbers: number[] = [],
): Promise<void> {
  if (cache.refresh) {
    await cache.refresh
    if (requestedNumbers.some((number) => !cache.trackedPrNumbers.includes(number))) {
      return refreshCache(cache, requestedNumbers)
    }
    return
  }
  if (cache.trackedPrNumbers.length === 0 && requestedNumbers.length === 0) {
    cache.loadFailed = false
    cache.lastAttemptAt = Date.now()
    return
  }
  const key = repoKey(cache.repo)
  cache.refresh = (async () => {
    try {
      cache.trackedPrNumbers = [...new Set([...cache.trackedPrNumbers, ...requestedNumbers])]
      const checks = await cache.provider.review.listChecks(cache.repo, cache.trackedPrNumbers)
      // The poll asks about a whole repository; the index is where that becomes
      // one pull request's own check runs.
      prIndex.absorbChecks(cache.repo, cache.provider, checks)
      cache.loadFailed = false
    } catch (err) {
      cache.loadFailed = true
      log.warn('checks_poll_failed', { key, error: err instanceof Error ? err.message : String(err) })
    } finally {
      cache.lastAttemptAt = Date.now()
      cache.refresh = undefined
    }
  })()
  return cache.refresh
}

interface ChecksHandlersDeps {
  resolveReviewTarget?: typeof reviewTargetFor
}

/**
 * Check runs as a read. A list asks for the rows it shows; an answer younger
 * than `STALE_MS` is shared. An open review pane's checks are kept fresh by PR
 * sync (docs/plans/pr-sync.md), not by this handler.
 */
export function registerChecksHandlers(server: SolusServer, deps: ChecksHandlersDeps = {}): void {
  const resolveReviewTarget = deps.resolveReviewTarget ?? reviewTargetFor
  server.register('prChecks', async (args) => {
    const [ctx, numbers = []] = args
    const { repo, provider } = await resolveReviewTarget(ctx)
    const cache = ensureCache(repo, provider)
    const isStale = Date.now() - cache.lastAttemptAt >= STALE_MS
    if (isStale || numbers.some((number) => !cache.trackedPrNumbers.includes(number))) {
      await refreshCache(cache, numbers)
    }
    return {
      repo: cache.repo,
      checks: prIndex.checksFor(cache.repo, cache.trackedPrNumbers),
      loadFailed: cache.loadFailed,
    } satisfies PrChecksSnapshot
  })
}

function repoKey(repo: RepoRef): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`
}
