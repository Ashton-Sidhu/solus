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
 * The rail's stamp. Within the last day it is just the clock — the transcript
 * never prints a date inline, and a reader scanning today's thread only needs
 * the time. Past that the clock alone is ambiguous, so the day leads it.
 */
export function formatRailTime(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp)
  const clock = formatterFor({ hour: 'numeric', minute: '2-digit' }).format(date)
  if (now - timestamp < DAY_MS) return clock

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${clock}`

  // Inside the week the weekday reads faster than a date; beyond it, the date is
  // the only thing that still locates the message.
  const withinWeek = now - timestamp < 7 * DAY_MS
  const dateOptions: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  if (date.getFullYear() !== new Date(now).getFullYear()) dateOptions.year = 'numeric'
  const day = formatterFor(withinWeek ? { weekday: 'short' } : dateOptions).format(date)
  return `${day} ${clock}`
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
