import type { AgentId, AgentUsageLimits } from '../../../shared/types'
import type { ControlPlane } from '../../control-plane'
import { createLogger } from '../../logger'
import type { SolusServer } from '../server'
import type { HostEventPublisher } from '../../events/host-event-publisher'

const log = createLogger('main', 'usage-handlers')

/** How often to re-read quota while a renderer is watching. */
const REFRESH_MS = 5 * 60_000
/** A Claude read costs a subprocess, so polling is only worth it while someone
 *  is actually looking. After this long without a request the timer stops; the
 *  next `usageLimits` call starts it again. */
const IDLE_TIMEOUT_MS = 15 * 60_000

export function registerUsageHandlers(server: SolusServer, deps: { controlPlane: ControlPlane; events: HostEventPublisher }): void {
  const cache = new Map<AgentId, AgentUsageLimits>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let refresh: Promise<void> | null = null
  let refreshBroadcast: Promise<void> | null = null
  let lastAttemptAt = 0
  let lastRequestAt = 0

  const snapshot = (): AgentUsageLimits[] => [...cache.values()]

  // Keep the last-good numbers and say they're old. Dropping them would leave a
  // watching UI blank on a single transient failure.
  const markStale = (agentId: AgentId, reason: string): void => {
    log.warn('usage_refresh_failed', { agentId, reason })
    const cached = cache.get(agentId)
    if (cached) cached.stale = true
  }

  const refreshAll = (): Promise<void> => {
    if (refresh) return refresh
    const run = Promise.all(deps.controlPlane.usageCapableAgents().map(async (agentId) => {
      try {
        const limits = await deps.controlPlane.readUsageLimits(agentId)
        if (!limits) return markStale(agentId, 'no_report')
        cache.set(agentId, limits)
        log.info('usage_refreshed', {
          agentId,
          fiveHourPercent: limits.fiveHour?.usedPercent ?? null,
          weeklyPercent: limits.weekly?.usedPercent ?? null,
        })
      } catch (err) {
        markStale(agentId, err instanceof Error ? err.message : String(err))
      }
    })).then(() => { lastAttemptAt = Date.now() })
    refresh = run.finally(() => { refresh = null })
    return refresh
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void tick(), REFRESH_MS)
    ;(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
  }

  const refreshAndBroadcast = (): Promise<void> => {
    if (refreshBroadcast) return refreshBroadcast
    const run = refreshAll().then(() => {
      deps.events.broadcast('usage.limitsChanged', { snapshots: snapshot() })
    })
    refreshBroadcast = run.finally(() => { refreshBroadcast = null })
    return refreshBroadcast
  }

  const tick = async (): Promise<void> => {
    timer = null
    if (Date.now() - lastRequestAt > IDLE_TIMEOUT_MS) {
      log.info('usage_poll_suspended', { lastRequestAt })
      return
    }
    await refreshAndBroadcast()
    schedule()
  }

  server.register('usageLimits', async () => {
    lastRequestAt = Date.now()
    if (Date.now() - lastAttemptAt >= REFRESH_MS) {
      const pending = refreshAndBroadcast()
        .catch((err) => log.warn('usage_broadcast_failed', {
          error: err instanceof Error ? err.message : String(err),
        }))
      // Nothing cached yet means the caller would otherwise get an empty array
      // on the very first ask; after that, refresh behind the broadcast.
      if (cache.size === 0) await pending
    }
    schedule()
    return snapshot()
  })
}
