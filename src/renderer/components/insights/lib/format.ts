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

/** Model ids are long and share a vendor prefix that carries no information in
 *  a column already scoped to one provider. */
export function shortModel(model: string | null | undefined): string {
  if (!model) return '—'
  return model.replace(/^(claude|anthropic|openai|gpt)[-/]/, '')
}

/** A prompt on one line: the surface truncates with CSS, but newlines would
 *  otherwise collapse into a run of blanks mid-row. */
export function singleLine(text: string | null | undefined): string {
  if (!text) return ''
  return text.replace(/\s+/g, ' ').trim()
}

export function formatRowCount(count: number): string {
  return `${count} ${count === 1 ? 'row' : 'rows'}`
}
