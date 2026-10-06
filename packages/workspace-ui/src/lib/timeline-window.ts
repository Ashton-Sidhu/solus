// Which activity events the timeline mounts.
//
// A pull request with hundreds of reviews and threads cannot mount every card
// at once: each one parses its markdown, and the tab freezes. Like GitHub, a
// long timeline shows its start and its latest events and folds the middle
// behind one row that reveals it a page at a time. A timeline short enough to
// mount whole is never folded, so an ordinary pull request reads as it did.

/** A timeline this long or shorter mounts every event. */
export const TIMELINE_WINDOW_THRESHOLD = 60
/** Events kept from the start: how the change began. */
export const TIMELINE_WINDOW_OLDEST = 10
/** Events kept from the end: where the review stands now. */
export const TIMELINE_WINDOW_NEWEST = 30
/** Events one press of the hidden row reveals. */
export const TIMELINE_WINDOW_PAGE = 50

export interface TimelineWindow<T> {
  /** The start of the timeline, and every page the reader revealed after it. */
  before: T[]
  /** Events between `before` and `after` that are not mounted. */
  hiddenCount: number
  /** The latest events. Empty when nothing is hidden. */
  after: T[]
}

export interface TimelineWindowOptions<T> {
  threshold: number
  oldest: number
  newest: number
  /** A soft budget: keep at least one event at each end, even if it is large. */
  textBudget: number
  textSize: (event: T) => number
}

/**
 * Split `events` (oldest first) around the hidden middle. `revealedCount` is
 * how many hidden events the reader has asked for; they join `before`, so
 * reading on from the start continues where it left off.
 */
export function windowTimeline<T>(
  events: readonly T[],
  revealedCount: number,
  options?: TimelineWindowOptions<T>,
): TimelineWindow<T> {
  const threshold = options?.threshold ?? TIMELINE_WINDOW_THRESHOLD
  const sizes = options ? events.map(options.textSize) : []
  const totalSize = sizes.reduce((sum, size) => sum + size, 0)
  if (events.length <= threshold && (!options || totalSize <= options.textBudget)) {
    return { before: [...events], hiddenCount: 0, after: [] }
  }
  let oldest = Math.min(events.length, options?.oldest ?? TIMELINE_WINDOW_OLDEST)
  let newest = Math.min(events.length - oldest, options?.newest ?? TIMELINE_WINDOW_NEWEST)
  if (options) {
    // Divide the initial text budget between the beginning and the latest news.
    let size = sizes[0] ?? 0
    let count = Math.min(1, oldest)
    while (count < oldest && size + sizes[count]! <= options.textBudget / 2) {
      size += sizes[count++]!
    }
    oldest = count
    size = sizes[events.length - 1] ?? 0
    count = Math.min(1, newest)
    while (count < newest && size + sizes[events.length - 1 - count]! <= options.textBudget / 2) {
      size += sizes[events.length - 1 - count++]!
    }
    newest = count
  }
  const afterStart = events.length - newest
  const beforeEnd = Math.min(afterStart, oldest + Math.max(0, revealedCount))
  if (beforeEnd === afterStart) return { before: [...events], hiddenCount: 0, after: [] }
  return {
    before: events.slice(0, beforeEnd),
    hiddenCount: afterStart - beforeEnd,
    after: events.slice(afterStart),
  }
}
