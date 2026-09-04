import type { PrChecksSnapshot } from '@solus/contracts/checks-rpc-types'
import { createLogger } from '../../logger'
import type { HostEventPublisher } from '../../events/host-event-publisher'
import type { Provider, RepoRef } from '../../providers/types'
import { reviewTargetFor } from './provider-handlers'
import { prIndex } from '../../prs/pr-index'
import type { HandlerCtx, SolusServer } from '../server'

const log = createLogger('main', 'checks-handlers')
const ACTIVE_IN_FLIGHT_MS = 10_000
const ACTIVE_TERMINAL_MS = 30_000

/**
 * How often to look, and what was learned last time — not where the check runs
 * are kept. Those live on each `PullRequest` in `PrIndex`, because a pull
 * request's checks are a fact about that pull request. What stays here is the
 * scheduling: which repository is being watched, when it was last polled, and
 * which pull requests the poll should cover.
 */
interface RepoChecksCache {
  repo: RepoRef
  provider: Provider
  loadFailed: boolean
  lastAttemptAt: number
  trackedPrNumbers: number[]
  refresh?: Promise<void>
}

export interface ClientChecksActivity {
  repoKey: string
  reviewSurfaceOpen: boolean
  active: boolean
}

export interface RemovedChecksClientActivity {
  removed: boolean
  activeRepoKey: string | null
}

export interface ChecksHandlerStats {
  connectedClients: number
  activities: number
  activeRepoKey: string | null
}

export function removeChecksClientActivity(
  activities: Map<string, ClientChecksActivity>,
  clientId: string,
  activeRepoKey: string | null,
): RemovedChecksClientActivity {
  if (!activities.delete(clientId)) return { removed: false, activeRepoKey }

  let fallbackRepoKey: string | null = null
  let preferredRepoIsActive = false
  for (const activity of activities.values()) {
    if (!activity.active) continue
    fallbackRepoKey = activity.repoKey
    if (activity.repoKey === activeRepoKey) preferredRepoIsActive = true
  }
  return {
    removed: true,
    activeRepoKey: preferredRepoIsActive ? activeRepoKey : fallbackRepoKey,
  }
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
  events: HostEventPublisher
  resolveReviewTarget?: typeof reviewTargetFor
}

export interface ChecksHandlersLifecycle {
  handleClientConnected(clientId: string): void
  handleClientDisconnected(clientId: string): void
  handleTransportClosed(): void
  stats(): ChecksHandlerStats
}

export function registerChecksHandlers(
  server: SolusServer,
  deps: ChecksHandlersDeps,
): ChecksHandlersLifecycle {
  const resolveReviewTarget = deps.resolveReviewTarget ?? reviewTargetFor
  const activities = new Map<string, ClientChecksActivity>()
  const connectedClientTokens = new Map<string, object>()
  const publishedRefreshes = new Map<string, Promise<void>>()
  let activeRepoKey: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const snapshot = (cache: RepoChecksCache): PrChecksSnapshot => ({
    repo: cache.repo,
    checks: prIndex.checksFor(cache.repo, cache.trackedPrNumbers),
    loadFailed: cache.loadFailed,
  })

  const intervalFor = (repoKey: string): number | null => {
    const activeClients = [...activities.values()].filter((activity) =>
      activity.repoKey === repoKey && activity.active,
    )
    if (activeClients.length === 0) return null
    // A direct load keeps the cached answer current when a PR surface opens.
    // Away from those surfaces there is nothing visible to update, so polling
    // would only spend GitHub rate limit on hidden state.
    if (!activeClients.some((activity) => activity.reviewSurfaceOpen)) return null
    const watched = caches.get(repoKey)
    const anyInFlight = watched
      ? prIndex.checksFor(watched.repo, watched.trackedPrNumbers).some(({ summary }) => summary.inFlight)
      : false
    return anyInFlight ? ACTIVE_IN_FLIGHT_MS : ACTIVE_TERMINAL_MS
  }

  const schedule = (repoKey: string): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (activeRepoKey !== repoKey) return
    const interval = intervalFor(repoKey)
    if (interval === null) return
    const cache = caches.get(repoKey)
    const elapsed = cache ? Date.now() - cache.lastAttemptAt : interval
    timer = setTimeout(() => void refresh(repoKey), Math.max(0, interval - elapsed))
    timer.unref()
  }

  const refresh = (key: string): Promise<void> => {
    const existing = publishedRefreshes.get(key)
    if (existing) return existing
    const run = (async () => {
      const cache = caches.get(key)
      if (!cache) return
      await refreshCache(cache)
      const recipientClientIds = [...activities]
        .filter(([, activity]) => activity.repoKey === key)
        .map(([clientId]) => clientId)
      deps.events.publish(recipientClientIds, 'pr.checksChanged', snapshot(cache))
      schedule(key)
    })()
    publishedRefreshes.set(key, run)
    return run.finally(() => {
      if (publishedRefreshes.get(key) === run) publishedRefreshes.delete(key)
    })
  }

  server.register('prChecks', async (args) => {
    const [ctx, numbers = []] = args
    const { repo, provider } = await resolveReviewTarget(ctx)
    const key = repoKey(repo)
    const cache = ensureCache(repo, provider)
    activeRepoKey = key
    if (cache.lastAttemptAt === 0 || numbers.some((number) => !cache.trackedPrNumbers.includes(number))) {
      await refreshCache(cache, numbers)
    } else if (Date.now() - cache.lastAttemptAt >= ACTIVE_TERMINAL_MS) void refresh(key)
    schedule(key)
    return snapshot(cache)
  })

  server.register('prChecksActivity', async (args, request) => {
    const [ctx, reviewSurfaceOpen, active] = args
    const clientId = clientKey(request)
    const connectionToken = connectedClientTokens.get(clientId)
    if (!connectionToken) return
    const { repo, provider } = await resolveReviewTarget(ctx)
    // The lookup can cross process/network boundaries. A disconnect or a fresh
    // connection with the same client id makes the old result stale.
    if (connectedClientTokens.get(clientId) !== connectionToken) return
    const key = repoKey(repo)
    const cache = ensureCache(repo, provider)
    activities.set(clientId, { repoKey: key, reviewSurfaceOpen, active })
    if (active) activeRepoKey = key
    if (activeRepoKey === key) {
      const interval = intervalFor(key)
      if (interval !== null && Date.now() - cache.lastAttemptAt >= interval) void refresh(key)
      else schedule(key)
    }
  })

  return {
    handleClientConnected(clientId: string): void {
      connectedClientTokens.set(clientId, {})
    },
    handleClientDisconnected(clientId: string): void {
      connectedClientTokens.delete(clientId)
      const result = removeChecksClientActivity(activities, clientId, activeRepoKey)
      if (!result.removed) return
      activeRepoKey = result.activeRepoKey
      if (timer) clearTimeout(timer)
      timer = null
      if (activeRepoKey) schedule(activeRepoKey)
    },
    handleTransportClosed(): void {
      connectedClientTokens.clear()
      activities.clear()
      activeRepoKey = null
      if (timer) clearTimeout(timer)
      timer = null
    },
    stats(): ChecksHandlerStats {
      return {
        connectedClients: connectedClientTokens.size,
        activities: activities.size,
        activeRepoKey,
      }
    },
  }
}

function repoKey(repo: RepoRef): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`
}

function clientKey(ctx: HandlerCtx): string {
  return ctx.clientId ?? ctx.deviceId ?? 'local'
}
