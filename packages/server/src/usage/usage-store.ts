import {
  FIVE_HOUR_WINDOW_MINS,
  WEEKLY_WINDOW_MINS,
  type AgentId,
  type AgentUsageLimits,
  type UsageWindow,
  type UsageWindowUpdate,
} from '@solus/contracts/types'
import { createLogger } from '../logger'

const log = createLogger('main', 'usage-store')

/**
 * What every surface asks when a limit stops a run: when does this window
 * reopen?
 *
 * The providers answer that twice. Once accurately, on the stream — Codex's
 * `account/rateLimits/updated` and Claude's `rate_limit_event` both carry an
 * epoch, on nearly every turn — and once badly, in the terminal error, where
 * Codex buries the moment in prose ("try again at Sep 15th, 2026 12:26 AM")
 * and Claude's wording carries no year. Solus used to parse the prose and
 * guess five minutes when that failed, which is how a weekly limit released a
 * queued prompt six days early.
 *
 * Keep raw quota data for the usage meters and for terminal errors that omit
 * a reset. Direct rate-limit events keep their own provider timestamps. Retry
 * buffers belong to the control plane and are never stored here.
 */
export class UsageLimitsStore {
  private byAgent = new Map<AgentId, AgentUsageLimits>()

  snapshot(): AgentUsageLimits[] {
    return [...this.byAgent.values()]
  }

  get(agentId: AgentId): AgentUsageLimits | undefined {
    return this.byAgent.get(agentId)
  }

  /** A full read from the provider. Newer than anything held, so it replaces. */
  apply(limits: AgentUsageLimits): void {
    this.byAgent.set(limits.provider, limits)
  }

  /**
   * Windows seen on the stream. Merged rather than assigned: Claude reports one
   * window per event, so a five-hour update must not erase the weekly reset
   * standing beside it.
   */
  applyWindows(agentId: AgentId, windows: UsageWindowUpdate[], now = Date.now()): void {
    if (windows.length === 0) return
    const current = this.byAgent.get(agentId)
    const next: AgentUsageLimits = current
      ? { ...current, fetchedAt: now, stale: false }
      : { provider: agentId, fiveHour: null, weekly: null, planType: null, fetchedAt: now, stale: false }

    for (const update of windows) {
      if (update.windowDurationMins === FIVE_HOUR_WINDOW_MINS) next.fiveHour = mergeWindow(next.fiveHour, update)
      else if (update.windowDurationMins === WEEKLY_WINDOW_MINS) next.weekly = mergeWindow(next.weekly, update)
    }
    this.byAgent.set(agentId, next)
  }

  /**
   * Keep the last-good numbers and say they're old. Dropping them would leave a
   * watching UI blank on a single transient failure.
   *
   * With nothing cached there are no numbers to keep, but the provider still
   * has to appear: Claude's `/usage` report carries its quota from an account
   * endpoint that can answer empty or rate-limited, and a boot inside such a
   * window would otherwise remove the whole row — indistinguishable from a
   * provider that has no quota at all. Seed a windowless snapshot so the row
   * survives and reads as unavailable until a read succeeds.
   */
  markStale(agentId: AgentId, reason: string): void {
    log.warn('usage_refresh_failed', { agentId, reason })
    const cached = this.byAgent.get(agentId)
    if (cached) {
      cached.stale = true
      return
    }
    // fetchedAt stays 0: no read has ever landed for this provider.
    this.byAgent.set(agentId, { provider: agentId, fiveHour: null, weekly: null, planType: null, fetchedAt: 0, stale: true })
  }

  /**
   * Epoch seconds the window reopens, or null when this store cannot say.
   *
   * `windowDurationMins` is absent when the provider named no window — Codex's
   * terminal error says only `usageLimitExceeded`. One reported window still
   * answers, because nothing else could have been hit. Two reported and no name
   * is genuinely ambiguous, and guessing there would hold a prompt for a week
   * when the five-hour window was what stopped it, so it declines.
   *
   * A reset already in the past describes a window that has reopened. It is not
   * an answer to "when does the limit that just stopped me lift".
   */
  resetsAtFor(agentId: AgentId, windowDurationMins: number | undefined, now = Date.now()): number | null {
    const limits = this.byAgent.get(agentId)
    if (!limits) return null

    let window: UsageWindow | null
    if (windowDurationMins === FIVE_HOUR_WINDOW_MINS) window = limits.fiveHour
    else if (windowDurationMins === WEEKLY_WINDOW_MINS) window = limits.weekly
    else if (windowDurationMins !== undefined) window = null
    else {
      const reported = [limits.fiveHour, limits.weekly].filter((entry) => entry !== null)
      window = reported.length === 1 ? reported[0] : null
    }

    if (!window?.resetsAt || window.resetsAt <= now) return null
    return Math.ceil(window.resetsAt / 1000)
  }
}

function mergeWindow(current: UsageWindow | null, update: UsageWindowUpdate): UsageWindow {
  return {
    usedPercent: update.usedPercent ?? current?.usedPercent ?? 0,
    resetsAt: update.resetsAt ?? current?.resetsAt ?? null,
    resetsLabel: current?.resetsLabel ?? null,
  }
}
