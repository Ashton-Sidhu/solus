import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bucketAxisTicks,
  bucketCountForWidth,
  bucketPoints,
} from '@solus/workspace-ui/components/insights/lib/volume'
import { axisInstantFormat } from '@solus/workspace-ui/components/insights/lib/format'

const source = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/insights/VolumeChart.svelte'),
  'utf8',
)

describe('Insights volume chart interaction composition', () => {
  test('the main bars split volume by provider rather than completion status', () => {
    expect(source).toContain('bucket.claudeCode')
    expect(source).toContain('bucket.codex')
    expect(source).toContain('Claude Code')
    expect(source).toContain('Codex')
    expect(source).not.toContain('FAILED_FILL')
    expect(source).not.toContain('>failed</span>')
  })

  test('the chart owns both the brush and tooltip so drag events reach the brush layer', () => {
    expect(source).toContain('tooltipContext={{ mode: "band" }}')
    expect(source).toContain('brush={{')
    expect(source).toContain('onBrushEnd: ({ brush }) => applyBrush(brush)')
    expect(source).not.toContain('<BrushContext')
  })

  test('a completed brush zooms the plot and clears the transient selection rail', () => {
    expect(source).toContain('volumeViewport(from, to, selection)')
    expect(source).toContain('state.reset()')
    expect(source).toContain('{#key `${viewport.from}:${viewport.to}`}')
  })

  test('the transient brush uses a quiet outline instead of thick accent rails', () => {
    expect(source).toContain('handleSize: 1')
    expect(source).toContain('handle: "opacity-0"')
    expect(source).toContain('var(--solus-art-1)_8%')
    expect(source).not.toContain('var(--solus-art-5)_8%')
    expect(source).not.toContain('handle:\n              "!top-2.5')
  })
})

describe('Insights volume chart bucket density', () => {
  // What the width-derived count exists to protect: a bar is the same size in a
  // drawer and across a wide desktop. A fixed count made it a function of the
  // window, which is how 48 bars became 33px slabs at 1900px.
  test('a bar keeps its size as the plot widens', () => {
    for (const width of [420, 900, 1900]) {
      const slot = width / bucketCountForWidth(width)
      expect(slot).toBeGreaterThan(16)
      expect(slot).toBeLessThan(28)
    }
  })

  test('a very narrow plot stops subdividing rather than drawing hairlines', () => {
    expect(bucketCountForWidth(80)).toBe(16)
  })

  test('a very wide plot stops subdividing rather than out-resolving the cursor', () => {
    expect(bucketCountForWidth(12_000)).toBe(112)
  })

  test('an unmeasured plot falls back to the fixed count instead of collapsing', () => {
    expect(bucketCountForWidth(0)).toBe(48)
    expect(bucketCountForWidth(Number.NaN)).toBe(48)
  })

  test('the requested count is the count drawn, so the axis and the bars agree', () => {
    const buckets = bucketPoints([], 0, 60_000, 90)
    expect(buckets).toHaveLength(90)
    expect(buckets.at(-1)?.endAt).toBe(60_000)
  })
})

describe('Insights time axis labels', () => {
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR
  const at = Date.UTC(2026, 7, 11, 14, 3, 0)

  test('a sub-day window labels the clock alone', () => {
    expect(axisInstantFormat(6 * HOUR)(at)).toMatch(/^\d{2}:\d{2}$/)
  })

  test('a window of a few days keeps the day beside the clock', () => {
    expect(axisInstantFormat(2 * DAY)(at)).toMatch(/^\w+ \d+ \d{2}:\d{2}$/)
  })

  // The label's width is why: `Aug 11 00:19` is twice `Aug 11`, and the end
  // labels are what run off the plot and under the card's edge.
  test('a week-long window drops the clock, halving the label', () => {
    const long = axisInstantFormat(2 * DAY)(at)
    const short = axisInstantFormat(7 * DAY)(at)
    expect(short).not.toMatch(/\d{2}:\d{2}/)
    expect(short.length).toBeLessThan(long.length)
  })
})

describe('Insights volume chart axis ticks', () => {
  const from = Date.UTC(2026, 7, 17, 0, 0, 0)
  const to = Date.UTC(2026, 7, 18, 0, 0, 0)
  const buckets = bucketPoints([], from, to)

  test('every tick is a bucket start, so a label sits under the bar it names', () => {
    const starts = new Set(buckets.map((bucket) => bucket.at))
    for (const tick of bucketAxisTicks(buckets)) expect(starts.has(tick)).toBe(true)
  })

  test('the ticks span the window and stay in bar order', () => {
    const ticks = bucketAxisTicks(buckets)
    expect(ticks[0]).toBe(buckets[0].at)
    expect(ticks.at(-1)).toBe(buckets.at(-1)?.at)
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks)
  })

  test('a window with fewer buckets than ticks labels each one exactly once', () => {
    const few = buckets.slice(0, 3)
    expect(bucketAxisTicks(few)).toEqual(few.map((bucket) => bucket.at))
  })
})
