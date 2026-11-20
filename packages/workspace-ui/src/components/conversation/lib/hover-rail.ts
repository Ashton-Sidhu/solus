const DAY_MS = 86_400_000

// Each `toLocale…String` call builds a new formatter. A transcript stamps every
// row as it mounts, so the formatters are built once and kept.
const formatters = new Map<string, Intl.DateTimeFormat>()
function formatterFor(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options)
  let formatter = formatters.get(key)
  if (!formatter) formatters.set(key, formatter = new Intl.DateTimeFormat(undefined, options))
  return formatter
}

/**
 * The rail's stamp, as the parts it may break between. The rail hangs in the
 * reading column's gutter: a wide gutter shows "Mon 11:22 AM" on one line, but
 * in any pane under ~1130px the gutter is only 48px, and the transcript's edge
 * clips anything wider. There the parts stack, so no part may be wider than a
 * bare clock.
 *
 * Within the last day it is just the clock — the transcript never prints a
 * date inline, and a reader scanning today's thread only needs the time. Past
 * that the clock alone is ambiguous, so the day leads it: the weekday inside
 * the week, the date beyond it, and the year on its own line once it differs.
 */
export function railTimeLines(timestamp: number, now = Date.now()): string[] {
  const date = new Date(timestamp)
  const lines: string[] = []
  if (now - timestamp >= DAY_MS) {
    if (now - timestamp < 7 * DAY_MS) {
      lines.push(formatterFor({ weekday: 'short' }).format(date))
    } else {
      lines.push(formatterFor({ month: 'short', day: 'numeric' }).format(date))
      if (date.getFullYear() !== new Date(now).getFullYear()) lines.push(String(date.getFullYear()))
    }
  }
  // A 12-hour locale's "AM"/"PM" takes its own line; a 24-hour clock has none.
  const parts = formatterFor({ hour: 'numeric', minute: '2-digit' }).formatToParts(date)
  const dayPeriod = parts.find((part) => part.type === 'dayPeriod')?.value
  lines.push(
    parts
      .filter((part) => part.type !== 'dayPeriod')
      .map((part) => part.value)
      .join('')
      .trim(),
  )
  if (dayPeriod) lines.push(dayPeriod)
  return lines
}

/** The full date, carried as the stamp's title. */
export function formatRailTitle(timestamp: number): string {
  return formatterFor({
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp)
}
