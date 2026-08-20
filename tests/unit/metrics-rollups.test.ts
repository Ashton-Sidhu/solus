import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type SpanTableModule = typeof import('@solus/server/observability/span-table')
type MetricsDbModule = typeof import('@solus/server/observability/metrics-db')
type RollupsModule = typeof import('@solus/server/observability/rollups')
type RegistriesModule = typeof import('@solus/server/observability/registries')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let spanTable: SpanTableModule
let metricsDb: MetricsDbModule
let rollups: RollupsModule
let registries: RegistriesModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-metrics-rollups-'))
  process.env.SOLUS_DATA_DIR = dataDir
  spanTable = await import('@solus/server/observability/span-table')
  metricsDb = await import('@solus/server/observability/metrics-db')
  rollups = await import('@solus/server/observability/rollups')
  registries = await import('@solus/server/observability/registries')
  metricsDb.closeMetricsDb()
})

afterAll(() => {
  metricsDb.closeMetricsDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe.serial('interval unions', () => {
  test('overlapping and disjoint intervals union correctly', () => {
    expect(rollups.intervalUnionLength([])).toBe(0)
    expect(rollups.intervalUnionLength([[0, 10]])).toBe(10)
    expect(rollups.intervalUnionLength([[0, 10], [5, 15], [20, 30]])).toBe(25)
    expect(rollups.intervalUnionLength([[5, 15], [0, 10], [0, 30]])).toBe(30)
    expect(rollups.intervalUnionLength([[10, 10], [10, 5]])).toBe(0)
  })
})

describe.serial('turn trace', () => {
  test('returns the span tree with Provider wait derived from the blocking-child union', () => {
    const { turn, toolCall, permissionWait, backgroundTask } = registries.SPAN_KINDS
    const service = registries.SPAN_SERVICES.sessions
    const shared = { traceId: 'trace-1', sessionId: 'session-1', service, status: 'ok' as const }
    // Root turn [0, 100]; the root's span id IS the trace id.
    spanTable.writeSpan({ ...shared, spanId: 'trace-1', kind: turn, name: 'turn', startedAt: 0, endedAt: 100 })
    // Overlapping tools [10,40] and [30,60] → union [10,60] = 50.
    spanTable.writeSpan({ ...shared, spanId: 'tool-a', parentSpanId: 'trace-1', kind: toolCall, name: 'Bash', startedAt: 10, endedAt: 40 })
    spanTable.writeSpan({ ...shared, spanId: 'tool-b', parentSpanId: 'trace-1', kind: toolCall, name: 'Read', startedAt: 30, endedAt: 60 })
    // Permission [90,95] adds 5.
    spanTable.writeSpan({ ...shared, spanId: 'perm-a', parentSpanId: 'trace-1', kind: permissionWait, name: 'Bash', startedAt: 90, endedAt: 95 })
    // Background work covers everything but never blocks — excluded.
    spanTable.writeSpan({ ...shared, spanId: 'bg-a', parentSpanId: 'trace-1', kind: backgroundTask, name: 'bg', startedAt: 0, endedAt: 100, attrs: { blocking: false } })

    const trace = rollups.turnTrace('trace-1')
    expect(trace.spans.map((span) => span.spanId)).toEqual(['bg-a', 'trace-1', 'tool-a', 'tool-b', 'perm-a'])
    expect(trace.spans[1].attrs).toEqual({})
    expect(trace.providerWaitMs).toBe(100 - 55)
    expect(trace.gapSegments.reduce((total, gap) => total + gap.durationMs, 0)).toBe(100 - 55)
  })

  test('attributes the lead-in to a reported thinking span as thinking, not idle time', () => {
    const { turn, setup, thinking, toolCall, responseStream } = registries.SPAN_KINDS
    const service = registries.SPAN_SERVICES.sessions
    const shared = { traceId: 'trace-gaps', sessionId: 'session-gaps', service, status: 'ok' as const }
    spanTable.writeSpan({
      ...shared,
      spanId: 'trace-gaps',
      kind: turn,
      name: 'turn',
      startedAt: 0,
      endedAt: 100,
      attrs: {
        timeToFirstProviderEventMs: 10,
        timeToFirstActivityMs: 20,
        timeToLastProviderEventMs: 85,
        timeToProviderCompleteMs: 85,
      },
    })
    spanTable.writeSpan({ ...shared, spanId: 'setup', parentSpanId: 'trace-gaps', kind: setup, name: 'setup', startedAt: 0, endedAt: 5 })
    spanTable.writeSpan({ ...shared, spanId: 'thinking', parentSpanId: 'trace-gaps', kind: thinking, name: 'thinking', startedAt: 20, endedAt: 30 })
    spanTable.writeSpan({ ...shared, spanId: 'tool', parentSpanId: 'trace-gaps', kind: toolCall, name: 'Read', startedAt: 40, endedAt: 60 })
    spanTable.writeSpan({ ...shared, spanId: 'thinking-after-tool', parentSpanId: 'trace-gaps', kind: thinking, name: 'thinking', startedAt: 70, endedAt: 75 })
    spanTable.writeSpan({ ...shared, spanId: 'response', parentSpanId: 'trace-gaps', kind: responseStream, name: 'response_stream', startedAt: 80, endedAt: 82 })

    const trace = rollups.turnTrace('trace-gaps')
    expect(trace.spans.find((span) => span.spanId === 'thinking')).toMatchObject({
      startedAt: 5,
      endedAt: 30,
      durationMs: 25,
    })
    expect(trace.spans.find((span) => span.spanId === 'thinking-after-tool')).toMatchObject({
      startedAt: 60,
      endedAt: 75,
      durationMs: 15,
    })
    expect(trace.providerWaitMs).toBe(33)
    expect(trace.gapSegments.map((gap) => [gap.category, gap.startedAt, gap.endedAt])).toEqual([
      ['between_activities', 30, 40],
      ['between_activities', 75, 80],
      ['provider_completion', 82, 85],
      ['turn_settlement', 85, 100],
    ])
  })

  test('a trace with no root turn reports null Provider wait', () => {
    spanTable.writeSpan({
      spanId: 'orphan', traceId: 'trace-2', kind: registries.SPAN_KINDS.toolCall, name: 'Bash',
      service: registries.SPAN_SERVICES.sessions, startedAt: 0, endedAt: 10, status: 'ok',
    })
    expect(rollups.turnTrace('trace-2')).toMatchObject({ providerWaitMs: null, gapSegments: [] })
  })
})

describe.serial('session summary', () => {
  test('orders turns by (started_at, span_id), numbers them, and totals attrs', () => {
    const { turn } = registries.SPAN_KINDS
    const service = registries.SPAN_SERVICES.sessions
    const shared = { kind: turn, name: 'turn', service, sessionId: 'session-2', status: 'ok' as const }
    // Same started_at: span_id breaks the tie.
    spanTable.writeSpan({ ...shared, spanId: 'b-turn', traceId: 'b-turn', startedAt: 1_000, endedAt: 3_000, model: 'fable', attrs: { costUsd: 0.5, inputTokens: 10, outputTokens: 20, toolCallCount: 2, promptSource: 'typed', taskId: 'task-1', taskTitle: 'Fix observability' } })
    spanTable.writeSpan({ ...shared, spanId: 'a-turn', traceId: 'a-turn', startedAt: 1_000, endedAt: 2_000, model: 'fable', attrs: { costUsd: 0.25, inputTokens: 5, outputTokens: 5 } })
    spanTable.writeSpan({ ...shared, spanId: 'c-turn', traceId: 'c-turn', startedAt: 5_000, endedAt: 6_000, model: 'opus', status: 'error', attrs: {} })

    const summary = rollups.sessionSummary('session-2')
    expect(summary.turns.map((turnSummary) => [turnSummary.turnNumber, turnSummary.traceId])).toEqual([
      [1, 'a-turn'],
      [2, 'b-turn'],
      [3, 'c-turn'],
    ])
    expect(summary.turnCount).toBe(3)
    expect(summary.totalDurationMs).toBe(1_000 + 2_000 + 1_000)
    expect(summary.totalCostUsd).toBe(0.75)
    expect(summary.totalInputTokens).toBe(15)
    expect(summary.totalOutputTokens).toBe(25)
    expect(summary.taskId).toBe('task-1')
    expect(summary.taskTitle).toBe('Fix observability')
    expect(summary.turns[0].promptSource).toBeNull()
    expect(summary.turns[1].promptSource).toBe('typed')
    expect(summary.turns[2].costUsd).toBeNull()
  })

  test('a turn carries its own ask, as one capped line', () => {
    // WHY: the session card names each turn by what it asked. Without this the
    // rows all fall back to one session name; with the whole prompt, a long
    // session ships unbounded text to say one truncated line.
    const { turn } = registries.SPAN_KINDS
    const shared = {
      kind: turn, name: 'turn', service: registries.SPAN_SERVICES.sessions,
      sessionId: 'session-prompt', status: 'ok' as const,
    }
    spanTable.writeSpan({ ...shared, spanId: 'p1', traceId: 'p1', startedAt: 1_000, endedAt: 2_000, attrs: { prompt: 'fix   the\nflaky test' } })
    spanTable.writeSpan({ ...shared, spanId: 'p2', traceId: 'p2', startedAt: 2_000, endedAt: 3_000, attrs: { prompt: 'x'.repeat(500) } })
    spanTable.writeSpan({ ...shared, spanId: 'p3', traceId: 'p3', startedAt: 3_000, endedAt: 4_000, attrs: {} })

    const summary = rollups.sessionSummary('session-prompt')
    expect(summary.turns[0].prompt).toBe('fix the flaky test')
    expect(summary.turns[1].prompt).toBe(`${'x'.repeat(200)}…`)
    expect(summary.turns[2].prompt).toBeNull()
  })

  test('an unknown session yields an empty summary', () => {
    const summary = rollups.sessionSummary('missing')
    expect(summary.turnCount).toBe(0)
    expect(summary.totalCostUsd).toBeNull()
    expect(summary.turns).toEqual([])
  })

  test('keeps an all-unknown session cost unknown instead of reporting zero spend', () => {
    spanTable.writeSpan({
      kind: registries.SPAN_KINDS.turn,
      name: 'turn',
      service: registries.SPAN_SERVICES.sessions,
      sessionId: 'unknown-cost',
      spanId: 'unknown-cost-turn',
      traceId: 'unknown-cost-turn',
      startedAt: 1_000,
      endedAt: 2_000,
      status: 'ok',
      model: 'unpriced-model',
      attrs: { inputTokens: 10, outputTokens: 5 },
    })

    expect(rollups.sessionSummary('unknown-cost').totalCostUsd).toBeNull()
  })
})
