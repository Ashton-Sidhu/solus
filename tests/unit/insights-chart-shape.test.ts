import { describe, expect, test } from 'bun:test'
import type { MetricsQueryResult, MetricsSchema } from '@solus/contracts/observability-types'
import {
  MAX_RANKING_BARS,
  MAX_TREND_SERIES,
  rankingChart,
  trendChart,
} from '@solus/workspace-ui/components/insights/lib/chart-shape'
import { resultShape } from '@solus/workspace-ui/components/insights/lib/result-shape'

// The two chart forms (docs/plans/observability.md). These tests encode what
// the chart is allowed to claim: a line may not join rows that differ in a
// dimension, may not cross a bucket nothing was measured in, and may not place
// a point anywhere but under the tick bearing its own label.

function result(
  columns: string[],
  rows: MetricsQueryResult['rows'],
  sourceView?: string,
): MetricsQueryResult {
  return sourceView === undefined ? { columns, rows } : { columns, rows, sourceView }
}

/** The chart forms never read the registry; a schema is passed only because
 *  `resultShape` takes one to decide the grain first. */
const SCHEMA: MetricsSchema = { views: [], base: { table: 'spans', description: '', columns: [] }, relationships: [] }

describe('trend detection', () => {
  test('a bucketed aggregate becomes a line over parsed bucket labels', () => {
    const shaped = result(
      ['day', 'p95_duration_ms'],
      [['2026-08-14', 900], ['2026-08-12', 700], ['2026-08-13', 800]],
    )
    const shape = resultShape(shaped, SCHEMA)
    expect(shape.shape).toBe('trend')
    if (shape.shape !== 'trend') return
    expect(shape.trend.mark).toBe('line')
    expect(shape.trend.valueFormat).toBe('duration')
    expect(shape.trend.seriesColumn).toBeNull()
    expect(shape.trend.lines).toHaveLength(1)
    // Sorted by time regardless of the query's own order.
    expect(shape.trend.lines[0].points.map((point) => point.value)).toEqual([700, 800, 900])
  })

  test('an undeclared span listing over raw spans becomes a scatter, not a grid', () => {
    const shaped = result(
      ['started_at', 'duration_ms', 'status'],
      [[2_000, 50, 'ok'], [1_000, 90, 'error']],
    )
    const shape = resultShape(shaped, SCHEMA)
    expect(shape.shape).toBe('trend')
    if (shape.shape !== 'trend') return
    expect(shape.trend.mark).toBe('points')
    // Status is a state, not a dimension: failures already wear the status
    // colour, so the scatter stays one series.
    expect(shape.trend.seriesColumn).toBeNull()
    expect(shape.trend.lines[0].points).toEqual([
      { at: 1_000, value: 90, failed: true, series: '' },
      { at: 2_000, value: 50, failed: false, series: '' },
    ])
  })

  test('a single point is not a trend', () => {
    const shaped = result(['day', 'avg_ms'], [['2026-08-14', 900]])
    expect(resultShape(shaped, SCHEMA).shape).toBe('table')
  })

  test('the series prefers a duration column over an earlier count', () => {
    const trend = trendChart(result(
      ['day', 'calls', 'avg_ms'],
      [['2026-08-12', 4, 700], ['2026-08-13', 6, 800]],
    ))
    expect(trend?.valueColumn).toBe('avg_ms')
    expect(trend?.valueFormat).toBe('duration')
  })

  test('id columns and rows without a parseable time or value are never charted', () => {
    const trend = trendChart(result(
      ['started_at', 'session_id', 'duration_ms'],
      [[1_000, 's_1', 40], [2_000, 's_2', null], [null, 's_3', 60]],
    ))
    expect(trend?.valueColumn).toBe('duration_ms')
    expect(trend?.seriesColumn).toBeNull()
    expect(trend?.lines[0].points).toEqual([{ at: 1_000, value: 40, failed: false, series: '' }])
  })

  test('a result with no numeric measure is a grid', () => {
    expect(trendChart(result(['started_at', 'command'], [[1_000, 'bun run test']]))).toBeNull()
  })
})

