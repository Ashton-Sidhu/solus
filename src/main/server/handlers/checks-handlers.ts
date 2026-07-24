import type { PrChecksSnapshot } from '../../../shared/checks-rpc-types'
import type { PrChecksSummary } from '../../../shared/checks-types'
import type { IpcContext } from '../../../shared/types'
import { createLogger } from '../../logger'
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

interface ClientActivity {
  repoKey: string
  reviewSurfaceOpen: boolean
  active: boolean
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
      log.warn(`checks poll failed for ${key}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      cache.lastAttemptAt = Date.now()
      cache.refresh = undefined
    }
  })()
  return cache.refresh
}

export function registerChecksHandlers(server: SolusServer): void {
  const activities = new Map<string, ClientActivity>()
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

  const refresh = async (key: string): Promise<void> => {
    const cache = caches.get(key)
    if (!cache) return
    await refreshCache(cache)
    server.broadcast('pr-checks-update', snapshot(cache))
    schedule(key)
  }

  server.register('prChecks', async (args) => {
    const [ctx, numbers = []] = args as [IpcContext, number[] | undefined]
    const { repo, provider } = await reviewTargetFor(ctx)
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
    const { repo, provider } = await reviewTargetFor(ctx)
    const key = repoKey(repo)
    ensureCache(repo, provider)
    activities.set(clientKey(request), { repoKey: key, reviewSurfaceOpen, active })
    if (active) activeRepoKey = key
    if (activeRepoKey === key) {
      const interval = intervalFor(key)
      const cache = caches.get(key)!
      if (interval !== null && Date.now() - cache.lastAttemptAt >= interval) void refresh(key)
      else schedule(key)
    }
  })
}

function repoKey(repo: RepoRef): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`
}

function clientKey(ctx: HandlerCtx): string {
  return ctx.clientId ?? ctx.deviceId ?? 'local'
}
