import type { AgentMetadata, AgentUsageLimits, UsageWindow } from '../../../../shared/types'

/** How much of one quota window is still available, ready to render. */
export interface UsageMeter {
  key: 'fiveHour' | 'weekly'
  label: string
  remainingPercent: number
  /** Drives the bar tint — a nearly-spent window has to read as one at a glance. */
  tone: 'ok' | 'low' | 'spent'
  /** Time until the window refills ("3h 12m"), or the provider's own wording
   *  when its reset can't be resolved to a moment. */
  resetText: string | null
}

/** One provider's quota, with the windows it actually reports. */
export interface ProviderUsage {
  provider: string
  label: string
  stale: boolean
  meters: UsageMeter[]
}

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const CLAUDE_LABEL = /^([A-Za-z]{3})\w* (\d{1,2}) at (\d{1,2})(?::(\d{2}))?\s*(am|pm)/i

/**
 * Claude prints its reset as localized text with no year ("Jul 31 at 1am
 * (America/Toronto)") — in the user's own zone, so the parts can be read
 * against the local clock. The year is whichever puts the reset ahead of now,
 * which is the only reading a quota window can have.
 */
export function parseResetLabel(label: string, now: number): number | null {
  const match = label.match(CLAUDE_LABEL)
  if (!match) return null
  const month = MONTHS.indexOf(match[1].toLowerCase())
  if (month < 0) return null
  const day = Number(match[2])
  const minutes = Number(match[4] ?? 0)
  let hours = Number(match[3]) % 12
  if (match[5].toLowerCase() === 'pm') hours += 12
  const current = new Date(now)
  const reset = new Date(current.getFullYear(), month, day, hours, minutes, 0, 0)
  // A December reset read in January lands a year behind; roll it forward.
  if (reset.getTime() < now - 180 * DAY) reset.setFullYear(current.getFullYear() + 1)
  return reset.getTime()
}

/** Compact countdown — one unit of precision more than the reader needs to act. */
export function untilText(remaining: number): string {
  if (remaining <= 0) return 'resetting'
  if (remaining < HOUR) return `${Math.max(1, Math.round(remaining / MINUTE))}m`
  if (remaining < DAY) {
    const hours = Math.floor(remaining / HOUR)
    const minutes = Math.round((remaining % HOUR) / MINUTE)
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
  }
  const days = Math.floor(remaining / DAY)
  const hours = Math.round((remaining % DAY) / HOUR)
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`
}

function toneFor(remainingPercent: number): UsageMeter['tone'] {
  if (remainingPercent <= 10) return 'spent'
  if (remainingPercent <= 25) return 'low'
  return 'ok'
}

/** Codex gives an epoch, Claude a localized label — both become a countdown,
 *  and an unparseable label degrades to the provider's own words. */
function resetText(window: UsageWindow, now: number): string | null {
  const resetsAt = window.resetsAt ?? (window.resetsLabel ? parseResetLabel(window.resetsLabel, now) : null)
  if (resetsAt !== null) return untilText(resetsAt - now)
  return window.resetsLabel
}

function meter(key: UsageMeter['key'], label: string, window: UsageWindow | null, now: number): UsageMeter | null {
  if (!window) return null
  const remainingPercent = Math.max(0, Math.min(100, 100 - window.usedPercent))
  return { key, label, remainingPercent, tone: toneFor(remainingPercent), resetText: resetText(window, now) }
}

/**
 * Quota rows for every agent the backend currently offers. A provider that
 * reports no quota (unavailable, or not subscription-metered) is dropped
 * entirely — an empty meter would read as "no quota left".
 */
export function providerUsage(
  agents: AgentMetadata[],
  usage: Record<string, AgentUsageLimits>,
  now: number,
): ProviderUsage[] {
  const rows: ProviderUsage[] = []
  for (const agent of agents) {
    if (agent.available === false) continue
    const limits = usage[agent.id]
    if (!limits) continue
    const meters = [
      // "Session", not "5h": beside a countdown, a window named for its own
      // length reads as a second duration ("5h · 50m").
      meter('fiveHour', 'Session', limits.fiveHour, now),
      meter('weekly', 'Weekly', limits.weekly, now),
    ].filter((entry): entry is UsageMeter => entry !== null)
    if (meters.length === 0) continue
    rows.push({ provider: agent.id, label: agent.label, stale: limits.stale, meters })
  }
  return rows
}