describe('the breakdown dimension a grouped result carries', () => {
  // The defect this encodes: `group by day, model` returns interleaved rows,
  // and one line through them joins one model's Monday to another's Tuesday.
  test('a grouped measure draws one line per dimension value, not one through all rows', () => {
    const shaped = result(
      ['day', 'model', 'token_spend_usd', 'turns'],
      [
        ['2026-08-17', 'claude-fable-5', 25.9, 3],
        ['2026-08-17', 'claude-opus-5', 15.0, 4],
        ['2026-08-18', 'claude-opus-5', 9.9, 2],
      ],
    )
    const shape = resultShape(shaped, SCHEMA)
    expect(shape.shape).toBe('trend')
    if (shape.shape !== 'trend') return
    expect(shape.trend.seriesColumn).toBe('model')
    expect(shape.trend.valueColumn).toBe('token_spend_usd')
    expect(shape.trend.lines.map((line) => line.label)).toEqual([
      'claude-fable-5',
      'claude-opus-5',
    ])
    expect(shape.trend.lines[1].points.map((point) => point.value)).toEqual([15.0, 9.9])
    // Each point names its own line, so the tooltip can say which it is.
    expect(shape.trend.lines[0].points[0].series).toBe('claude-fable-5')
  })

  test('two dimensions compose one series key — splitting by one would draw through the other', () => {
    const trend = trendChart(result(
      ['day', 'model', 'project', 'cost_usd'],
      [
        ['2026-08-17', 'opus', 'solus', 1],
        ['2026-08-17', 'opus', 'other', 2],
        ['2026-08-18', 'opus', 'solus', 3],
      ],
    ))
    expect(trend?.seriesColumn).toBe('model · project')
    expect(trend?.lines.map((line) => line.label)).toEqual(['opus · other', 'opus · solus'])
  })

  test('one distinct value is no breakdown at all — one line, no legend', () => {
    const trend = trendChart(result(
      ['day', 'model', 'cost_usd'],
      [['2026-08-17', 'opus', 1], ['2026-08-18', 'opus', 2]],
    ))
    expect(trend?.seriesColumn).toBeNull()
    expect(trend?.lines).toHaveLength(1)
    expect(trend?.lines[0].label).toBe('')
    expect(trend?.lines[0].points[0].series).toBe('')
  })

  test('more series than the ramp has hues: the biggest are drawn and the rest are counted, never dropped in silence', () => {
    const rows = Array.from({ length: MAX_TREND_SERIES + 2 }, (_, index) => [
      ['2026-08-17', `tool_${index}`, index + 1],
      ['2026-08-18', `tool_${index}`, index + 1],
    ]).flat()
    const trend = trendChart(result(['day', 'tool', 'calls'], rows))
    expect(trend?.lines).toHaveLength(MAX_TREND_SERIES)
    expect(trend?.hiddenSeries).toBe(2)
    // The two smallest totals are the ones left to the table.
    expect(trend?.lines.map((line) => line.label)).not.toContain('tool_0')
  })

  test('a scatter past the hue cap keeps every observation, unsplit — a cloud may not lose its tail', () => {
    // A line through mixed rows states a change nobody measured, so it pays the
    // cap; a scatter connects nothing, so dropping its points would be the only
    // lie in the picture.
    const rows = Array.from({ length: MAX_TREND_SERIES + 2 }, (_, index) => [
      index * 1_000,
      `tool_${index}`,
      index + 1,
    ])
    const trend = trendChart(result(['started_at', 'tool', 'duration_ms'], rows))
    expect(trend?.mark).toBe('points')
    expect(trend?.lines).toHaveLength(1)
    expect(trend?.seriesColumn).toBeNull()
    expect(trend?.hiddenSeries).toBe(0)
    expect(trend?.lines[0].points).toHaveLength(rows.length)
  })

  test('a line needs two points in the same series; isolated dots stay a grid', () => {
    const shaped = result(
      ['day', 'model', 'cost_usd'],
      [['2026-08-17', 'opus', 1], ['2026-08-18', 'fable', 2]],
    )
    expect(resultShape(shaped, SCHEMA).shape).toBe('table')
  })
})

