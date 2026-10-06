import type { AgentUsageLimits } from '@solus/contracts/types'
import type { Seat } from '@solus/contracts/seats'
import type { SessionRuntime } from '../../execution/session-runtime'
import { createLogger } from '../../logger'
import { isSeatProvider, seatKey, type SeatStore, type TurnSeat } from '../../execution/seats/seat-manager'
import { seatFor } from '../../admission/actor'
import type { SolusServer } from '../server'
import type { HostEventPublisher } from '../events/host-event-publisher'

const log = createLogger('main', 'usage-handlers')

/** How often to re-read quota while a renderer is watching. */
const REFRESH_MS = 5 * 60_000
/** A Claude read costs a subprocess, so polling is only worth it while someone
 *  is actually looking. After this long without a request for a seat its reads
 *  stop; the next `usageLimits` call starts them again. */
const IDLE_TIMEOUT_MS = 15 * 60_000

export interface UsageHandlerDeps {
  sessionRuntime: SessionRuntime
  events: HostEventPublisher
  /** Provider seats (docs/plans/provider-seats.md §3.5): every caller's quota is their own seat's. */
  seats?: SeatStore
  /** The clients a seat's numbers go to; without it every snapshot is broadcast. */
  clientsForSeat?: (seat: Seat) => string[]
}

interface SeatRead {
  seat: Seat
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
  const store = deps.sessionRuntime.usageLimits
  /** By `seatKey`. */
  const reads = new Map<string, SeatRead>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const publish = (seat: Seat, snapshots: AgentUsageLimits[]): void => {
    if (deps.clientsForSeat) deps.events.publish(deps.clientsForSeat(seat), 'usage.limitsChanged', { snapshots })
    else deps.events.broadcast('usage.limitsChanged', { snapshots })
  }

  /** The seat to read for one provider: `null` means nothing to read, `undefined` the host's own login. */
  const turnSeatFor = async (seat: Seat, agentId: Parameters<SessionRuntime['history']['readUsageLimits']>[0]): Promise<TurnSeat | null | undefined> => {
    const isHostLogin = seat.kind === 'host-login'
    if (!deps.seats || !isSeatProvider(agentId)) return isHostLogin ? undefined : null
    const turnSeat = deps.seats.connectedSeat(seat, agentId)
    if (!turnSeat) return isHostLogin ? undefined : null
    // The host login is always usage-capable; its `status()` would only run the
    // login probe to label it connected or not, which the meter has no use for.
    if (isHostLogin) return turnSeat
    return (await deps.seats.status(seat, agentId)).usageCapable ? turnSeat : null
  }

  const readSeat = (seat: Seat): Promise<AgentUsageLimits[]> => {
    const isHostLogin = seat.kind === 'host-login'
    const key = seatKey(seat)
    const cached = reads.get(key)
    if (cached?.pending) return cached.pending
    const pending = Promise.all(deps.sessionRuntime.history.usageCapableAgents().map(async (agentId): Promise<AgentUsageLimits | null> => {
      const turnSeat = await turnSeatFor(seat, agentId)
      if (turnSeat === null) return null
      try {
        const limits = await deps.sessionRuntime.history.readUsageLimits(agentId, turnSeat)
        if (isHostLogin) {
          if (limits) store.apply(limits)
          else store.markStale(agentId, 'no_report')
        }
        if (limits) {
          log.info('usage_refreshed', { agentId, seat: key, fiveHourPercent: limits.fiveHour?.usedPercent ?? null, weeklyPercent: limits.weekly?.usedPercent ?? null })
        }
        return limits
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        if (isHostLogin) store.markStale(agentId, reason)
        else log.warn('seat_usage_refresh_failed', { agentId, seat: key, error: reason })
        return { provider: agentId, fiveHour: null, weekly: null, planType: null, fetchedAt: 0, stale: true }
      }
    })).then((results) => {
      // The host login answers from the store, which the provider streams also feed.
      const snapshots = isHostLogin ? store.snapshot() : results.filter((limits): limits is AgentUsageLimits => limits !== null)
      reads.set(key, { seat, at: Date.now(), lastRequestAt: reads.get(key)?.lastRequestAt ?? Date.now(), snapshots, pending: null })
      publish(seat, snapshots)
      return snapshots
    })
    reads.set(key, { seat, at: cached?.at ?? 0, lastRequestAt: cached?.lastRequestAt ?? Date.now(), snapshots: cached?.snapshots ?? [], pending })
    void pending.catch((err) => {
      log.warn('usage_refresh_failed', { seat: key, error: err instanceof Error ? err.message : String(err) })
      reads.delete(key)
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
    const key = seatKey(event.seat)
    if (!reads.has(key)) return
    if (event.state === 'connecting') return
    reads.delete(key)
    void readSeat(event.seat).catch(() => [])
  })

  /** Re-reads every seat somebody asked about recently; stops when nobody is looking. */
  const tick = async (): Promise<void> => {
    timer = null
    const now = Date.now()
    const watched = [...reads.values()].filter((read) => now - read.lastRequestAt <= IDLE_TIMEOUT_MS)
    if (watched.length === 0) {
      log.info('usage_poll_suspended')
      return
    }
    await Promise.all(watched.map((read) => readSeat(read.seat).catch(() => [])))
    schedule()
  }

  server.register('usageLimits', async (_args, ctx) => {
    const seat = seatFor(ctx.actor)
    const cached = reads.get(seatKey(seat))
    if (cached) cached.lastRequestAt = Date.now()
    const current = seat.kind === 'host-login' ? store.snapshot() : cached?.snapshots ?? []
    if (!cached || Date.now() - cached.at >= REFRESH_MS) {
      const pending = readSeat(seat).catch(() => current)
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
