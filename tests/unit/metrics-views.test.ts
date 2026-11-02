import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

type SpanTableModule = typeof import('@solus/server/data/insights/span-table')
type MetricsDbModule = typeof import('@solus/server/data/insights/metrics-db')
type FieldRegistryModule = typeof import('@solus/server/data/insights/field-registry')
type RegistriesModule = typeof import('@solus/server/data/insights/registries')
type RollupsModule = typeof import('@solus/server/data/insights/rollups')
type DistinctValuesModule = typeof import('@solus/server/data/insights/distinct-values')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let spanTable: SpanTableModule
let metricsDb: MetricsDbModule
let fieldRegistry: FieldRegistryModule
let registries: RegistriesModule
let rollups: RollupsModule
let distinctValues: DistinctValuesModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-metrics-views-'))
  process.env.SOLUS_DATA_DIR = dataDir
  spanTable = await import('@solus/server/data/insights/span-table')
  metricsDb = await import('@solus/server/data/insights/metrics-db')
  fieldRegistry = await import('@solus/server/data/insights/field-registry')
  registries = await import('@solus/server/data/insights/registries')
  rollups = await import('@solus/server/data/insights/rollups')
  distinctValues = await import('@solus/server/data/insights/distinct-values')
  metricsDb.closeMetricsDb()
})

// ─── The oracle: the per-row correlated SQL the `turns` view computed before
// the measures were stored on the root (plans/028 A2). Kept here, not in the
// source, so the stored value is checked against the definition it replaced.
const oracle = {
  rootStart: (row: string) => `(SELECT timing_root.started_at FROM spans AS timing_root WHERE timing_root.span_id = ${row}.trace_id)`,
  effectiveStartedAt(row: string): string {
    const blocker = `timing_blocker.trace_id = ${row}.trace_id AND timing_blocker.span_id <> ${row}.span_id`
      + ` AND timing_blocker.span_id <> timing_blocker.trace_id AND timing_blocker.kind <> 'background_task'`
      + ' AND timing_blocker.ended_at IS NOT NULL'
    return `CASE WHEN ${row}.kind <> 'thinking' THEN ${row}.started_at`
      + ` WHEN EXISTS (SELECT 1 FROM spans AS timing_blocker WHERE ${blocker}`
      + ` AND timing_blocker.started_at <= ${row}.started_at AND timing_blocker.ended_at > ${row}.started_at) THEN ${row}.started_at`
      + ` ELSE COALESCE((SELECT MAX(timing_blocker.ended_at) FROM spans AS timing_blocker`
      + ` WHERE ${blocker} AND timing_blocker.ended_at <= ${row}.started_at), ${this.rootStart(row)}, ${row}.started_at) END`
  },
  effectiveDuration(row: string): string {
    return `CASE WHEN ${row}.ended_at IS NULL THEN NULL ELSE MAX(0, ${row}.ended_at - (${this.effectiveStartedAt(row)})) END`
  },
  thinkingTime(root: string): string {
    return `(SELECT SUM(${this.effectiveDuration('thinking_child')}) FROM spans AS thinking_child`
      + ` WHERE thinking_child.trace_id = ${root}.trace_id AND thinking_child.kind = 'thinking')`
  },
  childTime: (kind: string) =>
    `(SELECT SUM(child.duration_ms) FROM spans AS child WHERE child.trace_id = spans.trace_id AND child.kind = '${kind}')`,
  providerWait(root: string): string {
    return `(WITH effective_intervals AS (`
      + ` SELECT MAX(${root}.started_at, ${this.effectiveStartedAt('wait_child')}) AS started_at,`
      + ` MIN(${root}.ended_at, wait_child.ended_at) AS ended_at FROM spans AS wait_child`
      + ` WHERE wait_child.trace_id = ${root}.trace_id AND wait_child.span_id <> ${root}.span_id`
      + ` AND wait_child.kind <> 'background_task' AND wait_child.ended_at IS NOT NULL`
      + `), ordered_intervals AS (SELECT started_at, ended_at,`
      + ` MAX(ended_at) OVER (ORDER BY started_at, ended_at ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior_ended_at`
      + ` FROM effective_intervals WHERE ended_at > started_at`
      + `), marked_intervals AS (SELECT started_at, ended_at,`
      + ` CASE WHEN prior_ended_at IS NULL OR started_at > prior_ended_at THEN 1 ELSE 0 END AS starts_group FROM ordered_intervals`
      + `), grouped_intervals AS (SELECT started_at, ended_at,`
      + ` SUM(starts_group) OVER (ORDER BY started_at, ended_at) AS interval_group FROM marked_intervals`
      + `), merged_intervals AS (SELECT MIN(started_at) AS started_at, MAX(ended_at) AS ended_at FROM grouped_intervals GROUP BY interval_group`
      + `) SELECT CASE WHEN ${root}.ended_at IS NULL THEN NULL ELSE MAX(0, ${root}.ended_at - ${root}.started_at`
      + ` - COALESCE((SELECT SUM(ended_at - started_at) FROM merged_intervals), 0)) END)`
  },
}

