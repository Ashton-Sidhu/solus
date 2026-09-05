import { DAY, HOUR, MINUTE } from './duration'

export function relativeTime(timestamp: number): string {
  const difference = Date.now() - timestamp
  if (difference < MINUTE) return 'just now'
  if (difference < HOUR) return `${Math.floor(difference / MINUTE)}m ago`
  if (difference < DAY) return `${Math.floor(difference / HOUR)}h ago`
  return `${Math.floor(difference / DAY)}d ago`
}

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
  if (difference < MINUTE) return 'now'
  if (difference < HOUR) return `${Math.floor(difference / MINUTE)}m`
  if (difference < DAY) return `${Math.floor(difference / HOUR)}h`
  if (difference < 2 * DAY) return 'yesterday'
  if (difference < 7 * DAY) return `${Math.floor(difference / DAY)}d`
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
