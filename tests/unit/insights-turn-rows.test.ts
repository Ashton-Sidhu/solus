import { describe, expect, test } from 'bun:test'
import type { MetricsQueryResult } from '../../src/shared/observability-types'
import {
  countByStatus,
  groupBySession,
  isTurnResult,
  p95Duration,
  sortTurns,
  toTurnRows,
  withStatus,
  type TurnRow,
} from '../../src/renderer/components/insights/lib/turn-rows'
import {
  bucketPoints,
  pointExtent,
  turnPoints,
  volumeStats,
  volumeViewport,
  volumeWindow,
  withinSelection,
  VOLUME_BUCKETS,
} from '../../src/renderer/components/insights/lib/volume'

// The console runs whatever SQL the user wrote, so the explore page cannot
// assume a shape. These tests encode the rule that decides between the rich
// turn list and the plain result table, and the row mapping the list depends on.

function result(columns: string[], rows: MetricsQueryResult['rows']): MetricsQueryResult {
  return { columns, rows }
}

const TURN_COLUMNS = [
  'trace_id',
  'session_id',
  'started_at',
  'duration_ms',
  'status',
  'model',
  'cost_usd',
  'input_tokens',
  'output_tokens',
]

function turnRow(overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    traceId: 'tr_1',
    sessionId: 's_1',
    startedAt: 1_000,
    durationMs: 500,
    status: 'ok',
    model: 'claude-fable-5',
    provider: 'claude',
    origin: 'typed',
    promptSource: 'typed',
    prompt: 'hello',
    costUsd: 0.5,
    inputTokens: 10,
    outputTokens: 20,
    toolCallCount: 1,
    ...overrides,
  }
}

describe('turn-shape detection', () => {
  test('a grouped rollup is not read as turns, so it renders as a table', () => {
    expect(isTurnResult(result(['model', 'turns', 'avg_ms'], [['claude-fable-5', 3, 900]]))).toBe(false)
  })

  test('a listing carrying trace_id and started_at is read as turns', () => {
    expect(isTurnResult(result(TURN_COLUMNS, []))).toBe(true)
  })

  test('a result the query never returned is not turns', () => {
    expect(isTurnResult(null)).toBe(false)
  })
})

describe('toTurnRows', () => {
  test('maps cells by column name, not position, so column order is free', () => {
    const rows = toTurnRows(
      result(
        ['status', 'started_at', 'trace_id', 'duration_ms'],
        [['error', 1_700_000_000_000, 'tr_a', 1_234]],
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ traceId: 'tr_a', startedAt: 1_700_000_000_000, durationMs: 1_234, status: 'error' })
  })

  test('a row with no start time is dropped: it cannot be placed or ordered', () => {
    const rows = toTurnRows(result(TURN_COLUMNS.slice(0, 3), [['tr_a', 's_1', null]]))
    expect(rows).toHaveLength(0)
  })

  test('a null duration stays null rather than becoming zero', () => {
    const rows = toTurnRows(result(['trace_id', 'started_at', 'duration_ms'], [['tr_a', 5, null]]))
    expect(rows[0].durationMs).toBeNull()
  })
})

describe('sorting and grouping', () => {
  const rows = [
    turnRow({ traceId: 'a', startedAt: 300, durationMs: 100, sessionId: 's_1' }),
    turnRow({ traceId: 'b', startedAt: 100, durationMs: 900, sessionId: 's_2' }),
    turnRow({ traceId: 'c', startedAt: 200, durationMs: null, sessionId: 's_1' }),
  ]

  test('descending duration puts the slowest first and unknowns last', () => {
    const sorted = sortTurns(rows, { key: 'durationMs', dir: 'desc' })
    expect(sorted.map((row) => row.traceId)).toEqual(['b', 'a', 'c'])
  })

  test('groups follow the sorted order rather than imposing a second one', () => {
    const sorted = sortTurns(rows, { key: 'startedAt', dir: 'asc' })
    expect(groupBySession(sorted).map((group) => group.sessionId)).toEqual(['s_2', 's_1'])
  })

  test("a session heading uses the session's first turn, independent of table sort", () => {
    const group = groupBySession([
      turnRow({ traceId: 'latest', sessionId: 's_1', startedAt: 300, prompt: 'Third turn' }),
      turnRow({ traceId: 'first', sessionId: 's_1', startedAt: 100, prompt: 'First turn' }),
      turnRow({ traceId: 'middle', sessionId: 's_1', startedAt: 200, prompt: 'Second turn' }),
    ])[0]

    expect(group.firstPrompt).toBe('First turn')
  })

  test('a group sums only the durations it observed', () => {
    const group = groupBySession(rows).find((candidate) => candidate.sessionId === 's_1')
    expect(group?.totalDurationMs).toBe(100)
    expect(group?.turns).toHaveLength(2)
  })

  test('cost stays null for a session where no turn reported one (Codex)', () => {
    const group = groupBySession([turnRow({ costUsd: null })])[0]
    expect(group.totalCostUsd).toBeNull()
  })
})

describe('status counts and p95', () => {
  test('interrupted turns are counted apart from failures', () => {
    const counts = countByStatus([
      turnRow({ status: 'ok' }),
      turnRow({ status: 'error' }),
      turnRow({ status: 'interrupted' }),
      turnRow({ status: 'error' }),
    ])
    expect(counts).toEqual({ ok: 1, error: 2, interrupted: 1 })
  })

  test('p95 is withheld below four samples, where it would be noise', () => {
    expect(p95Duration([turnRow(), turnRow(), turnRow()])).toBeNull()
  })

  test('p95 reads from the durations that exist', () => {
    const rows = [100, 200, 300, 400, 5_000].map((ms) => turnRow({ durationMs: ms }))
    expect(p95Duration(rows)).toBe(5_000)
  })
})