describe('where a bucket label lands on the axis', () => {
  // A bucket label is wall-clock text, not an instant. `Date.parse` reads a
  // date-only string as UTC and a date-time string as local, so `day` buckets
  // used to sit under the previous evening's tick while `hour` buckets sat
  // where their label said. Both now read as local, so a point is always under
  // the tick that bears its own name.
  const localMidnight = (iso: string): number =>
    new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))).getTime()

  test('a day bucket lands on that local day, not the evening before', () => {
    const trend = trendChart(result(
      ['day', 'cost_usd'],
      [['2026-08-17', 1], ['2026-08-18', 2]],
    ))
    expect(trend?.lines[0].points[0].at).toBe(localMidnight('2026-08-17'))
  })

  test('hour and month buckets read by the same rule', () => {
    const hourly = trendChart(result(
      ['hour', 'cost_usd'],
      [['2026-08-17T14:00', 1], ['2026-08-17T15:00', 2]],
    ))
    expect(hourly?.lines[0].points[0].at).toBe(new Date(2026, 7, 17, 14, 0).getTime())
    const monthly = trendChart(result(
      ['month', 'cost_usd'],
      [['2026-07', 1], ['2026-08', 2]],
    ))
    expect(monthly?.lines[0].points[0].at).toBe(new Date(2026, 6, 1).getTime())
  })

  test('a label no bucket rule produces drops its row rather than landing anywhere', () => {
    // `strftime('%Y-%W')` week numbers, for one: not a date, and never a place.
    const trend = trendChart(result(
      ['week', 'cost_usd'],
      [['2026-33', 1], ['2026-08-17', 2], ['2026-08-18', 3]],
    ))
    expect(trend?.lines[0].points).toHaveLength(2)
  })
})

describe('which measure the chart draws', () => {
  // A result carries several measures and the chart draws one. The rule is
  // stated in the heading and overridable, because no preference order can know
  // which number the reader came for.
  const shaped = result(
    ['day', 'calls', 'avg_ms'],
    [['2026-08-12', 4, 700], ['2026-08-13', 6, 800]],
  )

  test('without a choice, a duration outranks an earlier count', () => {
    expect(trendChart(shaped)?.valueColumn).toBe('avg_ms')
  })

  test('the reader\'s choice wins, and every measure is offered', () => {
    const trend = trendChart(shaped, 'calls')
    expect(trend?.valueColumn).toBe('calls')
    expect(trend?.valueFormat).toBe('number')
    expect(trend?.lines[0].points.map((point) => point.value)).toEqual([4, 6])
    expect(trend?.measures).toEqual(['calls', 'avg_ms'])
  })

  test('a measure the answer does not carry falls back rather than charting nothing', () => {
    // What a re-run of a *different* question does with the previous pick.
    expect(trendChart(shaped, 'spend_usd')?.valueColumn).toBe('avg_ms')
  })

  test('the choice threads through the shape the page renders', () => {
    const shape = resultShape(shaped, SCHEMA, 'calls')
    expect(shape.shape).toBe('trend')
    if (shape.shape !== 'trend') return
    expect(shape.trend.valueColumn).toBe('calls')
  })
})

describe('where a line breaks', () => {
  // A GROUP BY returns no row for a bucket nothing happened in. A stroke across
  // that hole states a continuity nobody measured, so the line breaks and the
  // dots stay.
  const segmentLengths = (trend: ReturnType<typeof trendChart>): number[][] =>
    (trend?.lines ?? []).map((line) => line.segments.map((segment) => segment.length))

  test('consecutive days are one stroke; a missing day splits it', () => {
    const whole = trendChart(result(
      ['day', 'cost_usd'],
      [['2026-08-12', 1], ['2026-08-13', 2], ['2026-08-14', 3]],
    ))
    expect(segmentLengths(whole)).toEqual([[3]])
    const holed = trendChart(result(
      ['day', 'cost_usd'],
      [['2026-08-12', 1], ['2026-08-14', 3], ['2026-08-15', 4]],
    ))
    expect(segmentLengths(holed)).toEqual([[1, 2]])
  })

  test('a calendar step is not a constant — a month and a DST day still count as one bucket', () => {
    // 31, 28, and 31 days: arithmetic on a fixed month width would break this
    // line three times.
    const monthly = trendChart(result(
      ['month', 'cost_usd'],
      [['2026-01', 1], ['2026-02', 2], ['2026-03', 3], ['2026-04', 4]],
    ))
    expect(segmentLengths(monthly)).toEqual([[4]])
    // North American DST in 2026: Mar 8 is 23 hours long, Nov 1 is 25.
    const springForward = trendChart(result(
      ['day', 'cost_usd'],
      [['2026-03-07', 1], ['2026-03-08', 2], ['2026-03-09', 3]],
    ))
    expect(segmentLengths(springForward)).toEqual([[3]])
    const fallBack = trendChart(result(
      ['day', 'cost_usd'],
      [['2026-10-31', 1], ['2026-11-01', 2], ['2026-11-02', 3]],
    ))
    expect(segmentLengths(fallBack)).toEqual([[3]])
  })

  test('an aliased bucket infers its step from the points, with slack', () => {
    // `… as bucket` names no width, so the most common gap is the step. Three
    // points are the fewest that can show one.
    const hourly = trendChart(result(
      ['bucket', 'cost_usd'],
      [
        ['2026-08-12T01:00', 1],
        ['2026-08-12T02:00', 2],
        ['2026-08-12T03:00', 3],
        ['2026-08-12T09:00', 4],
      ],
    ))
    expect(segmentLengths(hourly)).toEqual([[3, 1]])
  })

  test('each series breaks on its own holes, not its neighbour\'s', () => {
    const trend = trendChart(result(
      ['day', 'model', 'cost_usd'],
      [
        ['2026-08-12', 'opus', 1], ['2026-08-13', 'opus', 2], ['2026-08-14', 'opus', 3],
        ['2026-08-12', 'fable', 1], ['2026-08-14', 'fable', 3],
      ],
    ))
    expect(trend?.lines.map((line) => line.label)).toEqual(['fable', 'opus'])
    expect(segmentLengths(trend)).toEqual([[1, 1], [3]])
  })

  test('a scatter has no line to break', () => {
    const scatter = trendChart(result(
      ['started_at', 'duration_ms'],
      [[1_000, 40], [900_000_000, 50]],
    ))
    expect(segmentLengths(scatter)).toEqual([[2]])
  })
})

