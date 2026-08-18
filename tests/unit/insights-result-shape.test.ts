import { describe, expect, test } from 'bun:test'
import type { MetricsQueryResult, MetricsSchema } from '../../src/shared/observability-types'
import {
  eventPoints,
  eventsWithinSelection,
  resultShape,
  toEventTable,
  type EventRow,
} from '../../src/renderer/components/insights/lib/result-shape'
import { isTurnResult } from '../../src/renderer/components/insights/lib/turn-rows'
import { volumeStats } from '../../src/renderer/components/insights/lib/volume'

// The result-shape model (docs/plans/observability.md): the server declares the
// grain, the client maps it to one of five renderings. These tests encode the
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
      kinds: ['turn'],
      internal: false,
      description: '',
      columns: [
        { name: 'started_at', type: 'number', description: '' },
        { name: 'duration_ms', type: 'duration', description: '' },
      ],
    },
    {
      view: 'events',
      kinds: ['tool_call', 'thinking'],
      internal: false,
      description: '',
      columns: [
        { name: 'kind', type: 'string', description: '' },
        { name: 'started_at', type: 'number', description: '' },
        { name: 'duration_ms', type: 'duration', description: '' },
        { name: 'provider_duration_ms', type: 'duration', description: '' },
        { name: 'command', type: 'string', description: '' },
        { name: 'status', type: 'string', description: '' },
      ],
    },
    {
      view: 'internal_events',
      kinds: ['internal.rpc'],
      internal: true,
      description: '',
      columns: [
        { name: 'started_at', type: 'number', description: '' },
        { name: 'duration_ms', type: 'duration', description: '' },
      ],
    },
  ],
  base: { table: 'spans', description: '', columns: [] },
  relationships: [],
}

describe('declared grain vs the legacy column sniff', () => {
  test('a declared turns grain with the turn columns is the turn listing', () => {
    const shaped = result(['trace_id', 'started_at'], [['tr_1', 1_000]], 'turns')
    expect(isTurnResult(shaped)).toBe(true)
    expect(resultShape(shaped, SCHEMA)).toEqual({ shape: 'turns' })
  })

  test('an event listing that selects trace_id is NOT read as turns — the misdetection the declared grain exists to fix', () => {
    const shaped = result(
      ['trace_id', 'span_id', 'kind', 'started_at', 'command', 'duration_ms'],
      [['tr_1', 'sp_1', 'tool_call', 1_000, 'bun run test', 420]],
      'events',
    )
    expect(isTurnResult(shaped)).toBe(false)
    expect(resultShape(shaped, SCHEMA)).toEqual({ shape: 'events', view: 'events', kind: 'tool_call' })
  })

  test('without a declared grain (an older host), the turn-column sniff still applies', () => {
    const legacy = result(['trace_id', 'started_at'], [['tr_1', 1_000]])
    expect(isTurnResult(legacy)).toBe(true)
    expect(resultShape(legacy, SCHEMA)).toEqual({ shape: 'turns' })
  })

  test('a declared non-turn grain without started_at falls through to the grid', () => {
    const rollup = result(['tool', 'calls', 'total_ms'], [['Bash', 4, 900]], 'events')
    expect(resultShape(rollup, SCHEMA).shape).toBe('table')
  })

  test('an events grain survives a missing schema — only the kind colour is lost', () => {
    const shaped = result(['started_at', 'duration_ms'], [[1_000, 5]], 'events')
    expect(resultShape(shaped, null)).toEqual({ shape: 'events', view: 'events', kind: '' })
  })
})

describe('the event kind the multi-kind view derives', () => {
  // `events` holds every child kind, so the answer itself names the listing:
  // one distinct kind value titles and colours it, a mix stays generic.
  test('a mixed-kind listing stays generic rather than wearing one kind\'s colour', () => {
    const shaped = result(
      ['kind', 'started_at'],
      [['tool_call', 1_000], ['thinking', 2_000]],
      'events',
    )
    expect(resultShape(shaped, SCHEMA)).toEqual({ shape: 'events', view: 'events', kind: '' })
  })

  test('without a kind column, a single-kind view still names its kind', () => {
    const shaped = result(['started_at', 'duration_ms'], [[1_000, 5]], 'internal_events')
    expect(resultShape(shaped, SCHEMA)).toEqual({
      shape: 'events',
      view: 'internal_events',
      kind: 'internal.rpc',
    })
  })

  test('without a kind column, the multi-kind view declares no kind', () => {
    const shaped = result(['started_at', 'duration_ms'], [[1_000, 5]], 'events')
    expect(resultShape(shaped, SCHEMA)).toEqual({ shape: 'events', view: 'events', kind: '' })
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
    'events',
  )
  const table = toEventTable(shaped, SCHEMA, 'events')

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

  test('a single-kind kind column is the title, not a cell; a mixed one stays visible', () => {
    const single = toEventTable(
      result(['kind', 'started_at'], [['tool_call', 1_000], ['tool_call', 2_000]], 'events'),
      SCHEMA,
      'events',
    )
    expect(single.columns.map((column) => column.name)).toEqual(['started_at'])
    const mixed = toEventTable(
      result(['kind', 'started_at'], [['tool_call', 1_000], ['thinking', 2_000]], 'events'),
      SCHEMA,
      'events',
    )
    expect(mixed.columns.map((column) => column.name)).toEqual(['kind', 'started_at'])
  })

  test('a result with no trace ids is not linkable', () => {
    const unlinked = toEventTable(
      result(['started_at', 'duration_ms'], [[1_000, 5]], 'events'),
      SCHEMA,
      'events',
    )
    expect(unlinked.linkable).toBe(false)
  })
})

describe('event points and the time brush', () => {
  const row = (overrides: Partial<EventRow>): EventRow => ({
    startedAt: 1_000,
    durationMs: 100,
    status: 'ok',
    traceId: null,
    spanId: null,
    cells: [],
    ...overrides,
  })

  // Spans are counted by the same histogram that counts turns, so they are
  // mapped into the same currency rather than summarised a second way.
  test('a span counts as a failure on error or interruption, and carries no cost', () => {
    const stats = volumeStats(eventPoints([row({ status: 'error' }), row({})]))
    expect(stats.failed).toBe(1)
    expect(stats.failureRate).toBe(0.5)
    expect(stats.p50DurationMs).toBe(100)
    expect(stats.totalCostUsd).toBeNull()
  })

  test('a span is placed at its own start time', () => {
    expect(eventPoints([row({ startedAt: 4_200 })])[0].at).toBe(4_200)
  })

  test('the brush is half-open, matching the turn list', () => {
    const rows = [row({ startedAt: 1_000 }), row({ startedAt: 2_000 }), row({ startedAt: 3_000 })]
    expect(eventsWithinSelection(rows, { from: 1_000, to: 3_000 })).toHaveLength(2)
    expect(eventsWithinSelection(rows, null)).toHaveLength(3)
  })
})