const MEASURE_COLUMNS = [
  'provider_wait_ms', 'thinking_time_ms', 'tool_time_ms', 'streaming_time_ms', 'setup_time_ms', 'permission_wait_ms',
  'question_wait_ms', 'compaction_time_ms', 'queue_wait_ms', 'rate_limit_wait_ms', 'settlement_time_ms',
] as const

const ORACLE_SELECT = `SELECT ${oracle.providerWait('spans')} AS provider_wait_ms, ${oracle.thinkingTime('spans')} AS thinking_time_ms,
  ${oracle.childTime('tool_call')} AS tool_time_ms, ${oracle.childTime('response_stream')} AS streaming_time_ms,
  ${oracle.childTime('setup')} AS setup_time_ms, ${oracle.childTime('permission_wait')} AS permission_wait_ms,
  ${oracle.childTime('question_wait')} AS question_wait_ms, ${oracle.childTime('context_compaction')} AS compaction_time_ms,
  ${oracle.childTime('queue_wait')} AS queue_wait_ms, ${oracle.childTime('rate_limit_wait')} AS rate_limit_wait_ms,
  ${oracle.childTime('turn_settlement')} AS settlement_time_ms
  FROM spans WHERE span_id = ?`

function queryPlan(sql: string): string[] {
  return (metricsDb.getMetricsDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map((row) => row.detail)
}

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
      .prepare(`SELECT span_id, tool_time_ms, thinking_time_ms, permission_wait_ms, settlement_time_ms,
        provider_wait_ms
        FROM turns WHERE span_id IN ('turn-a', 'turn-b') ORDER BY started_at`)
      .all() as Array<{
        span_id: string
        tool_time_ms: number | null
        thinking_time_ms: number | null
        permission_wait_ms: number | null
        settlement_time_ms: number | null
        provider_wait_ms: number
      }>
    expect(rows).toEqual([
      // Tools keep cumulative duration. Thinking includes its 180→200 lead-in.
      { span_id: 'turn-a', tool_time_ms: 100, thinking_time_ms: 50, permission_wait_ms: null, settlement_time_ms: 10, provider_wait_ms: 70 },
      { span_id: 'turn-b', tool_time_ms: 10, thinking_time_ms: null, permission_wait_ms: null, settlement_time_ms: null, provider_wait_ms: 90 },
    ])

    const thinkingEvent = metricsDb.getMetricsDb()
      .prepare("SELECT started_at, duration_ms FROM events WHERE span_id = 'think-a'")
      .get()
    expect(thinkingEvent).toEqual({ started_at: 180, duration_ms: 50 })

    const trace = rollups.turnTrace('turn-a')
    expect(trace.providerWaitMs).toBe(rows[0].provider_wait_ms)
    expect(trace.spans.find((span) => span.spanId === 'think-a')).toMatchObject({
      startedAt: 180,
      durationMs: 50,
    })
  })

  test('thinking inside an active tool keeps its reported boundary', () => {
    const service = registries.SPAN_SERVICES.sessions
    spanTable.writeSpan({
      kind: registries.SPAN_KINDS.turn, service,
      spanId: 'turn-nested', traceId: 'turn-nested', name: 'turn',
      startedAt: 800, endedAt: 900, status: 'ok',
    })
    spanTable.writeSpan({
      kind: registries.SPAN_KINDS.toolCall, service,
      spanId: 'tool-nested', traceId: 'turn-nested', parentSpanId: 'turn-nested', name: 'Agent',
      startedAt: 810, endedAt: 880, status: 'ok',
    })
    spanTable.writeSpan({
      kind: registries.SPAN_KINDS.thinking, service,
      spanId: 'think-nested', traceId: 'turn-nested', parentSpanId: 'tool-nested', name: 'thinking',
      startedAt: 830, endedAt: 850, status: 'ok',
    })

    expect(metricsDb.getMetricsDb().prepare(`
      SELECT started_at, duration_ms FROM events WHERE span_id = 'think-nested'
    `).get()).toEqual({ started_at: 830, duration_ms: 20 })
    expect(metricsDb.getMetricsDb().prepare(`
      SELECT thinking_time_ms, provider_wait_ms FROM turns WHERE span_id = 'turn-nested'
    `).get()).toEqual({ thinking_time_ms: 20, provider_wait_ms: 30 })
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

  test('a span\'s long texts are span_texts rows, not attrs keys, and the views and the trace read them back', () => {
    // WHY (plans/029 §6): a list or aggregate over `turns` used to read ~20 KB
    // of text per row to extract one number. The texts leave `attrs`; the view
    // columns, the trace view, and the thinking field still answer with them.
    const service = registries.SPAN_SERVICES.sessions
    spanTable.writeSpan({
      kind: registries.SPAN_KINDS.turn, service, spanId: 'turn-texts', traceId: 'turn-texts', name: 'turn',
      startedAt: 2_000, endedAt: 2_100, status: 'ok',
      attrs: { costUsd: 0.25, prompt: 'fix the flaky test', systemPrompt: 'You are Solus.', response: 'Fixed.', promptTruncated: false },
    })
    spanTable.writeSpan({
      kind: registries.SPAN_KINDS.thinking, service, spanId: 'think-texts', traceId: 'turn-texts', parentSpanId: 'turn-texts',
      name: 'thinking', startedAt: 2_010, endedAt: 2_020, status: 'ok', attrs: { thought: 'The rule is unlayered.' },
    })
    const db = metricsDb.getMetricsDb()
    const stored = db.prepare('SELECT attrs FROM spans WHERE span_id IN (?, ?) ORDER BY span_id').all('think-texts', 'turn-texts') as Array<{ attrs: string }>
    expect(stored.map((row) => JSON.parse(row.attrs))).toEqual([{}, { costUsd: 0.25, promptTruncated: false }])
    expect(db.prepare('SELECT span_id, name, text FROM span_texts WHERE span_id IN (?, ?) ORDER BY span_id, name').all('think-texts', 'turn-texts')).toEqual([
      { span_id: 'think-texts', name: 'thought', text: 'The rule is unlayered.' },
      { span_id: 'turn-texts', name: 'prompt', text: 'fix the flaky test' },
      { span_id: 'turn-texts', name: 'response', text: 'Fixed.' },
      { span_id: 'turn-texts', name: 'systemPrompt', text: 'You are Solus.' },
    ])

    expect(db.prepare('SELECT prompt, system_prompt, response, cost_usd FROM turns WHERE span_id = ?').get('turn-texts'))
      .toEqual({ prompt: 'fix the flaky test', system_prompt: 'You are Solus.', response: 'Fixed.', cost_usd: 0.25 })
    const thought = fieldRegistry.fieldsForKind(registries.SPAN_KINDS.thinking).find((field) => field.name === 'thought')!
    expect(db.prepare(`SELECT ${fieldRegistry.fieldExpression(thought)} AS thought FROM spans WHERE span_id = ?`).get('think-texts'))
      .toEqual({ thought: 'The rule is unlayered.' })

    const trace = rollups.turnTrace('turn-texts')
    expect(trace.spans.find((span) => span.spanId === 'turn-texts')?.attrs)
      .toEqual({ costUsd: 0.25, promptTruncated: false, prompt: 'fix the flaky test', systemPrompt: 'You are Solus.', response: 'Fixed.' })
    expect(trace.spans.find((span) => span.spanId === 'think-texts')?.attrs).toEqual({ thought: 'The rule is unlayered.' })

    // A root that is written open, then finished, keeps one row and its texts.
    spanTable.writeOpenSpan({
      kind: registries.SPAN_KINDS.turn, service, spanId: 'turn-open', traceId: 'turn-open', name: 'turn', startedAt: 2_200,
      attrs: { prompt: 'go' },
    })
    spanTable.writeSpan({
      kind: registries.SPAN_KINDS.turn, service, spanId: 'turn-open', traceId: 'turn-open', name: 'turn', startedAt: 2_200, endedAt: 2_300,
      status: 'ok', attrs: { prompt: 'go', response: 'Gone.' },
    })
    expect(db.prepare('SELECT prompt, response, status FROM turns WHERE span_id = ?').get('turn-open'))
      .toEqual({ prompt: 'go', response: 'Gone.', status: 'ok' })

    // The texts go with their span.
    db.prepare('DELETE FROM spans WHERE trace_id = ?').run('turn-texts')
    expect(db.prepare('SELECT COUNT(*) AS count FROM span_texts WHERE span_id IN (?, ?)').get('think-texts', 'turn-texts')).toEqual({ count: 0 })
  })

  test('a listing aggregate over turns reads neither span_texts nor a per-row subquery', () => {
    // WHY: this is the measured win (plans/028 A1, A2). The plan is the proof
    // that stays true as the registry grows: the aggregate touches `spans`
    // once and nothing else.
    const volume = queryPlan(`SELECT MIN(9, CAST((started_at - 0) / 100 AS INTEGER)) AS bucket_index, COUNT(*) AS total,
      COALESCE(SUM(cost_usd), 0) AS cost_usd FROM turns WHERE started_at >= 0 AND started_at < 1000 GROUP BY bucket_index`)
    const hosts = queryPlan('SELECT host_id, MAX(hostname) AS hostname, COUNT(*) AS count FROM turns WHERE started_at >= 0 GROUP BY host_id')
    const waitByModel = queryPlan('SELECT model, AVG(provider_wait_ms), SUM(tool_time_ms), AVG(thinking_time_ms) FROM turns GROUP BY model')
    for (const plan of [volume, hosts, waitByModel]) {
      expect(plan.join('\n')).not.toContain('span_texts')
      expect(plan.join('\n')).not.toContain('SUBQUERY')
      expect(plan.filter((step) => /\bspans\b/.test(step))).toHaveLength(1)
    }
  })

  test('the stored root measures equal what the old per-row SQL computed, and follow a child that ends after its root', () => {
    const service = registries.SPAN_SERVICES.sessions
    const span = (spanId: string, kind: (typeof registries.SPAN_KINDS)[keyof typeof registries.SPAN_KINDS], startedAt: number, endedAt: number, parentSpanId = 'turn-oracle') =>
      spanTable.writeSpan({ kind, service, spanId, traceId: 'turn-oracle', parentSpanId, name: kind, startedAt, endedAt, status: 'ok' })

    // The root is written first, as a pulled list row is; every child then
    // lands on an ended root and the measures follow.
    spanTable.writeSpan({ kind: registries.SPAN_KINDS.turn, service, spanId: 'turn-oracle', traceId: 'turn-oracle', name: 'turn', startedAt: 10_000, endedAt: 11_000, status: 'ok' })
    span('o-setup', registries.SPAN_KINDS.setup, 10_000, 10_050)
    span('o-permission', registries.SPAN_KINDS.permissionWait, 10_050, 10_100)
    span('o-tool-a', registries.SPAN_KINDS.toolCall, 10_100, 10_300)
    span('o-tool-b', registries.SPAN_KINDS.toolCall, 10_200, 10_400) // overlaps a
    span('o-think-lead', registries.SPAN_KINDS.thinking, 10_450, 10_500) // lead-in from 10_400
    span('o-tool-c', registries.SPAN_KINDS.toolCall, 10_550, 10_700)
    span('o-think-nested', registries.SPAN_KINDS.thinking, 10_600, 10_650, 'o-tool-c') // inside a tool: no lead-in
    span('o-background', registries.SPAN_KINDS.backgroundTask, 10_000, 11_000) // never blocks
    span('o-stream', registries.SPAN_KINDS.responseStream, 10_750, 10_800)
    span('o-settle', registries.SPAN_KINDS.turnSettlement, 10_950, 11_000)
    span('o-tool-late', registries.SPAN_KINDS.toolCall, 10_900, 11_100) // ends after the root: clipped
    // A child still open contributes nothing to either definition.
    metricsDb.getMetricsDb().prepare(`INSERT INTO spans (span_id, parent_span_id, trace_id, kind, name, service, started_at, ended_at, duration_ms, status, attrs)
      VALUES ('o-tool-open', 'turn-oracle', 'turn-oracle', 'tool_call', 'Bash', 'solus.sessions', 10_800, NULL, NULL, 'unknown', '{}')`).run()
    span('o-tool-after-open', registries.SPAN_KINDS.toolCall, 10_850, 10_860)

    const db = metricsDb.getMetricsDb()
    const stored = db.prepare(`SELECT ${MEASURE_COLUMNS.join(', ')} FROM spans WHERE span_id = ?`).get('turn-oracle')
    const expected = db.prepare(ORACLE_SELECT).get('turn-oracle')
    expect(stored).toEqual(expected)
    expect(stored).toMatchObject({
      tool_time_ms: 200 + 200 + 150 + 200 + 10,
      thinking_time_ms: 100 + 50,
      setup_time_ms: 50,
      permission_wait_ms: 50,
      streaming_time_ms: 50,
      settlement_time_ms: 50,
      question_wait_ms: null,
      queue_wait_ms: null,
    })
    // Blocking union: 10_000–10_500 (the lead-in joins it), 10_550–10_700, 10_750–10_800, 10_850–10_860, 10_900–11_000.
    expect(stored).toMatchObject({ provider_wait_ms: 50 + 50 + 50 + 40 })

    // The view selects the stored columns, so the two cannot drift.
    expect(db.prepare('SELECT provider_wait_ms, thinking_time_ms, tool_time_ms FROM turns WHERE span_id = ?').get('turn-oracle'))
      .toEqual({ provider_wait_ms: 190, thinking_time_ms: 150, tool_time_ms: 760 })
    expect(rollups.turnTrace('turn-oracle').providerWaitMs).toBe(190)
  })

  test('a root with no children yet has no measures until it ends; an open root has none at all', () => {
    const service = registries.SPAN_SERVICES.sessions
    spanTable.writeOpenSpan({ kind: registries.SPAN_KINDS.turn, service, spanId: 'turn-running', traceId: 'turn-running', name: 'turn', startedAt: 20_000 })
    spanTable.writeSpan({ kind: registries.SPAN_KINDS.toolCall, service, spanId: 'running-tool', traceId: 'turn-running', parentSpanId: 'turn-running', name: 'Bash', startedAt: 20_010, endedAt: 20_020, status: 'ok' })
    const db = metricsDb.getMetricsDb()
    expect(db.prepare('SELECT tool_time_ms, provider_wait_ms FROM turns WHERE span_id = ?').get('turn-running'))
      .toEqual({ tool_time_ms: null, provider_wait_ms: null })
    spanTable.writeSpan({ kind: registries.SPAN_KINDS.turn, service, spanId: 'turn-running', traceId: 'turn-running', name: 'turn', startedAt: 20_000, endedAt: 20_100, status: 'ok' })
    expect(db.prepare('SELECT tool_time_ms, provider_wait_ms FROM turns WHERE span_id = ?').get('turn-running'))
      .toEqual({ tool_time_ms: 10, provider_wait_ms: 90 })
  })

  test('distinct dimension values come from turn roots, so a child span never adds one', () => {
    // WHY (plans/028 A4): every child repeats its root's model, provider, and
    // origin; reading them from roots alone gives the same set from a fraction
    // of the rows. A child that differs is a provider leak, not a dimension.
    const service = registries.SPAN_SERVICES.sessions
    spanTable.writeSpan({ kind: registries.SPAN_KINDS.turn, service, spanId: 'turn-model', traceId: 'turn-model', name: 'turn', startedAt: 30_000, endedAt: 30_100, status: 'ok', model: 'root-model' })
    spanTable.writeSpan({ kind: registries.SPAN_KINDS.toolCall, service, spanId: 'tool-model', traceId: 'turn-model', parentSpanId: 'turn-model', name: 'Bash', startedAt: 30_010, endedAt: 30_020, status: 'ok', model: 'child-only-model' })
    const query = distinctValues.distinctValuesSql('model', { sql: '1 = 1', params: [] })!
    const values = (metricsDb.getMetricsDb().prepare(query.sql).all(...query.params) as Array<{ value: string }>).map((row) => row.value)
    expect(values).toContain('root-model')
    expect(values).not.toContain('child-only-model')
    expect(distinctValues.distinctValuesSql('attrs', { sql: '1 = 1', params: [] })).toBeUndefined()
  })
})
