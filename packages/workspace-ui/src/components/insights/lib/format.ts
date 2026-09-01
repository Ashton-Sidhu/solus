// Insights value formatting.
//
// Every number the surface prints goes through here, so a duration reads the
// same in the histogram header, a table cell, and a waterfall row. Pure and
// non-reactive: components read these from `$derived`.

/** `840ms`, `9.2s`, `3m04`. Null durations print as an em dash, never `0ms`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}`
}

/** Cost in USD. Codex reports none, and an unknown cost is not zero. */
export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return '—'
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`
}

/**
 * Cost on an axis tick: `$0`, `$0.25`, `$12`.
 *
 * `formatCost`'s fixed precision is right where a number stands alone and must
 * not look rounder than it is. On an axis the value is already a round rung the
 * chart chose, so its trailing zeros claim a precision nobody measured and cost
 * width the plot needs.
 */
export function formatCostTick(usd: number): string {
  if (!Number.isFinite(usd)) return '—'
  if (usd === 0) return '$0'
  return `$${Number(usd < 1 ? usd.toFixed(3) : usd.toFixed(2))}`
}

export function formatTokens(count: number | null | undefined): string {
  if (count == null || !Number.isFinite(count)) return '—'
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(Math.round(count))
}

/** Wall-clock `HH:MM` in the viewer's zone — spans carry epoch milliseconds. */
export function formatClock(epochMs: number | null | undefined): string {
  if (epochMs == null || !Number.isFinite(epochMs)) return '—'
  const at = new Date(epochMs)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** `Aug 12 14:03` — for rows and ticks spanning more than a day, where a bare
 *  clock is ambiguous. */
export function formatDayClock(epochMs: number | null | undefined): string {
  if (epochMs == null || !Number.isFinite(epochMs)) return '—'
  const at = new Date(epochMs)
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${formatClock(epochMs)}`
}

/** `Aug 12` — a day with no time of day. */
export function formatDay(epochMs: number | null | undefined): string {
  if (epochMs == null || !Number.isFinite(epochMs)) return '—'
  return new Date(epochMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How a time axis names an instant, chosen by the span it covers.
 *
 * Under a day a bare clock is unambiguous. Up to three days the day has to come
 * with it. Past that the clock is noise on every tick *and* doubles the label's
 * width — `Aug 11 00:19` is twice `Aug 11` — which is what pushes the end
 * labels off the plot and under the card's edge. Tooltips and the zoom pill
 * keep the full instant; they have the room and they name one bar.
 */
export function axisInstantFormat(spanMs: number): (epochMs: number) => string {
  if (spanMs > 3 * DAY_MS) return formatDay
  if (spanMs > DAY_MS) return formatDayClock
  return formatClock
}

/** Whether a listing straddles more than a day, in which case a bare `HH:MM`
 *  names two different instants in the same column and the rows print the day
 *  as well. */
export function spansMultipleDays(instants: number[]): boolean {
  if (instants.length < 2) return false
  let earliest = Infinity
  let latest = -Infinity
  for (const at of instants) {
    if (at == null || !Number.isFinite(at)) continue
    if (at < earliest) earliest = at
    if (at > latest) latest = at
  }
  return latest - earliest > 24 * 60 * 60 * 1000
}

/** A charted measure as its axis, bars, and tooltips print it. Durations read
 *  as durations; a large count abbreviates rather than spending six characters
 *  on an axis tick; a fraction keeps enough digits to be a number. */
export function formatMeasure(value: number, format: 'duration' | 'number'): string {
  if (format === 'duration') return formatDuration(value)
  if (Math.abs(value) >= 1000) return formatTokens(value)
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%'
  return fraction < 0.01 ? '<1%' : `${Math.round(fraction * 100)}%`
}

/** `12m`, `3h`, `2d` — for query history rows. */
export function formatAge(epochMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86_400)}d`
}

/** A prompt on one line: the surface truncates with CSS, but newlines would
 *  otherwise collapse into a run of blanks mid-row. */
export function singleLine(text: string | null | undefined): string {
  if (!text) return ''
  return text.replace(/\s+/g, ' ').trim()
}

/** A trace id in a breadcrumb: the leading group is enough to recognise a turn,
 *  and the full value stays on the element's title and the copy control. */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—'
  const head = id.split('-')[0] ?? id
  return head.length > 8 ? head.slice(0, 8) : head
}

export function formatRowCount(count: number): string {
  return `${count} ${count === 1 ? 'row' : 'rows'}`
}
