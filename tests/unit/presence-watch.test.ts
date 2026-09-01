import { afterEach, describe, expect, jest, test } from 'bun:test'
import { PresenceWatch } from '@solus/workspace-ui/lib/presence-watch'

afterEach(() => jest.useRealTimers())

describe('PresenceWatch', () => {
  test('shares one poll and stops it when the last viewer leaves', () => {
    // WHY: the same document can be mounted in two panes. It must not spend two
    // provider requests per interval, and one pane closing must not stop the other.
    jest.useFakeTimers()
    const watches = new PresenceWatch()
    let refreshes = 0
    const refresh = () => { refreshes += 1 }

    const releaseFirst = watches.watch('doc-1', refresh)
    const releaseSecond = watches.watch('doc-1', refresh)
    expect(refreshes).toBe(1)

    jest.advanceTimersByTime(5 * 60_000)
    expect(refreshes).toBe(2)
    releaseFirst()
    jest.advanceTimersByTime(5 * 60_000)
    expect(refreshes).toBe(3)

    releaseSecond()
    jest.advanceTimersByTime(5 * 60_000)
    expect(refreshes).toBe(3)
  })
})