describe('a rollup with no time column is a ranking', () => {
  // What six of the eight shipped presets return: one dimension, several
  // measures, ordered by the one the question was about.
  const slowestTools = result(
    ['tool', 'calls', 'avg_ms', 'total_ms'],
    [
      ['Bash', 12, 900, 10_800],
      ['Edit', 30, 120, 3_600],
      ['Read', 40, 20, 800],
    ],
  )

  test('the bars measure what the query ordered by, not the first numeric column', () => {
    const ranking = rankingChart(slowestTools)
    expect(ranking?.valueColumn).toBe('total_ms')
    expect(ranking?.valueFormat).toBe('duration')
    expect(ranking?.dimensionColumn).toBe('tool')
    expect(ranking?.bars).toEqual([
      { label: 'Bash', value: 10_800 },
      { label: 'Edit', value: 3_600 },
      { label: 'Read', value: 800 },
    ])
  })

  test('the query\'s own order is kept — re-sorting would answer another question', () => {
    const unsorted = result(
      ['tool', 'total_ms'],
      [['Edit', 3_600], ['Bash', 10_800], ['Read', 800]],
    )
    expect(rankingChart(unsorted)?.bars.map((bar) => bar.label)).toEqual(['Edit', 'Bash', 'Read'])
  })

  test('several monotonic measures: the last wins, because a query ranks by what it names last', () => {
    // `calls` descends too, and both are consistent with the row order.
    expect(rankingChart(slowestTools)?.measures).toEqual(['calls', 'avg_ms', 'total_ms'])
    expect(rankingChart(slowestTools)?.valueColumn).toBe('total_ms')
  })

  test('where no column is monotonic, the order says nothing and preference decides', () => {
    const ambiguous = result(
      ['tool', 'calls', 'avg_ms'],
      [['Bash', 30, 500], ['Edit', 10, 900], ['Read', 20, 100]],
    )
    expect(rankingChart(ambiguous)?.valueColumn).toBe('avg_ms')
    expect(rankingChart(ambiguous, 'calls')?.valueColumn).toBe('calls')
  })

  test('a time column keeps it a trend; the page asks for the trend first', () => {
    const overTime = result(['day', 'tool', 'calls'], [['2026-08-12', 'Bash', 1]])
    expect(rankingChart(overTime)).toBeNull()
    expect(resultShape(slowestTools, SCHEMA).shape).toBe('ranking')
  })

  test('one bar is a number, and a result with no dimension is a grid', () => {
    expect(rankingChart(result(['tool', 'calls'], [['Bash', 4]]))).toBeNull()
    expect(rankingChart(result(['calls', 'errors'], [[4, 1], [9, 2]]))).toBeNull()
  })

  test('bars past the cut are counted, never dropped in silence', () => {
    const many = Array.from({ length: MAX_RANKING_BARS + 3 }, (_, index) => [
      `tool_${index}`,
      100 - index,
    ])
    const ranking = rankingChart(result(['tool', 'calls'], many))
    expect(ranking?.bars).toHaveLength(MAX_RANKING_BARS)
    expect(ranking?.hiddenBars).toBe(3)
  })
})
