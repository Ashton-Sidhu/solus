/// <reference types="bun-types" />
/**
 * The segmented time field edits a `Time`, but every caller — a cron trigger, a
 * saved schedule, the `datetime-local` half of the date+time picker — persists a
 * 24-hour `HH:MM` string. If that conversion drifts, a schedule silently fires
 * at the wrong hour, so the round trip is guarded here.
 *
 * Run with `bun test tests/unit/time-field-clock.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import { Time } from '@internationalized/date'
import { formatClock, parseClock } from '../../src/renderer/components/ui/time-field/clock'

describe('parseClock', () => {
  test('reads a stored clock time', () => {
    expect(parseClock('09:30')).toEqual(new Time(9, 30))
    expect(parseClock('00:00')).toEqual(new Time(0, 0))
    expect(parseClock('23:59')).toEqual(new Time(23, 59))
  })

  test('reads an afternoon hour as 24-hour, never as its 12-hour face', () => {
    expect(parseClock('17:05')?.hour).toBe(17)
  })

  test('ignores the seconds a datetime value may carry', () => {
    expect(parseClock('08:15:42')).toEqual(new Time(8, 15))
  })

  test('rejects text that is not a clock time, so the field shows empty rather than a wrong hour', () => {
    expect(parseClock('')).toBeUndefined()
    expect(parseClock('9')).toBeUndefined()
    expect(parseClock('24:00')).toBeUndefined()
    expect(parseClock('10:75')).toBeUndefined()
  })
})

describe('formatClock', () => {
  test('pads to the HH:MM every caller stores', () => {
    expect(formatClock(new Time(9, 5))).toBe('09:05')
    expect(formatClock(new Time(0, 0))).toBe('00:00')
  })

  test('round-trips a value the field did not change', () => {
    for (const clock of ['00:00', '07:45', '12:00', '13:01', '23:59']) {
      const parsed = parseClock(clock)
      expect(parsed && formatClock(parsed)).toBe(clock)
    }
  })
})