describe('the status filter the listing and the histogram share', () => {
  const rows = [
    turnRow({ traceId: 'a', status: 'ok' }),
    turnRow({ traceId: 'b', status: 'error' }),
    turnRow({ traceId: 'c', status: 'interrupted' }),
  ]

  test('no filter is every row, not an empty set', () => {
    expect(withStatus(rows, null)).toEqual(rows)
  })

  // The chips sit under the bars that count the same answer. A filter the
  // reader can see and a chart that ignores it misstates what is being counted.
  test('the histogram counts exactly what the filtered listing shows', () => {
    const filtered = withStatus(rows, 'error')
    expect(filtered.map((row) => row.traceId)).toEqual(['b'])
    expect(turnPoints(filtered)).toHaveLength(1)
  })

  test('interrupted is its own filter, never folded into failures', () => {
    expect(withStatus(rows, 'interrupted').map((row) => row.traceId)).toEqual(['c'])
  })
})

describe('histogram bucketing', () => {
  const from = 0
  const to = 48_000

  test('turns land in the bucket covering their start time', () => {
    const buckets = bucketPoints(turnPoints([turnRow({ startedAt: 1_500 })]), from, to)
    expect(buckets).toHaveLength(VOLUME_BUCKETS)
    expect(buckets[1].total).toBe(1)
    expect(buckets[0].total).toBe(0)
  })

  test('turns outside the window are not folded into the edge buckets', () => {
    const buckets = bucketPoints(
      turnPoints([turnRow({ startedAt: -5_000 }), turnRow({ startedAt: 60_000 })]),
      from,
      to,
    )
    expect(buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(0)
  })

  test('each bucket splits its rows by provider and keeps unknown history visible', () => {
    const buckets = bucketPoints(
      turnPoints([
        turnRow({ startedAt: 100, provider: 'claude-code' }),
        turnRow({ startedAt: 200, provider: 'codex' }),
        turnRow({ startedAt: 300, provider: null }),
      ]),
      from,
      to,
    )
    expect(buckets[0]).toMatchObject({
      total: 3,
      claudeCode: 1,
      codex: 1,
      unknownProvider: 1,
    })
  })

  test('a brush selection is half-open, so adjacent buckets never double-count', () => {
    const rows = [turnRow({ startedAt: 1_000 }), turnRow({ startedAt: 2_000 })]
    expect(withinSelection(rows, { from: 1_000, to: 2_000 })).toHaveLength(1)
  })
})

describe('histogram zoom', () => {
  test('the selected time slice becomes the visible chart window', () => {
    expect(volumeViewport(0, 48_000, { from: 12_000, to: 18_000 })).toEqual({
      from: 12_000,
      to: 18_000,
    })
  })

  test('clearing the selection restores the full chart window', () => {
    expect(volumeViewport(0, 48_000, null)).toEqual({ from: 0, to: 48_000 })
  })

  test('a stale selection cannot hide the chart', () => {
    expect(volumeViewport(0, 48_000, { from: 60_000, to: 70_000 })).toEqual({
      from: 0,
      to: 48_000,
    })
  })
})

describe('volumeStats', () => {
  test('spend is null when no turn reported a cost, never zero', () => {
    expect(volumeStats(turnPoints([turnRow({ costUsd: null })])).totalCostUsd).toBeNull()
  })

  test('spend sums only the turns that reported one', () => {
    const stats = volumeStats(turnPoints([turnRow({ costUsd: 0.25 }), turnRow({ costUsd: null })]))
    expect(stats.totalCostUsd).toBeCloseTo(0.25)
  })

  test('failure rate covers errors and interruptions', () => {
    const stats = volumeStats(
      turnPoints([
        turnRow({ status: 'ok' }),
        turnRow({ status: 'error' }),
        turnRow({ status: 'interrupted' }),
        turnRow({ status: 'ok' }),
      ]),
    )
    expect(stats.failureRate).toBeCloseTo(0.5)
  })
})

// The histogram counts whatever the answer lists, so it must be able to draw a
// window the selected range does not describe — without dropping the newest row
// off the edge of its own extent.
describe('the window the bars are drawn across', () => {
  test('the range is kept while it contains every counted row', () => {
    const points = turnPoints([turnRow({ startedAt: 1_500 }), turnRow({ startedAt: 3_000 })])
    expect(volumeWindow(points, 0, 10_000)).toEqual({ from: 0, to: 10_000, coversRange: true })
  })

  test('a result reaching outside the range is drawn across its own extent', () => {
    const points = turnPoints([turnRow({ startedAt: -5_000 }), turnRow({ startedAt: 1_000 })])
    const window = volumeWindow(points, 0, 10_000)
    expect(window.coversRange).toBe(false)
    expect(window.from).toBe(-5_000)
  })

  test('the newest row is inside its own extent, not past the last bucket', () => {
    const points = turnPoints([turnRow({ startedAt: 0 }), turnRow({ startedAt: 47_000 })])
    const extent = pointExtent(points)!
    const buckets = bucketPoints(points, extent.from, extent.to)
    expect(buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(2)
  })

  test('rows sharing one instant still get a window with width', () => {
    const extent = pointExtent(turnPoints([turnRow({ startedAt: 5_000 })]))!
    expect(extent.to).toBeGreaterThan(extent.from)
  })
})
