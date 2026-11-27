import type { AgentUsageLimits } from '@solus/contracts/types'
import type { ProviderInstance } from '@solus/contracts/provider-instances'
import type { Seat } from '@solus/contracts/seats'
import type { SessionRuntime } from '../../execution/session-runtime'
import { createLogger } from '../../logger'
import { isSeatProvider, seatKey, type SeatStore, type TurnSeat } from '../../execution/seats/seat-manager'
import type { ProviderInstances } from '../../execution/seats/provider-instances'
import { instanceRuntime, type ProviderRuntime } from '../../execution/seats/provider-runtime'
import { captureActingScope } from '../../vault/acting-scope'
import { seatFor } from '../../admission/actor'
import type { SolusServer } from '../server'
import type { HostEventPublisher } from '../events/host-event-publisher'

const log = createLogger('main', 'usage-handlers')

/** How often to re-read quota while a renderer is watching. */
const REFRESH_MS = 5 * 60_000
/** A Claude read costs a subprocess, so polling is only worth it while someone
 *  is actually looking: a client that holds a watch (`usageWatch`), or one
 *  that asked within this long. Otherwise a seat's reads stop; the next ask or
 *  watch starts them again. */
const IDLE_TIMEOUT_MS = 15 * 60_000

export interface UsageHandlerDeps {
  sessionRuntime: SessionRuntime
  events: HostEventPublisher
  /** Provider seats (docs/plans/provider-seats.md §3.5): every caller's quota is their own seat's. */
  seats?: SeatStore
  /** Private provider instances for reading quota of extra configured harness accounts. */
  providerInstances?: Pick<ProviderInstances, 'snapshot'>
  /** The clients a seat's numbers go to; without it every snapshot is broadcast. */
  clientsForSeat?: (seat: Seat) => string[]
}

/** The usage watches of connected clients: a disconnect ends a client's watch. */
export interface UsageWatches {
  clientDisconnected(clientId: string): void
  /** Drop cached reads when configured provider instances change so active watchers re-read. */
  providerInstancesChanged(): void
}

interface SeatRead {
  seat: Seat
  at: number
  lastRequestAt: number
  snapshots: AgentUsageLimits[]
  pending: Promise<AgentUsageLimits[]> | null
}

function hasInstanceRuntimeOverrides(instance: ProviderInstance): boolean {
  return Boolean(
    instance.binaryPath ||
    instance.homePath ||
    instance.shadowHomePath ||
    instance.launchArgs.length > 0 ||
    instance.environment.length > 0,
  )
}

/**
 * Quota per seat. The host login is the owner's seat; its numbers also feed the
 * control plane's usage store, which the rate-limit logic reads for reset times.
 * A member's seat is read on its own login and published to that member's clients
 * only, so one person's limit never shows on, or blocks, another's meter.
 */
