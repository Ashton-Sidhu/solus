import { createLogger } from '../logger'
import type { Watch, WatchProbe, WatchProbeResult, WatchStatus } from '@solus/contracts/watch-types'
import {
  deleteEndedWatchesBefore,
  dueWatches,
  listWatchesWithStatus,
  loadWatch,
  saveWatch,
} from './watches-store'
import {
  fingerprintOf,
  isProbeError,
  MAX_CONSECUTIVE_PROBE_ERRORS,
  nextRunAfter,
  untilMatches,
  wakeDisplayText,
  wakePrompt,
} from './watch-rules'
import { runProbe as runProbeOnHost } from './watch-probe'

const log = createLogger('watches', 'watch-service.ts')

const TICK_MS = 5_000
const MAX_CONCURRENT_PROBES = 4
const ENDED_RETENTION_MS = 7 * 86_400_000
const PRUNE_EVERY_MS = 3_600_000

export interface WatchWake {
  sessionId: string
  watchId: string
  prompt: string
  displayPrompt: string
}

/** Sends a wake into its session. Resolves when the turn is accepted, with a
 *  promise that settles when that turn ends. Throws when the session cannot be
 *  woken, for example because it no longer exists. */
export type WakeDispatcher = (wake: WatchWake) => Promise<{ done: Promise<unknown> }>

export interface WatchServiceDeps {
  dispatchWake: WakeDispatcher
  runProbe?: (probe: WatchProbe, cwd: string) => Promise<WatchProbeResult>
  now?: () => Date
}

/** How a watch ends after its current wake, or null when it waits again. */
export function endAfterWake(watch: Watch): { status: WatchStatus; reason: string } | null {
  if (watch.consecutiveProbeErrors >= MAX_CONSECUTIVE_PROBE_ERRORS) {
    return { status: 'failed', reason: `The probe failed ${watch.consecutiveProbeErrors} times in a row.` }
  }
  if (!watch.repeat) return { status: 'done', reason: watch.probe ? 'The condition was met.' : 'The timer fired.' }
  if (watch.wakeCount >= watch.maxWakes) return { status: 'exhausted', reason: `Used all ${watch.maxWakes} wakes.` }
  return null
}

function end(watch: Watch, status: WatchStatus, reason: string): void {
  watch.status = status
  watch.endReason = reason
  delete watch.nextRunAt
  saveWatch(watch)
  log.info('watch_ended', { watchId: watch.id, sessionId: watch.sessionId, status, reason })
}

/**
 * Runs the host side of every watch: probes on schedule, decides when a wait
 * ends, wakes the session, and re-arms or ends the watch when the woken turn
 * finishes (docs/plans/watches.md §5).
 *
 * State lives in SQLite. The only memory this keeps is which watches have a
 * probe in flight, so a restart loses nothing: a watch left `woken` by the
 * previous process is settled on start as if its turn had ended.
 */
export class WatchService {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly probing = new Set<string>()
  private ticking = false
  private paused = false
  private lastPruneAt = 0
  private readonly runProbe: (probe: WatchProbe, cwd: string) => Promise<WatchProbeResult>
  private readonly now: () => Date

  constructor(private readonly deps: WatchServiceDeps) {
    this.runProbe = deps.runProbe ?? runProbeOnHost
    this.now = deps.now ?? (() => new Date())
  }

