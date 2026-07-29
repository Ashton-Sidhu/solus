export function relativeTime(timestamp: number): string {
  const difference = Date.now() - timestamp
  if (difference < 60_000) return 'just now'
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)}m ago`
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)}h ago`
  return `${Math.floor(difference / 86_400_000)}d ago`
}

const DAY = 86_400_000

/**
 * Timestamps in a margin thread: compact and relative up to a week, then an
 * absolute date. A week is where "5d" stops being easier to read than "12 Mar"
 * — past it the reader wants to know *when*, not *how long ago*.
 *
 * `now` is a parameter rather than `Date.now()` so a card can re-render its
 * times off a ticking clock, and so the format is testable.
 */
export function threadTime(timestamp: number, now: number): string {
  const difference = now - timestamp
  if (difference < 60_000) return 'now'
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)}m`
  if (difference < DAY) return `${Math.floor(difference / 3_600_000)}h`
  if (difference < 2 * DAY) return 'yesterday'
  if (difference < 7 * DAY) return `${Math.floor(difference / DAY)}d`
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
