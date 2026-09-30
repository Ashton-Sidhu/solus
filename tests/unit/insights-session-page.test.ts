import { describe, expect, test } from 'bun:test'
import type { MetricsSessionSummary, MetricsTurnSummary } from '@solus/contracts/observability-types'
import { sessionPageStats, sessionTurnPoints } from '@solus/workspace-ui/components/insights/lib/session-page'

// A session read as a sequence: the page's points and its stats are what
// answer "why is this session slow", so each claim here is one the page prints.

function turn(overrides: Partial<MetricsTurnSummary> & Pick<MetricsTurnSummary, 'turnNumber' | 'traceId'>): MetricsTurnSummary {
  return {
    startedAt: overrides.turnNumber * 1_000,
    endedAt: overrides.turnNumber * 1_000 + 100,
    durationMs: 100,
    status: 'ok',
    model: 'm',
    origin: null,
    promptSource: null,
    prompt: `Ask ${overrides.turnNumber}`,
    costUsd: null,
    inputTokens: 10,
    outputTokens: 10,
    toolCallCount: 0,
    ...overrides,
  }
}

function sessionOf(turns: MetricsTurnSummary[]): MetricsSessionSummary {
  return {
    sessionId: 's_1',
    turnCount: turns.length,
    totalDurationMs: turns.reduce((total, entry) => total + (entry.durationMs ?? 0), 0),
    totalCostUsd: turns.some((entry) => entry.costUsd != null)
      ? turns.reduce((total, entry) => total + (entry.costUsd ?? 0), 0)
      : null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turns,
  }
}

describe('session page points', () => {
  test('spend climbs across the turns and stays null until any turn reported a cost', () => {
    const points = sessionTurnPoints(
      sessionOf([
        turn({ turnNumber: 1, traceId: 'a' }),
        turn({ turnNumber: 2, traceId: 'b', costUsd: 0.5 }),
        turn({ turnNumber: 3, traceId: 'c', costUsd: 0.25 }),
      ]),
    )
    expect(points.map((point) => point.cumulativeCostUsd)).toEqual([null, 0.5, 0.75])
  })

  test('a failed turn is marked, and the context reading travels with its turn', () => {
    const points = sessionTurnPoints(
      sessionOf([turn({ turnNumber: 1, traceId: 'a', status: 'error', contextUsedTokens: 12_000 })]),
    )
    expect(points[0]).toMatchObject({ failed: true, contextUsedTokens: 12_000 })
  })
})

describe('session page stats', () => {
  test('the longest turn is named, the median is over turns with a duration, the context is the last reading', () => {
    const session = sessionOf([
      turn({ turnNumber: 1, traceId: 'a', durationMs: 100, contextUsedTokens: 1_000 }),
      turn({ turnNumber: 2, traceId: 'b', durationMs: 900 }),
      turn({ turnNumber: 3, traceId: 'c', durationMs: null, status: 'interrupted', contextUsedTokens: 4_000 }),
    ])
    const stats = sessionPageStats(session, sessionTurnPoints(session))
    expect(stats.longest?.traceId).toBe('b')
    expect(stats.medianDurationMs).toBe(500)
    expect(stats.failedCount).toBe(1)
    expect(stats.lastContextUsedTokens).toBe(4_000)
  })
})
