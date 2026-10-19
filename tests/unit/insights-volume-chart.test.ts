import { describe, expect, test } from 'bun:test'
import {
  bucketAxisTicks,
  bucketCountForWidth,
  bucketPoints,
  costAxisMax,
  countAxisTicks,
  providerTotals,
  rebucketVolume,
  stackGapUnits,
  stackedSegment,
  type VolumePoint,
} from '@solus/workspace-ui/components/insights/lib/volume'
import { axisInstantFormat, formatCost, formatCostTick } from '@solus/workspace-ui/components/insights/lib/format'


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

  test('responsive rebinning preserves every server aggregate', () => {
    const source = [
      { at: 0, endAt: 10, total: 3, claudeCode: 2, codex: 1, unknownProvider: 0, costUsd: 0.4, costedCount: 2 },
      { at: 10, endAt: 20, total: 5, claudeCode: 1, codex: 3, unknownProvider: 1, costUsd: 0.6, costedCount: 1 },
    ]
    const buckets = rebucketVolume(source, 0, 20, 1)
    expect(buckets).toEqual([{
      at: 0,
      endAt: 20,
      total: 8,
      claudeCode: 3,
      codex: 4,
      unknownProvider: 1,
      costUsd: 1,
      costedCount: 3,
    }])
  })
})

describe('Insights volume chart spend line', () => {
  const at = Date.UTC(2026, 7, 17, 0, 0, 0)
  const HOUR = 60 * 60 * 1000
  function point(offsetMs: number, provider: string, costUsd: number | null): VolumePoint {
    return { at: at + offsetMs, provider, failed: false, costUsd, durationMs: 1000 }
  }

  test('a bucket combines Claude and Codex spend and counts only costed rows', () => {
    // WHY: the spend line must represent every provider. A model without known
    // pricing can still leave the bucket partly costed, so the count prevents
    // uncosted work from looking free.
    const buckets = bucketPoints(
      [
        point(0, 'claude-code', 0.2),
        point(60_000, 'codex', 0.4),
        point(120_000, 'codex', null),
      ],
      at,
      at + HOUR,
      1,
    )
    expect(buckets[0].total).toBe(3)
    expect(buckets[0].costUsd).toBeCloseTo(0.6)
    expect(buckets[0].costedCount).toBe(2)
  })

  test('an answer that records no spend gets no axis, so no flat line along the baseline', () => {
    const buckets = bucketPoints([point(0, 'codex', null), point(60_000, 'codex', null)], at, at + HOUR, 4)
    expect(costAxisMax(buckets)).toBe(0)
  })

  test('the spend axis tops out on a round rung above the dearest bucket', () => {
    // WHY: the line shares the bars' plot and gets three labels. A raw peak
    // prints `$0.437` and pins the peak to the ceiling; a round rung above it
    // names the axis and keeps the peak inside the plot.
    const buckets = bucketPoints([point(0, 'claude-code', 0.437)], at, at + HOUR, 1)
    expect(costAxisMax(buckets)).toBe(0.5)
    expect(costAxisMax(bucketPoints([point(0, 'claude-code', 12)], at, at + HOUR, 1))).toBe(20)
    expect(costAxisMax(bucketPoints([point(0, 'claude-code', 1)], at, at + HOUR, 1))).toBe(1)
  })

  test('an axis tick drops the precision it did not measure', () => {
    expect(formatCostTick(0)).toBe('$0')
    expect(formatCostTick(0.25)).toBe('$0.25')
    expect(formatCostTick(20)).toBe('$20')
  })

  test('a spend figure is grouped from a thousand up', () => {
    // WHY: `$31351.49` in the stat line is read digit by digit; grouping is
    // what makes the magnitude readable at a glance.
    expect(formatCost(31351.49)).toBe('$31,351.49')
    expect(formatCost(0.437)).toBe('$0.437')
    expect(formatCostTick(5000)).toBe('$5,000')
  })
})

describe('Insights volume chart stacked segments', () => {
  // WHY: the gap is a pixel size the reader sees, but the bars are drawn in
  // rows; a 200px plot with a top of 100 rows has two rows to the pixel.
  test('the surface gap converts to the count axis\'s own units', () => {
    expect(stackGapUnits(100, 200)).toBe(1)
    expect(stackGapUnits(100, 0)).toBe(0)
    expect(stackGapUnits(0, 200)).toBe(0)
  })

  test('an upper segment is lifted off the one below by the gap', () => {
    expect(stackedSegment(10, 30, 1)).toEqual([11, 30])
  })

  test('a sliver too thin for the gap keeps its height rather than vanishing', () => {
    // WHY: a one-row segment drawn as a gap and nothing else says the bucket had
    // no such rows, and a lift larger than the segment is a negative rectangle.
    expect(stackedSegment(10, 11, 1)).toEqual([10, 11])
    expect(stackedSegment(10, 10, 1)).toEqual([10, 10])
  })
})

describe('Insights volume chart count axis', () => {
  test('every count rung is a whole row, so no two labels read the same', () => {
    // WHY: a top of 1 with a midpoint of 0.5 printed "0, 1, 1" down the axis.
    expect(countAxisTicks(1)).toEqual([0, 1])
    expect(countAxisTicks(0)).toEqual([0, 1])
    expect(countAxisTicks(3)).toEqual([0, 2, 4])
    expect(countAxisTicks(8)).toEqual([0, 4, 8])
    for (const tallest of [2, 5, 17, 101]) {
      const ticks = countAxisTicks(tallest)
      expect(ticks.every(Number.isInteger)).toBe(true)
      expect(ticks.at(-1)).toBeGreaterThanOrEqual(tallest)
    }
  })
})

describe('Insights volume chart provider breakdown', () => {
  test('the header counts each backend from the bars it sits above', () => {
    // WHY: the breakdown keys the bar colours; a count that disagreed with the
    // plot would name a split the reader cannot see.
    const at = Date.UTC(2026, 0, 1)
    const point = (offsetMs: number, provider: string, costUsd: number | null): VolumePoint => (
      { at: at + offsetMs, provider, failed: false, costUsd, durationMs: 1000 }
    )
    const buckets = bucketPoints(
      [point(0, 'claude-code', 1), point(60_000, 'codex', null), point(120_000, 'claude-code', null)],
      at,
      at + 60 * 60_000,
      4,
    )
    const totals = providerTotals(buckets)
    expect(totals).toEqual({ claudeCode: 2, codex: 1, unknownProvider: 0 })
    expect(totals.claudeCode + totals.codex + totals.unknownProvider).toBe(
      buckets.reduce((sum, bucket) => sum + bucket.total, 0),
    )
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
