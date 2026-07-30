const DAY_MS = 86_400_000

/**
 * The rail's stamp. Within the last day it is just the clock — the transcript
 * never prints a date inline, and a reader scanning today's thread only needs
 * the time. Past that the clock alone is ambiguous, so the day leads it.
 */
export function formatRailTime(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp)
  const clock = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (now - timestamp < DAY_MS) return clock

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${clock}`

  // Inside the week the weekday reads faster than a date; beyond it, the date is
  // the only thing that still locates the message.
  const withinWeek = now - timestamp < 7 * DAY_MS
  const day = withinWeek
    ? date.toLocaleDateString(undefined, { weekday: 'short' })
    : date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
      })
  return `${day} ${clock}`
}

/** The full date, carried as the stamp's title. */
export function formatRailTitle(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
