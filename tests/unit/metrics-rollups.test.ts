import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type FacadeModule = typeof import('../../src/main/observability/facade')
type MetricsDbModule = typeof import('../../src/main/observability/metrics-db')
type RollupsModule = typeof import('../../src/main/observability/rollups')
type RegistriesModule = typeof import('../../src/main/observability/registries')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let facade: FacadeModule
let metricsDb: MetricsDbModule
let rollups: RollupsModule
let registries: RegistriesModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-metrics-rollups-'))
  process.env.SOLUS_DATA_DIR = dataDir
  facade = await import('../../src/main/observability/facade')
  metricsDb = await import('../../src/main/observability/metrics-db')
  rollups = await import('../../src/main/observability/rollups')
  registries = await import('../../src/main/observability/registries')
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
  test('returns the span tree with unattributed time derived from the blocking-child union', () => {
    const { turn, toolCall, permissionWait, backgroundTask } = registries.SPAN_KINDS
    const service = registries.SPAN_SERVICES.sessions
    const shared = { traceId: 'trace-1', sessionId: 'session-1', service, status: 'ok' as const }
    // Root turn [0, 100]; the root's span id IS the trace id.
    facade.writeSpan({ ...shared, spanId: 'trace-1', kind: turn, name: 'turn', startedAt: 0, endedAt: 100 })
    // Overlapping tools [10,40] and [30,60] → union [10,60] = 50.
    facade.writeSpan({ ...shared, spanId: 'tool-a', parentSpanId: 'trace-1', kind: toolCall, name: 'Bash', startedAt: 10, endedAt: 40 })
    facade.writeSpan({ ...shared, spanId: 'tool-b', parentSpanId: 'trace-1', kind: toolCall, name: 'Read', startedAt: 30, endedAt: 60 })
    // Permission [90,95] adds 5.
    facade.writeSpan({ ...shared, spanId: 'perm-a', parentSpanId: 'trace-1', kind: permissionWait, name: 'Bash', startedAt: 90, endedAt: 95 })
    // Background work covers everything but never blocks — excluded.
    facade.writeSpan({ ...shared, spanId: 'bg-a', parentSpanId: 'trace-1', kind: backgroundTask, name: 'bg', startedAt: 0, endedAt: 100, attrs: { blocking: false } })

    const trace = rollups.turnTrace('trace-1')
    expect(trace.spans.map((span) => span.spanId)).toEqual(['bg-a', 'trace-1', 'tool-a', 'tool-b', 'perm-a'])
    expect(trace.spans[1].attrs).toEqual({})
    expect(trace.unattributedMs).toBe(100 - 55)
    expect(trace.gapSegments.reduce((total, gap) => total + gap.durationMs, 0)).toBe(100 - 55)
  })

  test('splits unattributed intervals at observed lifecycle boundaries without claiming their cause', () => {
    const { turn, setup, thinking, toolCall, responseStream } = registries.SPAN_KINDS
    const service = registries.SPAN_SERVICES.sessions
    const shared = { traceId: 'trace-gaps', sessionId: 'session-gaps', service, status: 'ok' as const }
    facade.writeSpan({
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
    facade.writeSpan({ ...shared, spanId: 'setup', parentSpanId: 'trace-gaps', kind: setup, name: 'setup', startedAt: 0, endedAt: 5 })
    facade.writeSpan({ ...shared, spanId: 'thinking', parentSpanId: 'trace-gaps', kind: thinking, name: 'thinking', startedAt: 20, endedAt: 30 })
    facade.writeSpan({ ...shared, spanId: 'tool', parentSpanId: 'trace-gaps', kind: toolCall, name: 'Read', startedAt: 40, endedAt: 60 })
    facade.writeSpan({ ...shared, spanId: 'response', parentSpanId: 'trace-gaps', kind: responseStream, name: 'response_stream', startedAt: 70, endedAt: 75 })

    const trace = rollups.turnTrace('trace-gaps')
    expect(trace.unattributedMs).toBe(60)
    expect(trace.gapSegments.map((gap) => [gap.category, gap.startedAt, gap.endedAt])).toEqual([
      ['provider_startup', 5, 10],
      ['before_first_activity', 10, 20],
      ['between_activities', 30, 40],
      ['between_activities', 60, 70],
      ['provider_completion', 75, 85],
      ['turn_settlement', 85, 100],
    ])
  })

  test('a trace with no root turn reports null unattributed time', () => {
    facade.writeSpan({
      spanId: 'orphan', traceId: 'trace-2', kind: registries.SPAN_KINDS.toolCall, name: 'Bash',
      service: registries.SPAN_SERVICES.sessions, startedAt: 0, endedAt: 10, status: 'ok',
    })
    expect(rollups.turnTrace('trace-2')).toMatchObject({ unattributedMs: null, gapSegments: [] })
  })
})

describe.serial('session summary', () => {
  test('orders turns by (started_at, span_id), numbers them, and totals attrs', () => {
    const { turn } = registries.SPAN_KINDS
    const service = registries.SPAN_SERVICES.sessions
    const shared = { kind: turn, name: 'turn', service, sessionId: 'session-2', status: 'ok' as const }
    // Same started_at: span_id breaks the tie.
    facade.writeSpan({ ...shared, spanId: 'b-turn', traceId: 'b-turn', startedAt: 1_000, endedAt: 3_000, model: 'fable', attrs: { costUsd: 0.5, inputTokens: 10, outputTokens: 20, toolCallCount: 2, promptSource: 'typed' } })
    facade.writeSpan({ ...shared, spanId: 'a-turn', traceId: 'a-turn', startedAt: 1_000, endedAt: 2_000, model: 'fable', attrs: { costUsd: 0.25, inputTokens: 5, outputTokens: 5 } })
    facade.writeSpan({ ...shared, spanId: 'c-turn', traceId: 'c-turn', startedAt: 5_000, endedAt: 6_000, model: 'opus', status: 'error', attrs: {} })

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
    expect(summary.turns[0].promptSource).toBeNull()
    expect(summary.turns[1].promptSource).toBe('typed')
    expect(summary.turns[2].costUsd).toBeNull()
  })

  test('an unknown session yields an empty summary', () => {
    const summary = rollups.sessionSummary('missing')
    expect(summary.turnCount).toBe(0)
    expect(summary.totalCostUsd).toBeNull()
    expect(summary.turns).toEqual([])
  })

  test('keeps an all-unknown session cost unknown instead of reporting zero spend', () => {
    facade.writeSpan({
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
