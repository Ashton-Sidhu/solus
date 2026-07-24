import { describe, expect, test } from 'bun:test'
import {
  HOLD_MS,
  ReviewSessionCore,
  type DispositionPoster,
} from '../../src/renderer/components/review-mode/lib/review-session-core'
import type { PendingDisposition } from '../../src/shared/review-session-types'

function harness(failingPrs: number[] = []) {
  let time = 0
  const posted: PendingDisposition[] = []
  const poster: DispositionPoster = {
    async post(disposition) {
      posted.push(disposition)
      if (failingPrs.includes(disposition.prNumber)) throw new Error(`post failed for #${disposition.prNumber}`)
    },
  }
  const core = new ReviewSessionCore(poster, () => time)
  return {
    core,
    posted,
    setTime(value: number) {
      time = value
    },
  }
}

describe('ReviewSessionCore', () => {
  test('advances on one keystroke while keeping a held PR out of settled state', () => {
    const { core, setTime } = harness()
    core.start([101, 102])

    setTime(400)
    core.dispose(101, 'approved')

    expect(core.state?.cursor).toBe(1)
    expect(core.state?.entries[0].outcome).toBeNull()
    expect(core.pendingFor(101)?.outcome).toBe('approved')
    expect(core.nextExpiry()).toBe(HOLD_MS)
  })

  test('undo inside the hold means the disposition never happened', async () => {
    const { core, posted, setTime } = harness()
    core.start([101, 102])
    core.dispose(101, 'changes_requested', 'Please add the missing guard.')

    setTime(HOLD_MS - 1)
    expect(core.undo(101)).toBe(true)
    expect(core.state?.cursor).toBe(0)
    expect(core.state?.pending).toEqual([])

    setTime(HOLD_MS * 2)
    await core.flushExpired()
    expect(posted).toEqual([])
    expect(core.state?.entries[0].outcome).toBeNull()
  })

  test('flushes exactly expired dispositions and settles only successful host facts', async () => {
    const { core, posted, setTime } = harness([102])
    core.start([101, 102, 103])
    core.dispose(101, 'approved')
    setTime(1_000)
    core.dispose(102, 'commented', 'A non-blocking note.')

    setTime(HOLD_MS)
    await core.flushExpired()
    expect(posted.map((item) => item.prNumber)).toEqual([101])
    expect(core.state?.entries[0].outcome).toBe('approved')
    expect(core.state?.entries[1].outcome).toBeNull()

    setTime(HOLD_MS + 1_000)
    await core.flushExpired()
    expect(posted.map((item) => item.prNumber)).toEqual([101, 102])
    expect(core.state?.entries[1].outcome).toBeNull()
    expect(core.state?.entries[1].flushError).toBe('post failed for #102')
    expect(core.pendingFor(102)).not.toBeNull()
    expect(core.nextExpiry()).toBeNull()
  })

  test('can post one disposition immediately without flushing the remaining hold queue', async () => {
    const { core, posted, setTime } = harness()
    core.start([101, 102, 103])
    core.dispose(101, 'approved')
    setTime(100)
    core.dispose(102, 'commented', 'A note that still needs its undo window.')

    await core.flush(101)

    expect(posted.map((item) => item.prNumber)).toEqual([101])
    expect(core.state?.entries[0].outcome).toBe('approved')
    expect(core.pendingFor(101)).toBeNull()
    expect(core.pendingFor(102)?.outcome).toBe('commented')
  })

  test('flushAll posts every held disposition immediately on session exit', async () => {
    const { core, posted, setTime } = harness()
    core.start([101, 102, 103])
    setTime(100)
    core.dispose(101, 'approved')
    setTime(200)
    core.dispose(102, 'deferred')

    setTime(300)
    await core.flushAll()

    expect(posted.map((item) => item.prNumber)).toEqual([101, 102])
    expect(core.state?.pending).toEqual([])
    expect(core.state?.endedAt).toBe(300)
    expect(core.state?.entries.map((entry) => entry.outcome)).toEqual(['approved', 'deferred', null])
  })

  test('flushAll does not retry a provider rejection on session exit', async () => {
    const { core, posted, setTime } = harness([101])
    core.start([101])
    core.dispose(101, 'approved')

    await core.flush(101)
    expect(posted.map((item) => item.prNumber)).toEqual([101])
    expect(core.state?.entries[0].flushError).toBe('post failed for #101')

    setTime(300)
    await core.flushAll()

    expect(posted.map((item) => item.prNumber)).toEqual([101])
    expect(core.state?.endedAt).toBe(300)
  })

  test('accumulates dwell across revisits without charging time while hidden', () => {
    const { core, setTime } = harness()
    core.start([101, 102])

    setTime(100)
    core.next()
    setTime(150)
    core.prev()
    setTime(200)
    core.markHidden()
    setTime(1_000)
    core.markVisible()
    setTime(1_100)
    core.next()

    expect(core.state?.entries.map((entry) => entry.dwellMs)).toEqual([250, 50])
    expect(core.state?.entries[0].openedAt).toBe(0)
    expect(core.state?.entries[1].openedAt).toBe(100)
  })

  test('skip settles locally and never invokes the disposition poster', async () => {
    const { core, posted, setTime } = harness()
    core.start([101, 102])
    setTime(100)
    core.skip(101)

    expect(core.state?.cursor).toBe(1)
    expect(core.state?.entries[0].outcome).toBe('skipped')
    expect(core.state?.pending).toEqual([])

    await core.flushAll()
    expect(posted).toEqual([])
  })
})
