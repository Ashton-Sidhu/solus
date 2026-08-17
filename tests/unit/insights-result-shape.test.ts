import { describe, expect, test } from 'bun:test'
import type { MetricsQueryResult, MetricsSchema } from '../../src/shared/observability-types'
import {
  eventStats,
  eventsWithinSelection,
  resultShape,
  toEventTable,
  trendSeries,
  type EventRow,
} from '../../src/renderer/components/insights/lib/result-shape'
import { isTurnResult } from '../../src/renderer/components/insights/lib/turn-rows'

// The result-shape model (docs/plans/observability.md): the server declares the
// grain, the client maps it to one of four renderings. These tests encode the
// rules that decide the mapping — most importantly that a declared grain is
// authoritative, so a span listing can never masquerade as a turn listing
// however turn-shaped its columns look.

function result(
  columns: string[],
  rows: MetricsQueryResult['rows'],
  sourceView?: string,
): MetricsQueryResult {
  return sourceView === undefined ? { columns, rows } : { columns, rows, sourceView }
}

const SCHEMA: MetricsSchema = {
  views: [
    {
      view: 'turns',
      kind: 'turn',
      internal: false,
      description: '',
      columns: [
        { name: 'started_at', type: 'number', description: '' },
        { name: 'duration_ms', type: 'duration', description: '' },
      ],
    },
    {
      view: 'tool_calls',
      kind: 'tool_call',
      internal: false,
      description: '',
      columns: [
        { name: 'started_at', type: 'number', description: '' },
        { name: 'duration_ms', type: 'duration', description: '' },
        { name: 'provider_duration_ms', type: 'duration', description: '' },
        { name: 'command', type: 'string', description: '' },
        { name: 'status', type: 'string', description: '' },
      ],
    },
  ],
}

describe('declared grain vs the legacy column sniff', () => {
  test('a declared turns grain with the turn columns is the turn listing', () => {
    const shaped = result(['trace_id', 'started_at'], [['tr_1', 1_000]], 'turns')
    expect(isTurnResult(shaped)).toBe(true)
    expect(resultShape(shaped, SCHEMA)).toEqual({ shape: 'turns' })
  })

  test('a tool-call listing that selects trace_id is NOT read as turns — the misdetection the declared grain exists to fix', () => {
    const shaped = result(
      ['trace_id', 'span_id', 'started_at', 'command', 'duration_ms'],
      [['tr_1', 'sp_1', 1_000, 'bun run test', 420]],
      'tool_calls',
    )
    expect(isTurnResult(shaped)).toBe(false)
    expect(resultShape(shaped, SCHEMA)).toEqual({ shape: 'events', view: 'tool_calls', kind: 'tool_call' })
  })

  test('without a declared grain (an older host), the turn-column sniff still applies', () => {
    const legacy = result(['trace_id', 'started_at'], [['tr_1', 1_000]])
    expect(isTurnResult(legacy)).toBe(true)
    expect(resultShape(legacy, SCHEMA)).toEqual({ shape: 'turns' })
  })

  test('a declared non-turn grain without started_at falls through to the grid', () => {
    const rollup = result(['tool', 'calls', 'total_ms'], [['Bash', 4, 900]], 'tool_calls')
    expect(resultShape(rollup, SCHEMA).shape).toBe('table')
  })

  test('an events grain survives a missing schema — only the kind colour is lost', () => {
    const shaped = result(['started_at', 'duration_ms'], [[1_000, 5]], 'tool_calls')
    expect(resultShape(shaped, null)).toEqual({ shape: 'events', view: 'tool_calls', kind: '' })
  })
})

