import { describe, expect, test } from 'bun:test'
import { railTimeLines } from '@solus/workspace-ui/components/conversation/lib/hover-rail'

// WHY: the rail hangs in the reading column's side gutter, which is 48px in
// every pane under ~1130px, and the transcript clips anything wider. "11:22 AM"
// on one line was cut to "11:22 A". Every line must stay as narrow as a bare
// clock, so the day period, the day, and the year each take their own line.
const GUTTER_LINE_CHARS = 5

const now = new Date(2026, 10, 20, 15, 0).getTime()

function expectEachLineFitsGutter(lines: string[]) {
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(GUTTER_LINE_CHARS)
}

describe('hover rail time', () => {
  test('today is the clock alone, with the day period on its own line', () => {
    const lines = railTimeLines(new Date(2026, 10, 20, 11, 22).getTime(), now)
    expect(lines[0]).toBe('11:22')
    expectEachLineFitsGutter(lines)
  })

  test('within the week the weekday leads the clock on its own line', () => {
    const lines = railTimeLines(new Date(2026, 10, 19, 11, 22).getTime(), now)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[1]).toBe('11:22')
    expectEachLineFitsGutter(lines)
  })

  test('an earlier year puts the date and the year on separate lines', () => {
    const lines = railTimeLines(new Date(2025, 10, 3, 11, 22).getTime(), now)
    expect(lines).toContain('2025')
    expect(lines[2]).toBe('11:22')
    expectEachLineFitsGutter(lines)
  })
})