export function registerUsageHandlers(server: SolusServer, deps: UsageHandlerDeps): UsageWatches {
  const store = deps.sessionRuntime.usageLimits
  /** By `seatKey`. */
  const reads = new Map<string, SeatRead>()
  /** clientId → the `seatKey` its watch keeps read. A watch ends on unwatch or disconnect. */
  const watchers = new Map<string, string>()
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

  const configuredInstances = (): ProviderInstance[] => {
    if (!deps.providerInstances) return []
    const personKey = captureActingScope()?.personKey
    if (!personKey) return []
    try {
      return deps.providerInstances.snapshot(personKey).instances
    } catch {
      return []
    }
  }

  const runtimeForInstance = (seat: Seat, instance: ProviderInstance, turnSeat: TurnSeat | undefined): ProviderRuntime => {
    const seatHome = turnSeat?.home ?? (deps.seats && isSeatProvider(instance.provider) ? deps.seats.homeFor(seat, instance.provider) : undefined)
    const configured = instance.homePath || seat.kind === 'host-login' || !seatHome ? instance : { ...instance, homePath: seatHome }
    return instanceRuntime(configured, turnSeat?.launch, 0, seatHome)
  }

  const readSeat = (seat: Seat): Promise<AgentUsageLimits[]> => {
    const isHostLogin = seat.kind === 'host-login'
    const key = seatKey(seat)
    const cached = reads.get(key)
    if (cached?.pending) return cached.pending
    const entry: SeatRead = { seat, at: cached?.at ?? 0, lastRequestAt: cached?.lastRequestAt ?? Date.now(), snapshots: cached?.snapshots ?? [], pending: null }
    reads.set(key, entry)
    const capableAgents = deps.sessionRuntime.history.usageCapableAgents()
    const instances = configuredInstances()
    const extraInstances = instances.filter(
      (instance) =>
        instance.enabled &&
        instance.id !== instance.provider &&
        (instance.provider === 'claude-code' || instance.provider === 'codex') &&
        capableAgents.includes(instance.provider),
    )

    const recordPrimaryResult = (agentId: Parameters<SessionRuntime['history']['readUsageLimits']>[0], labeled: AgentUsageLimits | null): void => {
      if (isHostLogin) {
        if (labeled) store.apply(labeled)
        else store.markStale(agentId, 'no_report')
      }
      if (labeled) {
        log.info('usage_refreshed', { agentId, seat: key, fiveHourPercent: labeled.fiveHour?.usedPercent ?? null, weeklyPercent: labeled.weekly?.usedPercent ?? null })
      }
    }

    const recordPrimaryFailure = (agentId: Parameters<SessionRuntime['history']['readUsageLimits']>[0], builtIn: ProviderInstance | undefined, reason: string): AgentUsageLimits => {
      if (isHostLogin) store.markStale(agentId, reason)
      else log.warn('seat_usage_refresh_failed', { agentId, seat: key, error: reason })
      const failed: AgentUsageLimits = {
        provider: agentId,
        fiveHour: null,
        weekly: null,
        planType: null,
        fetchedAt: 0,
        stale: true,
      }
      if (builtIn) {
        failed.instanceId = builtIn.id
        failed.instanceLabel = builtIn.displayName
      }
      return failed
    }

    const readPrimaryAgent = async (agentId: Parameters<SessionRuntime['history']['readUsageLimits']>[0]): Promise<AgentUsageLimits | null> => {
      const builtIn = instances.find((instance) => instance.id === agentId)
      if (builtIn && !builtIn.enabled) {
        if (isHostLogin) store.clear(agentId)
        return null
      }
      const turnSeat = await turnSeatFor(seat, agentId)
      if (turnSeat === null) return null
      try {
        const runtime = builtIn && hasInstanceRuntimeOverrides(builtIn)
          ? runtimeForInstance(seat, builtIn, turnSeat)
          : undefined
        const limits = await deps.sessionRuntime.history.readUsageLimits(agentId, turnSeat, runtime)
        if (reads.get(key) !== entry) return null
        const labeled = limits && builtIn?.displayName
          ? { ...limits, instanceId: builtIn.id, instanceLabel: builtIn.displayName }
          : limits
        recordPrimaryResult(agentId, labeled)
        return labeled
      } catch (err) {
        if (reads.get(key) !== entry) return null
        return recordPrimaryFailure(agentId, builtIn, err instanceof Error ? err.message : String(err))
      }
    }

    const primaryTask = Promise.all(capableAgents.map(readPrimaryAgent))

    const extraTask = Promise.all(extraInstances.map(async (instance): Promise<AgentUsageLimits | null> => {
      const turnSeat = await turnSeatFor(seat, instance.provider)
      // Extra instances with their own home can still read even if a member has no default seat.
      if (turnSeat === null && !instance.homePath) return null
      try {
        const runtime = runtimeForInstance(seat, instance, turnSeat ?? undefined)
        const limits = await deps.sessionRuntime.history.readUsageLimits(instance.provider, turnSeat ?? undefined, runtime)
        if (reads.get(key) !== entry) return null
        if (!limits) {
          return {
            provider: instance.provider,
            instanceId: instance.id,
            instanceLabel: instance.displayName,
            fiveHour: null,
            weekly: null,
            planType: null,
            fetchedAt: 0,
            stale: true,
          }
        }
        return {
          ...limits,
          instanceId: instance.id,
          instanceLabel: instance.displayName,
        }
      } catch (err) {
        if (reads.get(key) !== entry) return null
        const reason = err instanceof Error ? err.message : String(err)
        log.warn('instance_usage_refresh_failed', { agentId: instance.provider, instanceId: instance.id, seat: key, error: reason })
        return {
          provider: instance.provider,
          instanceId: instance.id,
          instanceLabel: instance.displayName,
          fiveHour: null,
          weekly: null,
          planType: null,
          fetchedAt: 0,
          stale: true,
        }
      }
    }))

    const pending = Promise.all([primaryTask, extraTask]).then(([primaryResults, extraResults]) => {
      const latest = reads.get(key)
      if (latest !== entry) return latest?.pending ?? (isHostLogin ? store.snapshot() : latest?.snapshots ?? [])
      // The host login answers from the store (which provider streams also feed), plus any extra configured instances.
      const primarySnapshots = isHostLogin
        ? store.snapshot()
        : primaryResults.filter((limits): limits is AgentUsageLimits => limits !== null)
      const extraSnapshots = extraResults.filter((limits): limits is AgentUsageLimits => limits !== null)
      const snapshots = [...primarySnapshots, ...extraSnapshots]
      entry.at = Date.now()
      entry.snapshots = snapshots
      entry.pending = null
      publish(seat, snapshots)
      return snapshots
    })
    entry.pending = pending
    void pending.catch((err) => {
      log.warn('usage_refresh_failed', { seat: key, error: err instanceof Error ? err.message : String(err) })
      if (reads.get(key) === entry) reads.delete(key)
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
    const watchedSeats = new Set(watchers.values())
    const watched = [...reads.entries()]
      .filter(([key, read]) => watchedSeats.has(key) || now - read.lastRequestAt <= IDLE_TIMEOUT_MS)
      .map(([, read]) => read)
    if (watched.length === 0) {
      log.info('usage_poll_suspended')
      return
    }
    await Promise.all(watched.map((read) => readSeat(read.seat).catch(() => [])))
    schedule()
  }

  const answer = async (seat: Seat, force = false): Promise<AgentUsageLimits[]> => {
    const cached = reads.get(seatKey(seat))
    if (cached) cached.lastRequestAt = Date.now()
    const current = cached?.snapshots.length
      ? cached.snapshots
      : seat.kind === 'host-login' ? store.snapshot() : []
    if (force) {
      schedule()
      return readSeat(seat).catch(() => current)
    }
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
  }

  server.register('usageLimits', async (args, ctx) => answer(seatFor(ctx.actor), args[0]?.force === true))
  server.register('usageWatch', async (_args, ctx) => {
    if (!ctx.clientId) throw new Error('A usage watch requires a connected client')
    const seat = seatFor(ctx.actor)
    watchers.set(ctx.clientId, seatKey(seat))
    return answer(seat)
  })
  server.register('usageUnwatch', async (_args, ctx) => {
    if (ctx.clientId) watchers.delete(ctx.clientId)
  })
  return {
    clientDisconnected: (clientId) => { watchers.delete(clientId) },
    providerInstancesChanged: () => {
      const watchedSeats = new Set(watchers.values())
      const activeReads = [...reads.entries()]
      reads.clear()
      for (const [key, read] of activeReads) {
        if (watchedSeats.has(key)) void readSeat(read.seat).catch(() => [])
      }
    },
  }
}
