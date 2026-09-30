import { describe, expect, test } from 'bun:test'
import type { MetricsSpan, MetricsTurnTrace } from '@solus/contracts/observability-types'
import { coverageReadings } from '@solus/workspace-ui/components/insights/lib/coverage-readings'
import { buildTraceView } from '@solus/workspace-ui/components/insights/lib/waterfall'

// The bar above the waterfall shows one reading at a time, chosen from the
// Trace header menu. These tests hold the rule that decides what the menu
// offers: a reading the record cannot answer is not in it, so the reader never
// opens an empty bar.

function span(overrides: Partial<MetricsSpan> & Pick<MetricsSpan, 'spanId' | 'startedAt'>): MetricsSpan {
  return {
    parentSpanId: 'root',
    traceId: 'tr_1',
    kind: 'tool_call',
    name: 'Bash',
    service: 'solus.sessions',
    sessionId: 's_1',
    provider: 'claude-code',
    model: 'claude-opus-5-5',
    projectRoot: '/repo',
    origin: 'typed',
    endedAt: overrides.startedAt + 100,
    durationMs: 100,
    status: 'ok',
    attrs: {},
    ...overrides,
  }
}

function rootOf(attrs: MetricsSpan['attrs'] = {}): MetricsSpan {
  return span({
    spanId: 'root',
    parentSpanId: null,
    kind: 'turn',
    name: 'turn',
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    attrs,
  })
}

function readingsFor(root: MetricsSpan, spans: MetricsSpan[]) {
  const trace: MetricsTurnTrace = { traceId: 'tr_1', spans: [root, ...spans], logEvents: [], providerWaitMs: null, gapSegments: [] }
  return coverageReadings(root, buildTraceView(trace)!)
}

const thinking = span({ spanId: 'think', kind: 'thinking', startedAt: 1_000, endedAt: 1_300, durationMs: 300 })
const streaming = span({ spanId: 'stream', kind: 'response_stream', startedAt: 1_300, endedAt: 1_400, durationMs: 100 })

describe('coverage readings', () => {
  test('span kind leads, then waiting on, then cost', () => {
    const readings = readingsFor(rootOf({ costUsd: 0.4 }), [thinking, streaming])
    expect(readings.map((reading) => reading.id)).toEqual(['kind', 'waiting', 'cost'])
  })

  test('a turn that reported no cost offers no cost reading', () => {
    // WHY: a Cost choice over an empty bar reads as "this turn was free".
    const readings = readingsFor(rootOf(), [thinking, streaming])
    expect(readings.map((reading) => reading.id)).not.toContain('cost')
  })

  test('the cost reading splits the reported cost by thinking and streaming time', () => {
    const cost = readingsFor(rootOf({ costUsd: 0.4 }), [thinking, streaming]).find(
      (reading) => reading.id === 'cost',
    )!
    expect(cost.entries.map((entry) => [entry.key, entry.share])).toEqual([
      ['thinking', 0.75],
      ['response_stream', 0.25],
    ])
    // An estimate is labelled one, in the key as well as the menu.
    expect(cost.entries[0]?.value.startsWith('≈')).toBe(true)
    expect(cost.note).toContain('of')
  })
})