  start(): void {
    if (this.timer) return
    // The previous process's woken turns ended with it.
    for (const watch of listWatchesWithStatus(['woken'])) this.afterWake(watch.id)
    void this.tick()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    log.info('watch_service_started')
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** While the host waits to update, no probe starts and nothing is woken. */
  setPaused(paused: boolean): void {
    this.paused = paused
  }

  hasWork(): boolean {
    return this.probing.size > 0
  }

  /** One pass: expire, prune, and start the due probes. Exposed for tests;
   *  resolves when every probe it started has been handled. */
  async tick(): Promise<void> {
    if (this.ticking || this.paused) return
    this.ticking = true
    try {
      const now = this.now()
      for (const watch of listWatchesWithStatus(['waiting', 'paused'])) {
        if (Date.parse(watch.expiresAt) <= now.getTime()) end(watch, 'expired', 'Expired before the condition was met.')
      }
      if (now.getTime() - this.lastPruneAt >= PRUNE_EVERY_MS) {
        deleteEndedWatchesBefore(new Date(now.getTime() - ENDED_RETENTION_MS))
        this.lastPruneAt = now.getTime()
      }
      const due = dueWatches(now)
        .filter((watch) => !this.probing.has(watch.id))
        .slice(0, MAX_CONCURRENT_PROBES - this.probing.size)
      await Promise.all(due.map((watch) => this.evaluate(watch)))
    } catch (error) {
      log.error('watch_tick_failed', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.ticking = false
    }
  }

  private async evaluate(watch: Watch): Promise<void> {
    this.probing.add(watch.id)
    try {
      if (!watch.probe) {
        await this.wake(watch, undefined)
        return
      }
      const result = await this.runProbe(watch.probe, watch.cwd)
      // A person may have paused or cancelled the watch while the probe ran.
      const current = loadWatch(watch.id)
      if (!current || current.status !== 'waiting') return
      current.lastResult = result

      if (isProbeError(result)) {
        current.consecutiveProbeErrors++
        log.warn('watch_probe_error', { watchId: current.id, sessionId: current.sessionId, error: result.error, exitCode: result.exitCode })
        if (current.consecutiveProbeErrors < MAX_CONSECUTIVE_PROBE_ERRORS) {
          current.nextRunAt = nextRunAfter(current.schedule, this.now())
          saveWatch(current)
        } else if (current.onMatch === 'wake') {
          await this.wake(current, result)
        } else {
          const ending = endAfterWake(current)
          if (ending) end(current, ending.status, ending.reason)
        }
        return
      }

      current.consecutiveProbeErrors = 0
      const previousFingerprint = current.lastFingerprint
      const fingerprint = fingerprintOf(result)
      current.lastFingerprint = fingerprint
      const matched = !!current.until
        && untilMatches(current.until, result, previousFingerprint)
        // One result wakes the session once; a repeat watch waits for a new one.
        && fingerprint !== current.wokenFingerprint
      if (!matched) {
        current.nextRunAt = nextRunAfter(current.schedule, this.now())
        saveWatch(current)
        return
      }
      if (current.onMatch === 'notify') {
        end(current, 'done', 'The condition was met.')
        return
      }
      current.wokenFingerprint = fingerprint
      await this.wake(current, result)
    } catch (error) {
      log.error('watch_evaluate_failed', { watchId: watch.id, error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.probing.delete(watch.id)
    }
  }

  private async wake(watch: Watch, result: WatchProbeResult | undefined): Promise<void> {
    watch.wakeCount++
    watch.status = 'woken'
    delete watch.nextRunAt
    const ending = endAfterWake(watch)
    saveWatch(watch)
    log.info('watch_woke_session', { watchId: watch.id, sessionId: watch.sessionId, wakeCount: watch.wakeCount })
    let done: Promise<unknown>
    try {
      ({ done } = await this.deps.dispatchWake({
        sessionId: watch.sessionId,
        watchId: watch.id,
        prompt: wakePrompt(watch, result, ending ? `The watch has ended: ${ending.reason}` : null),
        displayPrompt: wakeDisplayText(watch, result),
      }))
    } catch (error) {
      end(watch, 'failed', `Could not wake the session: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    // The wake settles with its turn, whatever the turn's outcome.
    void done.catch(() => {}).finally(() => this.afterWake(watch.id))
  }

  /** The woken turn ended: wait again or end. A watch paused or cancelled
   *  during the turn keeps the state the person gave it. */
  private afterWake(watchId: string): void {
    const watch = loadWatch(watchId)
    if (!watch || watch.status !== 'woken') return
    const ending = endAfterWake(watch)
    if (ending) {
      end(watch, ending.status, ending.reason)
      return
    }
    watch.status = 'waiting'
    watch.nextRunAt = nextRunAfter(watch.schedule, this.now())
    saveWatch(watch)
  }
}
