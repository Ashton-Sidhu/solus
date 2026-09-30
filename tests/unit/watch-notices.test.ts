import { describe, expect, test } from 'bun:test'
import type { Watch } from '@solus/contracts/watch-types'
import { watchEndNotice } from '@solus/workspace-ui/contexts/watches/watch-notice'
import { watchRail } from '@solus/workspace-ui/components/watches/lib/watch-format'

const NOW = Date.parse('2026-09-24T12:00:00.000Z')

function watch(patch: Partial<Watch>): Watch {
  return {
    id: 'w1', sessionId: 's1', cwd: '/repo', reason: 'Fix CI', schedule: { everySeconds: 60 },
    onMatch: 'wake', repeat: true, maxWakes: 5, expiresAt: '2026-09-25T12:00:00.000Z',
    wakeCount: 0, consecutiveProbeErrors: 0, status: 'waiting',
    createdAt: '2026-09-24T11:00:00.000Z', updatedAt: '2026-09-24T11:00:00.000Z',
    ...patch,
  }
}

describe('watch end notices', () => {
  // A wake already shows in the conversation; a toast is for the ends the
  // person would not see otherwise.
  test('tells the person when a watch ends without its condition', () => {
    expect(watchEndNotice(watch({}), watch({ status: 'failed', endReason: 'The probe failed 3 times in a row.' })))
      .toBe('Watch ended: Fix CI — The probe failed 3 times in a row.')
    expect(watchEndNotice(watch({ status: 'woken' }), watch({ status: 'exhausted' }))).toBe('Watch ended: Fix CI')
    expect(watchEndNotice(undefined, watch({ status: 'expired' }))).toBe('Watch ended: Fix CI')
  })

  test('tells the person when a notify watch meets its condition', () => {
    expect(watchEndNotice(watch({}), watch({ onMatch: 'notify', status: 'done' }))).toBe('Watch done: Fix CI')
  })

  test('says nothing for a wake, a normal end, a cancel, or a repeat of an end', () => {
    expect(watchEndNotice(watch({}), watch({ status: 'woken' }))).toBeNull()
    expect(watchEndNotice(watch({ status: 'woken' }), watch({ status: 'done' }))).toBeNull()
    expect(watchEndNotice(watch({}), watch({ status: 'cancelled' }))).toBeNull()
    expect(watchEndNotice(watch({ status: 'failed' }), watch({ status: 'failed' }))).toBeNull()
  })
})

describe('watch rail', () => {
  test('a waiting watch shows its wakes and the time to its next check', () => {
    expect(watchRail(watch({ wakeCount: 1, nextRunAt: '2026-09-24T12:05:00.000Z' }), NOW)).toBe('waiting · 1/5 wakes · next in 5m')
    expect(watchRail(watch({ nextRunAt: '2026-09-24T11:59:00.000Z' }), NOW)).toBe('waiting · 0/5 wakes · checking')
  })

  test('an ended watch names how it ended', () => {
    expect(watchRail(watch({ status: 'exhausted', wakeCount: 5 }), NOW)).toBe('out of wakes · 5/5 wakes')
  })
})
