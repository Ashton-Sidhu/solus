import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type SpanTableModule = typeof import('../../src/main/observability/span-table')
type MetricsDbModule = typeof import('../../src/main/observability/metrics-db')
type FieldRegistryModule = typeof import('../../src/main/observability/field-registry')
type RegistriesModule = typeof import('../../src/main/observability/registries')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let spanTable: SpanTableModule
let metricsDb: MetricsDbModule
let fieldRegistry: FieldRegistryModule
let registries: RegistriesModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-metrics-views-'))
  process.env.SOLUS_DATA_DIR = dataDir
  spanTable = await import('../../src/main/observability/span-table')
  metricsDb = await import('../../src/main/observability/metrics-db')
  fieldRegistry = await import('../../src/main/observability/field-registry')
  registries = await import('../../src/main/observability/registries')
  metricsDb.closeMetricsDb()
})

afterAll(() => {
  metricsDb.closeMetricsDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

// The two-table query model (docs/plans/observability.md, WP4.7): the user
// reasons about `turns` and `events`, never a table per kind. These tests
// encode the two promises that make that model honest — every kind's rows are
// reachable through exactly one documented view, and the correlations the
// per-kind tables used to force (child time per turn) are pre-summed columns.

describe.serial('the two-table query model', () => {
  test('boot creates exactly the registered views, and every kind maps onto one of them', () => {
    const db = metricsDb.getMetricsDb()
    const views = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all() as Array<{ name: string }>)
      .map((row) => row.name))
    expect([...views].sort()).toEqual(['events', 'internal_events', 'turns'])
    for (const kind of Object.values(registries.SPAN_KINDS)) {
      expect(views.has(fieldRegistry.viewNameForKind(kind))).toBe(true)
    }
  })

  test('a legacy per-kind view left by an earlier registry generation is dropped at boot', () => {
    const db = metricsDb.getMetricsDb()
    db.exec("CREATE VIEW tool_calls AS SELECT * FROM spans WHERE kind = 'tool_call'")
    fieldRegistry.createMetricsViews(db)
    const stale = db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'tool_calls'").get()
    expect(stale).toBeFalsy()
  })

  test('view columns match the field registry exactly, in order', () => {
    const db = metricsDb.getMetricsDb()
    for (const view of fieldRegistry.metricsSchema().views) {
      const columns = (db.prepare(`PRAGMA table_info(${view.view})`).all() as Array<{ name: string }>)
        .map((row) => row.name)
      expect(columns).toEqual(view.columns.map((column) => column.name))
    }
  })

  test('tool facts resolve on events for tool kinds and stay NULL elsewhere; malformed input yields NULL, not an error', () => {
    const base = {
      kind: registries.SPAN_KINDS.toolCall,
      service: registries.SPAN_SERVICES.sessions,
      status: 'ok' as const,
    }
    spanTable.writeSpan({
      ...base, spanId: 'tool-good', traceId: 'tool-good', name: 'Bash', startedAt: 1, endedAt: 2,
      attrs: { input: '{"command":"bun run build"}' },
    })
    spanTable.writeSpan({
      ...base, spanId: 'tool-truncated', traceId: 'tool-truncated', name: 'Bash', startedAt: 3, endedAt: 4,
      attrs: { input: '{"command":"bun run bui', inputTruncated: true },
    })
    spanTable.writeSpan({
      kind: registries.SPAN_KINDS.thinking, service: registries.SPAN_SERVICES.sessions,
      spanId: 'think-1', traceId: 'think-1', name: 'thinking', startedAt: 5, endedAt: 6, status: 'ok',
    })

    const rows = metricsDb.getMetricsDb()
      .prepare('SELECT span_id, kind, tool, command FROM events ORDER BY started_at')
      .all() as Array<{ span_id: string; kind: string; tool: string | null; command: string | null }>
    expect(rows).toEqual([
      { span_id: 'tool-good', kind: 'tool_call', tool: 'Bash', command: 'bun run build' },
      { span_id: 'tool-truncated', kind: 'tool_call', tool: 'Bash', command: null },
      { span_id: 'think-1', kind: 'thinking', tool: null, command: null },
    ])
  })

  test('turn attrs lift into typed view columns', () => {
    spanTable.writeSpan({
      kind: registries.SPAN_KINDS.turn, service: registries.SPAN_SERVICES.sessions,
      spanId: 'turn-1', traceId: 'turn-1', name: 'turn', startedAt: 10, endedAt: 20, status: 'ok',
      sessionId: 'session-1', model: 'fable',
      attrs: {
        costUsd: 0.5, promptSource: 'typed', hasThinking: true, toolCallCount: 3,
        isResume: true, timeToFirstActivityMs: 12, timeToFirstTextMs: 40,
        timeToFirstProviderEventMs: 8, timeToLastProviderEventMs: 48,
        timeToProviderCompleteMs: 45,
      },
    })
    const row = metricsDb.getMetricsDb()
      .prepare(`SELECT cost_usd, prompt_source, has_thinking, tool_call_count,
        is_resume, time_to_first_activity_ms, time_to_first_text_ms,
        time_to_first_provider_event_ms, time_to_last_provider_event_ms,
        time_to_provider_complete_ms
        FROM turns WHERE span_id = ?`)
      .get('turn-1') as {
        cost_usd: number
        prompt_source: string
        has_thinking: number
        tool_call_count: number
        is_resume: number
        time_to_first_activity_ms: number
        time_to_first_text_ms: number
        time_to_first_provider_event_ms: number
        time_to_last_provider_event_ms: number
        time_to_provider_complete_ms: number
      }
    expect(row).toEqual({
      cost_usd: 0.5,
      prompt_source: 'typed',
      has_thinking: 1,
      tool_call_count: 3,
      is_resume: 1,
      time_to_first_activity_ms: 12,
      time_to_first_text_ms: 40,
      time_to_first_provider_event_ms: 8,
      time_to_last_provider_event_ms: 48,
      time_to_provider_complete_ms: 45,
    })
  })

  test('child time is pre-summed per turn from its own trace only — the correlation nobody writes a join for', () => {
    const child = (
      spanId: string,
      traceId: string,
      kind: (typeof registries.SPAN_KINDS)[keyof typeof registries.SPAN_KINDS],
      startedAt: number,
      endedAt: number,
    ) =>
      spanTable.writeSpan({
        kind, service: registries.SPAN_SERVICES.sessions,
        spanId, traceId, name: kind === registries.SPAN_KINDS.toolCall ? 'Bash' : kind,
        startedAt, endedAt, status: 'ok',
      })

    spanTable.writeSpan({
      kind: registries.SPAN_KINDS.turn, service: registries.SPAN_SERVICES.sessions,
      spanId: 'turn-a', traceId: 'turn-a', name: 'turn', startedAt: 100, endedAt: 300, status: 'ok',
    })
    // Two tools overlap on purpose: the column is a duration total, not wall clock.
    child('tool-a1', 'turn-a', registries.SPAN_KINDS.toolCall, 110, 150)
    child('tool-a2', 'turn-a', registries.SPAN_KINDS.toolCall, 120, 180)
    child('think-a', 'turn-a', registries.SPAN_KINDS.thinking, 200, 230)
    child('settle-a', 'turn-a', registries.SPAN_KINDS.turnSettlement, 290, 300)

    spanTable.writeSpan({
      kind: registries.SPAN_KINDS.turn, service: registries.SPAN_SERVICES.sessions,
      spanId: 'turn-b', traceId: 'turn-b', name: 'turn', startedAt: 400, endedAt: 500, status: 'ok',
    })
    child('tool-b1', 'turn-b', registries.SPAN_KINDS.toolCall, 410, 420)

    const rows = metricsDb.getMetricsDb()
      .prepare(`SELECT span_id, tool_time_ms, thinking_time_ms, permission_wait_ms, settlement_time_ms
        FROM turns WHERE span_id IN ('turn-a', 'turn-b') ORDER BY started_at`)
      .all() as Array<{
        span_id: string
        tool_time_ms: number | null
        thinking_time_ms: number | null
        permission_wait_ms: number | null
        settlement_time_ms: number | null
      }>
    expect(rows).toEqual([
      // 40 + 60 of tool time, 30 of thinking; no permission wait → NULL, not 0.
      { span_id: 'turn-a', tool_time_ms: 100, thinking_time_ms: 30, permission_wait_ms: null, settlement_time_ms: 10 },
      { span_id: 'turn-b', tool_time_ms: 10, thinking_time_ms: null, permission_wait_ms: null, settlement_time_ms: null },
    ])
  })

  test('snapshotted names and execution-host facts surface on turns, and events inherit them from their trace root', () => {
    spanTable.writeSpan({
      kind: registries.SPAN_KINDS.turn, service: registries.SPAN_SERVICES.sessions,
      spanId: 'turn-c', traceId: 'turn-c', name: 'turn', startedAt: 600, endedAt: 700, status: 'ok',
      attrs: {
        automationId: '01AUTO', automationName: 'Nightly triage',
        taskId: '01TASK', taskTitle: 'Fix flaky tests',
        branch: 'solus/fix-flaky', projectName: 'solus',
        hostname: 'builder-07', hostOs: 'linux',
      },
    })
    spanTable.writeSpan({
      kind: registries.SPAN_KINDS.toolCall, service: registries.SPAN_SERVICES.sessions,
      spanId: 'tool-c1', traceId: 'turn-c', name: 'Bash', startedAt: 610, endedAt: 620, status: 'ok',
    })

    const turn = metricsDb.getMetricsDb()
      .prepare('SELECT automation, task, project, branch, hostname, host_os, automation_id FROM turns WHERE span_id = ?')
      .get('turn-c')
    expect(turn).toEqual({
      automation: 'Nightly triage',
      task: 'Fix flaky tests',
      project: 'solus',
      branch: 'solus/fix-flaky',
      hostname: 'builder-07',
      host_os: 'linux',
      automation_id: '01AUTO',
    })

    const event = metricsDb.getMetricsDb()
      .prepare('SELECT automation, task, branch, hostname, host_os FROM events WHERE span_id = ?')
      .get('tool-c1')
    expect(event).toEqual({
      automation: 'Nightly triage',
      task: 'Fix flaky tests',
      branch: 'solus/fix-flaky',
      hostname: 'builder-07',
      host_os: 'linux',
    })

    // An event whose trace root recorded no dimensions stays null, not wrong.
    const bare = metricsDb.getMetricsDb()
      .prepare('SELECT automation, task, branch, hostname, host_os FROM events WHERE span_id = ?')
      .get('tool-a1')
    expect(bare).toEqual({ automation: null, task: null, branch: null, hostname: null, host_os: null })
  })

  test('each view exposes only its own kinds — turn and internal spans never surface in events', () => {
    spanTable.writeSpan({
      kind: registries.SPAN_KINDS.internalRpc, service: registries.SPAN_SERVICES.rpc,
      spanId: 'rpc-1', traceId: 'rpc-1', name: 'listSessions', startedAt: 1_000, endedAt: 1_001, status: 'ok',
    })
    const db = metricsDb.getMetricsDb()
    const spanIdsIn = (view: string) =>
      (db.prepare(`SELECT span_id FROM ${view}`).all() as Array<{ span_id: string }>)
        .map((row) => row.span_id)
    expect(spanIdsIn('events')).not.toContain('turn-a')
    expect(spanIdsIn('events')).not.toContain('rpc-1')
    expect(spanIdsIn('events')).toContain('tool-a1')
    expect(spanIdsIn('internal_events')).toEqual(['rpc-1'])
    expect(spanIdsIn('turns')).not.toContain('rpc-1')
    expect(spanIdsIn('turns')).not.toContain('tool-a1')
  })
})
