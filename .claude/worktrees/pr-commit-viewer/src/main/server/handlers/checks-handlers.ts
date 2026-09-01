import type { PrChecksSnapshot } from '../../../shared/checks-rpc-types'
import type { PrChecksSummary } from '../../../shared/checks-types'
import type { IpcContext } from '../../../shared/types'
import { createLogger } from '../../logger'
import type { HostEventPublisher } from '../../events/host-event-publisher'
import type { Provider, RepoRef } from '../../providers/types'
import { reviewTargetFor } from './provider-handlers'
import type { HandlerCtx, SolusServer } from '../server'

const log = createLogger('main', 'checks-handlers')
const ACTIVE_IN_FLIGHT_MS = 10_000
const ACTIVE_TERMINAL_MS = 30_000
const BACKGROUND_MS = 60_000

interface RepoChecksCache {
  repo: RepoRef
  provider: Provider
  checks: PrChecksSnapshot['checks']
  loadFailed: boolean
  lastAttemptAt: number
  openPrNumbers: number[]
  headShas: Map<number, string>
  openPrNumbersAt: number
  refresh?: Promise<void>
}

export interface ClientChecksActivity {
  repoKey: string
  reviewSurfaceOpen: boolean
  active: boolean
}

export function removeChecksClientActivity(
  activities: Map<string, ClientChecksActivity>,
  clientId: string,
  activeRepoKey: string | null,
): { removed: boolean; activeRepoKey: string | null } {
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
      checks: [],
      loadFailed: false,
      lastAttemptAt: 0,
      openPrNumbers: [],
      headShas: new Map(),
      openPrNumbersAt: 0,
    }
    caches.set(key, cache)
  }
  return cache
}

async function refreshCache(
  cache: RepoChecksCache,
  forcePullRequests = false,
  requestedNumbers: number[] = [],
): Promise<void> {
  if (cache.refresh) {
    await cache.refresh
    // A renderer refresh may have won the race without re-reading PR heads.
    // Queue gating asked for a forced head check, so honor it after that work.
    if (forcePullRequests) return refreshCache(cache, true)
    return
  }
  const key = repoKey(cache.repo)
  cache.refresh = (async () => {
    try {
      if (requestedNumbers.length > 0 && !forcePullRequests) {
        cache.openPrNumbers = [...new Set([...cache.openPrNumbers, ...requestedNumbers])]
        cache.openPrNumbersAt = Date.now()
      } else if (forcePullRequests || cache.openPrNumbers.length === 0) {
        const pullRequests = await cache.provider.review.listPullRequests(cache.repo, { state: 'open' })
        cache.openPrNumbers = pullRequests.map((pullRequest) => pullRequest.number)
        cache.headShas = new Map(pullRequests.map((pullRequest) => [pullRequest.number, pullRequest.headSha]))
        cache.openPrNumbersAt = Date.now()
      }
      cache.checks = await cache.provider.review.listChecks(cache.repo, cache.openPrNumbers)
      cache.headShas = new Map(cache.checks.map((check) => [check.number, check.summary.headSha]))
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
  stats(): { connectedClients: number; activities: number; activeRepoKey: string | null }
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
    checks: cache.checks,
    loadFailed: cache.loadFailed,
  })

  const intervalFor = (repoKey: string): number | null => {
    const activeClients = [...activities.values()].filter((activity) =>
      activity.repoKey === repoKey && activity.active,
    )
    if (activeClients.length === 0) return null
    if (!activeClients.some((activity) => activity.reviewSurfaceOpen)) return BACKGROUND_MS
    const anyInFlight = caches.get(repoKey)?.checks.some(({ summary }) => summary.inFlight) ?? false
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
    ;(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
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
    const [ctx, numbers = []] = args as [IpcContext, number[] | undefined]
    const { repo, provider } = await resolveReviewTarget(ctx)
    const key = repoKey(repo)
    const cache = ensureCache(repo, provider)
    activeRepoKey = key
    if (cache.lastAttemptAt === 0 || numbers.some((number) => !cache.openPrNumbers.includes(number))) {
      await refreshCache(cache, false, numbers)
    } else if (Date.now() - cache.lastAttemptAt >= ACTIVE_TERMINAL_MS) void refresh(key)
    schedule(key)
    return snapshot(cache)
  })

  server.register('prChecksActivity', async (args, request) => {
    const [ctx, reviewSurfaceOpen, active] = args as [IpcContext, boolean, boolean]
    const clientId = clientKey(request)
    const connectionToken = connectedClientTokens.get(clientId)
    if (!connectionToken) return
    const { repo, provider } = await resolveReviewTarget(ctx)
    // The lookup can cross process/network boundaries. A disconnect or a fresh
    // connection with the same client id makes the old result stale.
    if (connectedClientTokens.get(clientId) !== connectionToken) return
    const key = repoKey(repo)
    ensureCache(repo, provider)
    activities.set(clientId, { repoKey: key, reviewSurfaceOpen, active })
    if (active) activeRepoKey = key
    if (activeRepoKey === key) {
      const interval = intervalFor(key)
      const cache = caches.get(key)!
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
    stats(): { connectedClients: number; activities: number; activeRepoKey: string | null } {
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
