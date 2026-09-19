import type { AgentUsageLimits } from '@solus/contracts/types'
import { HOST_OWNER_USER_ID } from '@solus/contracts/sharing'
import type { ControlPlane } from '../../control-plane'
import { createLogger } from '../../logger'
import { isSeatProvider, seatUserFor, type SeatManager, type TurnSeat } from '../../seats/seat-manager'
import type { SolusServer } from '../server'
import type { HostEventPublisher } from '../../events/host-event-publisher'

const log = createLogger('main', 'usage-handlers')

/** How often to re-read quota while a renderer is watching. */
const REFRESH_MS = 5 * 60_000
/** A Claude read costs a subprocess, so polling is only worth it while someone
 *  is actually looking. After this long without a request for a seat its reads
 *  stop; the next `usageLimits` call starts them again. */
const IDLE_TIMEOUT_MS = 15 * 60_000

export interface UsageHandlerDeps {
  controlPlane: ControlPlane
  events: HostEventPublisher
  /** Provider seats (docs/plans/provider-seats.md §3.5): every caller's quota is their own seat's. */
  seats?: SeatManager
  /** The clients a seat's numbers go to; without it every snapshot is broadcast. */
  clientsForSeatUser?: (seatUserId: string) => string[]
}

interface SeatRead {
  at: number
  lastRequestAt: number
  snapshots: AgentUsageLimits[]
  pending: Promise<AgentUsageLimits[]> | null
}

/**
 * Quota per seat. The host login is the owner's seat; its numbers also feed the
 * control plane's usage store, which the rate-limit logic reads for reset times.
 * A member's seat is read on its own login and published to that member's clients
 * only, so one person's limit never shows on, or blocks, another's meter.
 */
export function registerUsageHandlers(server: SolusServer, deps: UsageHandlerDeps): void {
  const store = deps.controlPlane.usageLimits
  const reads = new Map<string, SeatRead>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const publish = (seatUserId: string, snapshots: AgentUsageLimits[]): void => {
    if (deps.clientsForSeatUser) deps.events.publish(deps.clientsForSeatUser(seatUserId), 'usage.limitsChanged', { snapshots })
    else deps.events.broadcast('usage.limitsChanged', { snapshots })
  }

  /** The seat to read for one provider: `null` means nothing to read, `undefined` the host's own login. */
  const seatFor = async (seatUserId: string, agentId: Parameters<ControlPlane['readUsageLimits']>[0]): Promise<TurnSeat | null | undefined> => {
    const isHostLogin = seatUserId === HOST_OWNER_USER_ID
    if (!deps.seats || !isSeatProvider(agentId)) return isHostLogin ? undefined : null
    const seat = deps.seats.connectedSeat(seatUserId, agentId)
    if (!seat) return isHostLogin ? undefined : null
    // The host login is always usage-capable; its `status()` would only run the
    // login probe to label it connected or not, which the meter has no use for.
    if (seat.isHostLogin) return seat
    return (await deps.seats.status(seatUserId, agentId)).usageCapable ? seat : null
  }

  const readSeat = (seatUserId: string): Promise<AgentUsageLimits[]> => {
    const isHostLogin = seatUserId === HOST_OWNER_USER_ID
    const cached = reads.get(seatUserId)
    if (cached?.pending) return cached.pending
    const pending = Promise.all(deps.controlPlane.usageCapableAgents().map(async (agentId): Promise<AgentUsageLimits | null> => {
      const seat = await seatFor(seatUserId, agentId)
      if (seat === null) return null
      try {
        const limits = await deps.controlPlane.readUsageLimits(agentId, seat)
        if (isHostLogin) {
          if (limits) store.apply(limits)
          else store.markStale(agentId, 'no_report')
        }
        if (limits) {
          log.info('usage_refreshed', { agentId, seatUserId, fiveHourPercent: limits.fiveHour?.usedPercent ?? null, weeklyPercent: limits.weekly?.usedPercent ?? null })
        }
        return limits
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        if (isHostLogin) store.markStale(agentId, reason)
        else log.warn('seat_usage_refresh_failed', { agentId, seatUserId, error: reason })
        return { provider: agentId, fiveHour: null, weekly: null, planType: null, fetchedAt: 0, stale: true }
      }
    })).then((results) => {
      // The host login answers from the store, which the provider streams also feed.
      const snapshots = isHostLogin ? store.snapshot() : results.filter((limits): limits is AgentUsageLimits => limits !== null)
      reads.set(seatUserId, { at: Date.now(), lastRequestAt: reads.get(seatUserId)?.lastRequestAt ?? Date.now(), snapshots, pending: null })
      publish(seatUserId, snapshots)
      return snapshots
    })
    reads.set(seatUserId, { at: cached?.at ?? 0, lastRequestAt: cached?.lastRequestAt ?? Date.now(), snapshots: cached?.snapshots ?? [], pending })
    void pending.catch((err) => {
      log.warn('usage_refresh_failed', { seatUserId, error: err instanceof Error ? err.message : String(err) })
      reads.delete(seatUserId)
    })
    return pending
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void tick(), REFRESH_MS)
    timer.unref()
  }

  // A seat that connects, disconnects, or expires changes what its quota is: a
  // member who asked before connecting must not wait out the cache to see it.
  deps.seats?.onChanged((event) => {
    if (!reads.has(event.userId)) return
    if (event.state === 'connecting') return
    reads.delete(event.userId)
    void readSeat(event.userId).catch(() => [])
  })

  /** Re-reads every seat somebody asked about recently; stops when nobody is looking. */
  const tick = async (): Promise<void> => {
    timer = null
    const now = Date.now()
    const watched = [...reads.entries()].filter(([, read]) => now - read.lastRequestAt <= IDLE_TIMEOUT_MS)
    if (watched.length === 0) {
      log.info('usage_poll_suspended')
      return
    }
    await Promise.all(watched.map(([seatUserId]) => readSeat(seatUserId).catch(() => [])))
    schedule()
  }

  server.register('usageLimits', async (_args, ctx) => {
    const seatUserId = seatUserFor(ctx.principal)
    const cached = reads.get(seatUserId)
    if (cached) cached.lastRequestAt = Date.now()
    const current = seatUserId === HOST_OWNER_USER_ID ? store.snapshot() : cached?.snapshots ?? []
    if (!cached || Date.now() - cached.at >= REFRESH_MS) {
      const pending = readSeat(seatUserId).catch(() => current)
      // Nothing cached yet means the caller would otherwise get an empty array
      // on the very first ask; after that, refresh behind the publish.
      if (current.length === 0) {
        schedule()
        return pending
      }
    }
    schedule()
    return current
  })
}
