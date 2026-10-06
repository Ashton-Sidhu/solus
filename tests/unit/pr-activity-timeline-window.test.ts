import { describe, expect, test } from 'bun:test'
import {
  TIMELINE_WINDOW_NEWEST,
  TIMELINE_WINDOW_OLDEST,
  TIMELINE_WINDOW_PAGE,
  TIMELINE_WINDOW_THRESHOLD,
  windowTimeline,
} from '@solus/workspace-ui/lib/timeline-window'
import { threadStartsFolded } from '@solus/workspace-ui/components/pr-review/lib/activity-data'

// A pull request with hundreds of reviews froze the Activity tab: every card
// mounted and parsed its markdown at once. The timeline now mounts its start
// and its latest events and folds the middle, the way GitHub does. An ordinary
// pull request must not notice.

const events = (count: number) => Array.from({ length: count }, (_, index) => index)

describe('activity timeline window', () => {
  test('a timeline short enough to mount whole is never folded', () => {
    const window = windowTimeline(events(TIMELINE_WINDOW_THRESHOLD), 0)
    expect(window.before).toEqual(events(TIMELINE_WINDOW_THRESHOLD))
    expect(window.hiddenCount).toBe(0)
    expect(window.after).toEqual([])
  })

  test('a long timeline mounts how it began and where it stands now', () => {
    const all = events(900)
    const window = windowTimeline(all, 0)
    expect(window.before).toEqual(all.slice(0, TIMELINE_WINDOW_OLDEST))
    expect(window.after).toEqual(all.slice(-TIMELINE_WINDOW_NEWEST))
    expect(window.hiddenCount).toBe(900 - TIMELINE_WINDOW_OLDEST - TIMELINE_WINDOW_NEWEST)
    // Nothing is lost: every event is mounted or counted as hidden.
    expect(window.before.length + window.hiddenCount + window.after.length).toBe(900)
  })

  test('revealing continues on from the start, one page at a time, until nothing is hidden', () => {
    const all = events(200)
    const once = windowTimeline(all, TIMELINE_WINDOW_PAGE)
    expect(once.before).toEqual(all.slice(0, TIMELINE_WINDOW_OLDEST + TIMELINE_WINDOW_PAGE))
    expect(once.after).toEqual(all.slice(-TIMELINE_WINDOW_NEWEST))

    const past = windowTimeline(all, TIMELINE_WINDOW_PAGE * 10)
    expect(past.before).toEqual(all)
    expect(past.hiddenCount).toBe(0)
    expect(past.after).toEqual([])
  })
})

describe('which threads start folded', () => {
  const base = { isResolved: false, isOutdated: false }

  test('an open thread on current code shows in full: it asks the reader to act', () => {
    expect(threadStartsFolded(base)).toBe(false)
  })

  test('resolved and outdated threads fold, as GitHub folds them', () => {
    expect(threadStartsFolded({ ...base, isResolved: true })).toBe(true)
    expect(threadStartsFolded({ ...base, isOutdated: true })).toBe(true)
  })
})
