import type { AgentMetadata, AgentUsageLimits, UsageWindow } from '@solus/contracts/types'
import { DAY, HOUR, MINUTE } from '../../../lib/duration'

/** How much of one quota window is still available, ready to render. */
export interface UsageMeter {
  key: 'fiveHour' | 'weekly'
  label: string
  remainingPercent: number
  /** Drives the bar tint — a nearly-spent window has to read as one at a glance. */
  tone: 'ok' | 'low' | 'spent'
  /** The whole qualifier beside the bar — "resets in 3h 12m", or "resetting now"
   *  once the window is due, because a countdown has no words left at zero. */
  resetPhrase: string | null
}

/** One provider's usage state, with the quota windows it actually reports.
 * An empty `meters` accompanies either API billing or a failed read. */
export interface ProviderUsage {
  provider: string
  label: string
  stale: boolean
  meters: UsageMeter[]
  status: 'api' | 'unavailable' | null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const CLAUDE_DATE_LABEL = /^([A-Za-z]{3})\w* (\d{1,2}),? (?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s+\(([^)]+)\))?/i
const CLAUDE_WEEKDAY_LABEL = /^([A-Za-z]{3})\w* at (\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s+\(([^)]+)\))?$/i

/**
 * Claude prints localized reset text with no year. A local process commonly
 * gives a date ("Jul 31 at 1am"), while a remote process can include a comma
 * and its own zone ("Aug 12, 9:40am (UTC)").
 */
export function parseResetLabel(label: string, now: number): number | null {
  const dateMatch = label.match(CLAUDE_DATE_LABEL)
  if (dateMatch) return parseDateReset(dateMatch, now)

  const weekdayMatch = label.match(CLAUDE_WEEKDAY_LABEL)
  if (!weekdayMatch) return null
  const weekday = WEEKDAYS.indexOf(weekdayMatch[1].slice(0, 3).toLowerCase())
  if (weekday < 0) return null
  const hours = clockHours(weekdayMatch[2], weekdayMatch[4])
  const minutes = Number(weekdayMatch[3] ?? 0)
  const timezone = weekdayMatch[5]?.toLowerCase()
  if (timezone && timezone !== 'utc') return null

  const current = new Date(now)
  const currentWeekday = timezone === 'utc' ? current.getUTCDay() : current.getDay()
  const daysAhead = (weekday - currentWeekday + 7) % 7
  let reset = timezone === 'utc'
    ? Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + daysAhead, hours, minutes)
    : new Date(current.getFullYear(), current.getMonth(), current.getDate() + daysAhead, hours, minutes, 0, 0).getTime()
  if (reset < now) reset += 7 * DAY
  return reset
}

function parseDateReset(match: RegExpMatchArray, now: number): number | null {
  const month = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase())
  if (month < 0) return null
  const day = Number(match[2])
  const minutes = Number(match[4] ?? 0)
  const hours = clockHours(match[3], match[5])
  const timezone = match[6]?.toLowerCase()
  const current = new Date(now)
  const reset = timezone === 'utc'
    ? new Date(Date.UTC(current.getUTCFullYear(), month, day, hours, minutes, 0, 0))
    : new Date(current.getFullYear(), month, day, hours, minutes, 0, 0)
  // A December reset read in January lands a year behind; roll it forward.
  if (reset.getTime() < now - 180 * DAY) {
    if (timezone === 'utc') reset.setUTCFullYear(current.getUTCFullYear() + 1)
    else reset.setFullYear(current.getFullYear() + 1)
  }
  return reset.getTime()
}

function clockHours(hour: string, meridiem: string): number {
  let hours = Number(hour) % 12
  if (meridiem.toLowerCase() === 'pm') hours += 12
  return hours
}

/** Compact countdown — one unit of precision more than the reader needs to act.
 *  A window that is already due has no duration to print, so it returns null. */
export function untilText(remaining: number): string | null {
  if (remaining <= 0) return null
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
function resetPhrase(window: UsageWindow, now: number): string | null {
  const resetsAt = window.resetsAt ?? (window.resetsLabel ? parseResetLabel(window.resetsLabel, now) : null)
  if (resetsAt !== null) {
    const until = untilText(resetsAt - now)
    return until ? `resets in ${until}` : 'resetting now'
  }
  return window.resetsLabel ? `resets in ${window.resetsLabel}` : null
}

function meter(key: UsageMeter['key'], label: string, window: UsageWindow | null, now: number): UsageMeter | null {
  if (!window) return null
  const remainingPercent = Math.max(0, Math.min(100, 100 - window.usedPercent))
  return { key, label, remainingPercent, tone: toneFor(remainingPercent), resetPhrase: resetPhrase(window, now) }
}

/**
 * Quota rows for every agent the backend currently offers. A provider that
 * reports no quota (unavailable, or not subscription-metered) is dropped
 * entirely — an empty meter would read as "no quota left". A provider whose
 * read failed keeps its row with no meters, because "we could not read this"
 * and "this has no quota" are different answers to the same glance.
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
    if (limits.usageMode === 'api') {
      rows.push({ provider: agent.id, label: agent.label, stale: false, meters: [], status: 'api' })
      continue
    }
    if (meters.length === 0 && !limits.stale) continue
    rows.push({
      provider: agent.id,
      label: agent.label,
      stale: limits.stale,
      meters,
      status: limits.stale && meters.length === 0 ? 'unavailable' : null,
    })
  }
  return rows
}
