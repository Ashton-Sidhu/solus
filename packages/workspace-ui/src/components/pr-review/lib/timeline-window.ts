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

/**
 * Split `events` (oldest first) around the hidden middle. `revealedCount` is
 * how many hidden events the reader has asked for; they join `before`, so
 * reading on from the start continues where it left off.
 */
export function windowTimeline<T>(events: readonly T[], revealedCount: number): TimelineWindow<T> {
  if (events.length <= TIMELINE_WINDOW_THRESHOLD) {
    return { before: [...events], hiddenCount: 0, after: [] }
  }
  const afterStart = events.length - TIMELINE_WINDOW_NEWEST
  const beforeEnd = Math.min(afterStart, TIMELINE_WINDOW_OLDEST + Math.max(0, revealedCount))
  if (beforeEnd === afterStart) return { before: [...events], hiddenCount: 0, after: [] }
  return {
    before: events.slice(0, beforeEnd),
    hiddenCount: afterStart - beforeEnd,
    after: events.slice(afterStart),
  }
}