describe('trend detection', () => {
  test('a bucketed aggregate becomes a line over parsed bucket labels', () => {
    const shaped = result(
      ['day', 'p95_duration_ms'],
      [['2026-08-14', 900], ['2026-08-12', 700], ['2026-08-13', 800]],
    )
    const shape = resultShape(shaped, SCHEMA)
    expect(shape.shape).toBe('trend')
    if (shape.shape !== 'trend') return
    expect(shape.series.mark).toBe('line')
    expect(shape.series.valueFormat).toBe('duration')
    // Sorted by time regardless of the query's own order.
    expect(shape.series.points.map((point) => point.value)).toEqual([700, 800, 900])
  })

  test('an undeclared span listing over raw spans becomes a scatter, not a grid', () => {
    const shaped = result(
      ['started_at', 'duration_ms', 'status'],
      [[2_000, 50, 'ok'], [1_000, 90, 'error']],
    )
    const shape = resultShape(shaped, SCHEMA)
    expect(shape.shape).toBe('trend')
    if (shape.shape !== 'trend') return
    expect(shape.series.mark).toBe('points')
    expect(shape.series.points).toEqual([
      { at: 1_000, value: 90, failed: true },
      { at: 2_000, value: 50, failed: false },
    ])
  })

  test('a single point is not a trend', () => {
    const shaped = result(['day', 'avg_ms'], [['2026-08-14', 900]])
    expect(resultShape(shaped, SCHEMA).shape).toBe('table')
  })

  test('the series prefers a duration column over an earlier count', () => {
    const series = trendSeries(result(
      ['day', 'calls', 'avg_ms'],
      [['2026-08-12', 4, 700], ['2026-08-13', 6, 800]],
    ))
    expect(series?.valueColumn).toBe('avg_ms')
    expect(series?.valueFormat).toBe('duration')
  })

  test('id columns and rows without a parseable time or value are never charted', () => {
    const series = trendSeries(result(
      ['started_at', 'session_id', 'duration_ms'],
      [[1_000, 's_1', 40], [2_000, 's_2', null], [null, 's_3', 60]],
    ))
    expect(series?.valueColumn).toBe('duration_ms')
    expect(series?.points).toEqual([{ at: 1_000, value: 40, failed: false }])
  })

  test('a result with no numeric measure is a grid', () => {
    expect(trendSeries(result(['started_at', 'command'], [[1_000, 'bun run test']]))).toBeNull()
  })
})

describe('the event table', () => {
  const shaped = result(
    ['span_id', 'trace_id', 'started_at', 'command', 'duration_ms', 'status'],
    [
      ['sp_1', 'tr_1', 1_000, 'bun run test', 420, 'ok'],
      ['sp_2', 'tr_2', 2_000, 'bun run test', 900, 'error'],
      ['sp_3', null, 3_000, 'bun run build', null, 'unknown'],
      ['sp_4', 'tr_4', null, 'dropped: no start time', 5, 'ok'],
    ],
    'tool_calls',
  )
  const table = toEventTable(shaped, SCHEMA, 'tool_calls')

  test('identity columns are link data, not cells', () => {
    expect(table.columns.map((column) => column.name)).toEqual([
      'started_at', 'command', 'duration_ms', 'status',
    ])
    expect(table.rows[0].cells).toEqual([1_000, 'bun run test', 420, 'ok'])
  })

  test('formats come from the registry and the column names', () => {
    expect(table.columns.map((column) => column.format)).toEqual([
      'time', 'raw', 'duration', 'status',
    ])
  })

  test('rows carry their waterfall link, and rows without a start time are dropped', () => {
    expect(table.rows).toHaveLength(3)
    expect(table.rows[0]).toMatchObject({ traceId: 'tr_1', spanId: 'sp_1', startedAt: 1_000 })
    expect(table.rows[2].traceId).toBeNull()
    expect(table.linkable).toBe(true)
  })

  test('a result with no trace ids is not linkable', () => {
    const unlinked = toEventTable(
      result(['started_at', 'duration_ms'], [[1_000, 5]], 'tool_calls'),
      SCHEMA,
      'tool_calls',
    )
    expect(unlinked.linkable).toBe(false)
  })
})

describe('event stats and the time brush', () => {
  const row = (overrides: Partial<EventRow>): EventRow => ({
    startedAt: 1_000,
    durationMs: 100,
    status: 'ok',
    traceId: null,
    spanId: null,
    cells: [],
    ...overrides,
  })

  test('failure rate counts errors and interruptions; p95 needs enough durations to mean anything', () => {
    const few = eventStats([row({ status: 'error' }), row({})])
    expect(few.failed).toBe(1)
    expect(few.failureRate).toBe(0.5)
    expect(few.p50DurationMs).toBe(100)
    expect(few.p95DurationMs).toBeNull()

    const many = eventStats([10, 20, 30, 40, 1000].map((durationMs) => row({ durationMs })))
    expect(many.p95DurationMs).toBe(1000)
  })

  test('the brush is half-open, matching the turn list', () => {
    const rows = [row({ startedAt: 1_000 }), row({ startedAt: 2_000 }), row({ startedAt: 3_000 })]
    expect(eventsWithinSelection(rows, { from: 1_000, to: 3_000 })).toHaveLength(2)
    expect(eventsWithinSelection(rows, null)).toHaveLength(3)
  })
})
