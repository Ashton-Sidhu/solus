import { availableParallelism, loadavg } from 'node:os'
import type { HostEventLoopStall } from '@solus/contracts/host-api'
import { createLogger, isDebugEnabled } from '../logger'

const log = createLogger('main', 'event-loop-stalls.ts')

/** Long enough that a person felt it. Shorter stalls go to the log only. */
const NOTICEABLE_STALL_MS = 5_000
/** A client shows what it gets, so an old stall must not explain a new drop. */
const NOTICEABLE_STALL_MAX_AGE_MS = 5 * 60_000

export interface StallMonitorOptions {
  /** The timer interval. The monitor measures how late each tick is. */
  tickMs: number
  /** A stall this long or longer goes to the log as `event_loop_stalled`. */
  logAtMs: number
  /** A monotonic clock in ms. It must not count time the machine sleeps,
   *  or a laptop that wakes reports its sleep as a stall. */
  monotonicNow: () => number
  /** The wall clock in ms: the stall's `endedAt`. */
  wallNow: () => number
  machineLoad: () => { loadAverage?: number; cpuCount: number }
}

/**
 * Finds stalls of this host's event loop from how late a coarse timer fires.
 * A stall over the Socket.IO ping timeout drops every client, and a client
 * cannot tell that from a network drop. The monitor keeps the last stall of
 * 5 s or more, so the host can say why when the client comes back.
 */
export class EventLoopStallMonitor {
  private lastCheckAt: number
  private noticeable: { stall: HostEventLoopStall; seenAt: number } | null = null

  constructor(private readonly options: StallMonitorOptions) {
    this.lastCheckAt = options.monotonicNow()
  }

  /** Measure the time since the last check. The timer calls it on each tick;
   *  a read calls it too, so a stall that ended just before a client
   *  reconnected is included. */
  check(): void {
    const now = this.options.monotonicNow()
    const stalledMs = Math.round(now - this.lastCheckAt - this.options.tickMs)
    this.lastCheckAt = now
    if (stalledMs < this.options.logAtMs) return
    const load = this.options.machineLoad()
    log.warn('event_loop_stalled', { stalledMs, ...load })
    if (stalledMs < NOTICEABLE_STALL_MS) return
    const stall: HostEventLoopStall = { endedAt: this.options.wallNow(), durationMs: stalledMs, cpuCount: load.cpuCount }
    if (load.loadAverage !== undefined) stall.loadAverage = Math.round(load.loadAverage * 10) / 10
    this.noticeable = { stall, seenAt: now }
  }

  /** The last stall of 5 s or more, when it was seen in the last 5 minutes. */
  recentStall(): HostEventLoopStall | undefined {
    this.check()
    if (!this.noticeable) return undefined
    return this.options.monotonicNow() - this.noticeable.seenAt <= NOTICEABLE_STALL_MAX_AGE_MS ? this.noticeable.stall : undefined
  }
}

let current: EventLoopStallMonitor | null = null

export function useEventLoopStallMonitor(monitor: EventLoopStallMonitor | null): void {
  current = monitor
}

/** The host's recent stall for a client, or undefined when there is none or no monitor runs. */
export function recentEventLoopStall(): HostEventLoopStall | undefined {
  return current?.recentStall()
}

/**
 * Always on: one timer per second costs nearly nothing. A debug build ticks
 * every 50 ms and logs each gap of 100 ms or more, so a short stall lines up in
 * `dev.log` against the RPC that came before it.
 */
export function watchEventLoopStalls(): void {
  if (current) return
  const debug = isDebugEnabled()
  const monitor = new EventLoopStallMonitor({
    tickMs: debug ? 50 : 1_000,
    logAtMs: debug ? 100 : 2_000,
    // Node's high-resolution clock does not count sleep on macOS or Linux.
    monotonicNow: () => performance.now(),
    wallNow: Date.now,
    machineLoad: () => {
      // Windows has no load average and reports 0, which a running machine never shows elsewhere.
      const loadAverage = loadavg()[0] || undefined
      return loadAverage === undefined ? { cpuCount: availableParallelism() } : { loadAverage, cpuCount: availableParallelism() }
    },
  })
  useEventLoopStallMonitor(monitor)
  setInterval(() => monitor.check(), debug ? 50 : 1_000).unref()
}
