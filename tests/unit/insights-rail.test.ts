import { describe, expect, test } from 'bun:test'
import {
  railIndexOf,
  railItemsFromEvents,
  railItemsFromTurns,
} from '@solus/workspace-ui/components/insights/lib/rail'
import type {
  EventColumn,
  EventRow,
} from '@solus/workspace-ui/components/insights/lib/result-shape'
import type { TurnRow } from '@solus/workspace-ui/components/insights/lib/turn-rows'

// The rail is the list that stays beside an open turn. Its items must carry the
// drill identity the panel navigates by — the trace, and the span when the
// listing is span-grained — or clicking and stepping would land on the wrong
// row, which is the whole reason the rail exists.

function turn(traceId: string, overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    traceId,
    sessionId: null,
    startedAt: 1_755_000_000_000,
    durationMs: 1200,
    status: 'ok',
    model: 'claude-opus-5',
    provider: 'claude',
    origin: null,
    promptSource: null,
    prompt: 'fix the flaky test',
    costUsd: 0.12,
    inputTokens: 100,
    outputTokens: 50,
    toolCallCount: 3,
    ...overrides,
  }
}

const EVENT_COLUMNS: EventColumn[] = [
  { name: 'started_at', format: 'time', numeric: true },
  { name: 'tool_name', format: 'raw', numeric: false },
  { name: 'duration_ms', format: 'duration', numeric: true },
]

function event(
  traceId: string | null,
  spanId: string | null,
  toolName: string | null,
): EventRow {
  return {
    startedAt: 1_755_000_000_000,
    durationMs: 800,
    status: 'ok',
    traceId,
    spanId,
    cells: [1_755_000_000_000, toolName, 800],
  }
}

describe('rail items', () => {
  test('a turn item drills by its trace alone', () => {
    const items = railItemsFromTurns([
      turn('tr_a', { model: 'gpt-5.6-sol' }),
      turn('tr_b', { status: 'error' }),
    ])
    expect(items.map((item) => item.traceId)).toEqual(['tr_a', 'tr_b'])
    expect(items.every((item) => item.spanId === null)).toBe(true)
    expect(items[1].status).toBe('error')
    expect(items[0].title).toBe('fix the flaky test')
    // Model ids stay identical to the query value on every Insights surface.
    expect(items[0].metaLabel).toStartWith('gpt-5.6-sol · ')
  })

  test('an event item keeps the span it must land on', () => {
    const items = railItemsFromEvents(
      EVENT_COLUMNS,
      [event('tr_a', 'sp_1', 'Bash'), event('tr_a', 'sp_2', 'Read')],
      'tool_call',
    )
    expect(items.map((item) => item.spanId)).toEqual(['sp_1', 'sp_2'])
    // Two spans of one trace are two distinct rail rows.
    expect(new Set(items.map((item) => item.key)).size).toBe(2)
    expect(items[0].title).toBe('Bash')
  })

  test('an event row without a trace cannot open the panel, so it stays off the rail', () => {
    const items = railItemsFromEvents(EVENT_COLUMNS, [event(null, null, 'Bash')], 'tool_call')
    expect(items).toEqual([])
  })

  test('an event with no text cell is named by its kind', () => {
    const items = railItemsFromEvents(EVENT_COLUMNS, [event('tr_a', 'sp_1', null)], 'tool_call')
    expect(items[0].title).toBe('tool_call')
  })
})

describe('railIndexOf', () => {
  test('a turn-grained rail matches the open trace regardless of the landed span', () => {
    const items = railItemsFromTurns([turn('tr_a'), turn('tr_b')])
    expect(railIndexOf(items, 'tr_b', null)).toBe(1)
    // Deep-linked onto a span: the turn row still owns the position.
    expect(railIndexOf(items, 'tr_b', 'sp_9')).toBe(1)
  })

  test('a span-grained rail matches the exact span, so stepping moves span by span', () => {
    const items = railItemsFromEvents(
      EVENT_COLUMNS,
      [event('tr_a', 'sp_1', 'Bash'), event('tr_a', 'sp_2', 'Read')],
      'tool_call',
    )
    expect(railIndexOf(items, 'tr_a', 'sp_2')).toBe(1)
    // A panel opened on the turn alone sits at the trace's first span.
    expect(railIndexOf(items, 'tr_a', null)).toBe(0)
  })

  test('a turn the list no longer shows has no position', () => {
    expect(railIndexOf(railItemsFromTurns([turn('tr_a')]), 'tr_gone', null)).toBe(-1)
    expect(railIndexOf([], 'tr_a', null)).toBe(-1)
  })
})
