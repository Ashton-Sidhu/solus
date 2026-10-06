import { describe, expect, test } from 'bun:test'
import { windowTimeline } from '@solus/workspace-ui/lib/timeline-window'

const options = {
  threshold: 20,
  oldest: 2,
  newest: 8,
  textBudget: 16_000,
  textSize: (body: string) => body.length,
}

describe('task activity render budget', () => {
  test('ordinary short conversations remain complete', () => {
    const comments = Array.from({ length: 18 }, (_, index) => `Comment ${index}`)
    expect(windowTimeline(comments, 0, options)).toEqual({
      before: comments, hiddenCount: 0, after: [],
    })
  })

  test('long reports fold even below the event count threshold', () => {
    const comments = Array.from({ length: 18 }, (_, index) => `${index}: ${'x'.repeat(4_000)}`)
    const window = windowTimeline(comments, 0, options)
    expect(window.before).toEqual(comments.slice(0, 1))
    expect(window.after).toEqual(comments.slice(-1))
    expect(window.hiddenCount).toBe(16)
    expect([...window.before, ...window.after].join('').length).toBeLessThanOrEqual(options.textBudget)
  })

  test('many small events are bounded too', () => {
    const comments = Array.from({ length: 100 }, (_, index) => `Comment ${index}`)
    const window = windowTimeline(comments, 0, options)
    expect(window.before).toEqual(comments.slice(0, 2))
    expect(window.after).toEqual(comments.slice(-8))
    expect(window.hiddenCount).toBe(90)
  })

  test('revealing retains chronological order and makes every report reachable', () => {
    const comments = Array.from({ length: 51 }, (_, index) => `${index}: ${'x'.repeat(2_000)}`)
    const initial = windowTimeline(comments, 0, options)
    const next = windowTimeline(comments, 10, options)
    expect(next.before).toEqual(comments.slice(0, initial.before.length + 10))
    expect(next.after).toEqual(initial.after)
    expect(next.hiddenCount).toBe(initial.hiddenCount - 10)
    expect(windowTimeline(comments, 100, options)).toEqual({ before: comments, hiddenCount: 0, after: [] })
  })

  test('one oversized report stays readable without duplication', () => {
    const comments = ['x'.repeat(30_000)]
    expect(windowTimeline(comments, 0, options)).toEqual({ before: comments, hiddenCount: 0, after: [] })
    expect(windowTimeline([], 0, options)).toEqual({ before: [], hiddenCount: 0, after: [] })
  })
})
