import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type SessionEmitterModule = typeof import('../../src/main/observability/session-emitter')
type MetricsDbModule = typeof import('../../src/main/observability/metrics-db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let emitterModule: SessionEmitterModule
let metricsDb: MetricsDbModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-emitter-'))
  process.env.SOLUS_DATA_DIR = dataDir
  emitterModule = await import('../../src/main/observability/session-emitter')
  metricsDb = await import('../../src/main/observability/metrics-db')
})

afterEach(() => {
  metricsDb.closeMetricsDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `metrics.db${suffix}`), { force: true })
})

afterAll(() => {
  metricsDb.closeMetricsDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

interface SpanRow {
  span_id: string
  parent_span_id: string | null
  trace_id: string
  session_id: string | null
  kind: string
  name: string
  model: string | null
  started_at: number
  ended_at: number
  status: string
  attrs: string
}

interface SpanAttrs {
  blocking?: boolean
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
  decision?: string
  input?: string
  inputTokens?: number
  outcomeStatus?: string
  outputTokens?: number
  permissionDenialCount?: number
  prompt?: string
  promptChars?: number
  promptSource?: string
  providerDurationMs?: number
  reasoningEffort?: string
  isResume?: boolean
  taskId?: string
  timeToFirstActivityMs?: number
  timeToFirstProviderEventMs?: number
  timeToLastProviderEventMs?: number
  timeToProviderCompleteMs?: number
  timeToFirstTextMs?: number
  toolCallCount?: number
}

function rows(): SpanRow[] {
  return metricsDb.getMetricsDb().prepare('SELECT * FROM spans ORDER BY started_at, kind').all() as SpanRow[]
}

function attrs(row: SpanRow): SpanAttrs {
  return JSON.parse(row.attrs) as SpanAttrs
}

describe.serial('session emitter', () => {
  test('records a Claude turn with natural-duration child spans', () => {
    const emitter = new emitterModule.SessionEmitter()
    emitter.beginTurn({ sessionId: 'claude-1', prompt: 'fix it', promptSource: 'typed', startedAt: 1_000 })
    emitter.completeSetup('claude-1', {
      provider: 'claude-code', model: 'claude-sonnet-5', projectRoot: '/repo', origin: 'typed',
      reasoningEffort: 'high', taskId: 'task-1', taskTitle: 'Fix the tests',
      automationId: 'auto-1', automationName: 'Nightly triage', branch: 'main', isResume: false,
    }, 1_010)
    emitter.onEvent('claude-1', { type: 'text_chunk', text: 'I will' }, 1_020)
    emitter.onEvent('claude-1', { type: 'tool_call', toolName: 'Bash', toolId: 'tool-1', index: 0 }, 1_030)
    emitter.onEvent('claude-1', { type: 'tool_call_complete', toolId: 'tool-1', index: 0, toolInput: '{"command":"bun test"}' }, 1_040)
    emitter.onEvent('claude-1', { type: 'tool_result', toolUseId: 'tool-1', content: 'ok' }, 1_042)
    emitter.onEvent('claude-1', {
      type: 'task_complete', result: 'done', costUsd: 0.25, durationMs: 50, numTurns: 1,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 }, sessionId: 'provider-1',
    }, 1_045)
    emitter.recordTerminal('claude-1', 'ok', 1_050)
    expect(emitter.finishTurn('claude-1', 'completed', 1_051)).toBe('completed')

    const spans = rows()
    expect(spans.map((span) => span.kind)).toEqual([
      'setup', 'turn', 'response_stream', 'tool_call', 'turn_settlement',
    ])
    const turn = spans.find((span) => span.kind === 'turn')!
    expect(turn.model).toBe('claude-sonnet-5')
    expect(attrs(turn)).toMatchObject({
      prompt: 'fix it', promptChars: 6, promptSource: 'typed', reasoningEffort: 'high', taskId: 'task-1',
      // Ids drill, names query: the display names ride the turn as snapshots.
      taskTitle: 'Fix the tests', automationId: 'auto-1', automationName: 'Nightly triage',
      branch: 'main', projectName: 'repo',
      costUsd: 0.25, inputTokens: 100, outputTokens: 20, cacheReadTokens: 30,
      isResume: false, timeToFirstActivityMs: 20, timeToFirstTextMs: 20, toolCallCount: 1,
      timeToFirstProviderEventMs: 20, timeToLastProviderEventMs: 45,
      timeToProviderCompleteMs: 45,
    })
    expect(attrs(spans.find((span) => span.kind === 'tool_call')!)).toMatchObject({ input: '{"command":"bun test"}' })
    expect(spans.find((span) => span.kind === 'tool_call')).toMatchObject({ started_at: 1_030, ended_at: 1_042 })
    expect(spans.find((span) => span.kind === 'turn_settlement')).toMatchObject({
      name: 'Solus settlement', started_at: 1_045, ended_at: 1_050, duration_ms: 5,
    })
  })

  test('records provider thinking and observed response-stream intervals', () => {
    const emitter = new emitterModule.SessionEmitter()
    emitter.beginTurn({ sessionId: 'activity', prompt: 'explain', promptSource: 'typed', startedAt: 1_100 })
    emitter.completeSetup('activity', {
      provider: 'claude-code', model: 'claude', projectRoot: '/repo', origin: 'typed', isResume: false,
    }, 1_105)

    emitter.onEvent('activity', { type: 'thinking', state: 'start' }, 1_110)
    emitter.onEvent('activity', { type: 'thinking', state: 'stop' }, 1_130)
    emitter.onEvent('activity', { type: 'text_chunk', text: 'First' }, 1_140)
    emitter.onEvent('activity', { type: 'text_chunk', text: ' second' }, 1_150)
    emitter.onEvent('activity', { type: 'tool_call', toolName: 'Read', toolId: 'read-1', index: 0 }, 1_160)
    emitter.onEvent('activity', { type: 'tool_call_complete', toolId: 'read-1', index: 0 }, 1_170)
    emitter.onEvent('activity', { type: 'tool_result', toolUseId: 'read-1', content: 'file' }, 1_175)
    // A missing provider stop is bounded by the next observed response event.
    emitter.onEvent('activity', { type: 'thinking', state: 'start' }, 1_180)
    emitter.onEvent('activity', { type: 'text_chunk', text: 'Done' }, 1_190)
    emitter.recordTerminal('activity', 'ok', 1_200)
    emitter.finishTurn('activity', 'completed', 1_200)

    const spans = rows()
    expect(spans.filter((span) => span.kind === 'thinking')).toEqual([
      expect.objectContaining({ started_at: 1_110, ended_at: 1_130, status: 'ok' }),
      expect.objectContaining({ started_at: 1_180, ended_at: 1_190, status: 'ok' }),
    ])
    expect(spans.filter((span) => span.kind === 'response_stream')).toEqual([
      expect.objectContaining({ started_at: 1_140, ended_at: 1_150, status: 'ok' }),
      expect.objectContaining({ started_at: 1_190, ended_at: 1_190, status: 'ok' }),
    ])
    expect(attrs(spans.find((span) => span.kind === 'turn')!)).toMatchObject({
      hasThinking: true,
      timeToFirstActivityMs: 10,
      timeToFirstTextMs: 40,
    })
  })

  test('tool-first turns do not report final visible text as first activity', () => {
    const emitter = new emitterModule.SessionEmitter()
    emitter.beginTurn({ sessionId: 'tool-first', prompt: 'inspect', promptSource: 'typed', startedAt: 1_300 })
    emitter.completeSetup('tool-first', {
      provider: 'codex', model: 'gpt', projectRoot: '/repo', origin: 'typed', isResume: false,
    }, 1_305)
    emitter.onEvent('tool-first', {
      type: 'tool_call', toolName: 'Read', toolId: 'read-first', index: 0, startedAtMs: 1_310,
    }, 1_312)
    emitter.onEvent('tool-first', {
      type: 'tool_call_complete', toolId: 'read-first', index: 0, completedAtMs: 1_320,
    }, 1_321)
    emitter.onEvent('tool-first', { type: 'text_chunk', text: 'Done' }, 1_350)
    emitter.recordTerminal('tool-first', 'ok', 1_360)
    emitter.finishTurn('tool-first', 'completed', 1_360)

    expect(attrs(rows().find((span) => span.kind === 'turn')!)).toMatchObject({
      timeToFirstActivityMs: 10,
      timeToFirstTextMs: 50,
    })
  })

  test('uses Codex timestamps, outcomes, cumulative usage deltas, and rerouted model', () => {
    const emitter = new emitterModule.SessionEmitter()
    emitter.beginTurn({ sessionId: 'codex-1', prompt: 'search', promptSource: 'dispatch', startedAt: 2_000 })
    emitter.completeSetup('codex-1', {
      provider: 'codex', model: 'requested', projectRoot: '/repo', origin: 'dispatch', isResume: false,
    }, 2_005)
    emitter.onEvent('codex-1', { type: 'session_init', sessionId: 'thread-1', model: 'gpt-5.6-terra', skills: [] }, 2_006)
    emitter.onEvent('codex-1', { type: 'model_rerouted', fromModel: 'gpt-5.6-terra', toModel: 'gpt-5.6-sol' }, 2_007)
    emitter.onEvent('codex-1', {
      type: 'tool_call', toolName: 'web_search', toolId: 'web-1', index: 0,
      toolInput: '{"query":"solus"}', startedAtMs: 2_010,
    }, 2_020)
    emitter.onEvent('codex-1', {
      type: 'tool_call_complete', toolId: 'web-1', index: 0, completedAtMs: 2_030,
      outcome: { status: 'completed', durationMs: 20 },
    }, 2_040)
    emitter.onEvent('codex-1', { type: 'usage', run: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 10 } }, 2_041)
    emitter.recordTerminal('codex-1', 'ok', 2_050)
    emitter.finishTurn('codex-1', 'completed')

    let spans = rows()
    let turn = spans.find((span) => span.kind === 'turn')!
    expect(turn.model).toBe('gpt-5.6-sol')
    expect(attrs(turn)).toMatchObject({ inputTokens: 80, outputTokens: 20, cacheReadTokens: 10 })
    expect(attrs(turn).costUsd).toBeCloseTo(0.001005, 10)
    const tool = spans.find((span) => span.kind === 'tool_call')!
    expect(tool.started_at).toBe(2_010)
    expect(tool.ended_at).toBe(2_030)
    expect(attrs(tool)).toMatchObject({ outcomeStatus: 'completed', providerDurationMs: 20 })

    metricsDb.closeMetricsDb()
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `metrics.db${suffix}`), { force: true })
    emitter.beginTurn({ sessionId: 'codex-1', prompt: 'again', promptSource: 'typed', startedAt: 3_000 })
    emitter.completeSetup('codex-1', {
      provider: 'codex', model: 'gpt-5.6-sol', projectRoot: '/repo', origin: 'typed', isResume: true,
    }, 3_005)
    emitter.onEvent('codex-1', { type: 'usage', run: { inputTokens: 110, outputTokens: 35, cacheReadTokens: 12 } }, 3_020)
    emitter.recordTerminal('codex-1', 'ok', 3_030)
    emitter.finishTurn('codex-1', 'completed')
    spans = rows()
    turn = spans.find((span) => span.kind === 'turn')!
    expect(attrs(turn)).toMatchObject({ inputTokens: 30, outputTokens: 15, cacheReadTokens: 2 })
    expect(attrs(turn).costUsd).toBeCloseTo(0.000601, 10)
  })

  test('finalizes parallel and nested tools on interrupt and provider failure', () => {
    const emitter = new emitterModule.SessionEmitter()
    emitter.beginTurn({ sessionId: 'parallel', prompt: 'parallel', promptSource: 'typed', startedAt: 4_000 })
    emitter.completeSetup('parallel', {
      provider: 'codex', model: 'gpt', projectRoot: '/repo', origin: 'typed', isResume: false,
    }, 4_005)
    emitter.onEvent('parallel', { type: 'tool_call', toolName: 'parent', toolId: 'same-id', index: 0 }, 4_010)
    emitter.onEvent('parallel', { type: 'tool_call', toolName: 'child', toolId: 'child', index: 1, parentToolUseId: 'same-id' }, 4_012)
    emitter.onEvent('parallel', { type: 'tool_call', toolName: 'peer', toolId: 'peer', index: 2 }, 4_013)
    emitter.recordTerminal('parallel', 'interrupted', 4_030)
    expect(emitter.finishTurn('parallel', 'completed')).toBe('interrupted')

    const spans = rows()
    const tools = spans.filter((span) => span.kind === 'tool_call')
    expect(tools).toHaveLength(3)
    expect(tools.every((span) => span.ended_at === 4_030 && span.status === 'interrupted')).toBe(true)
    const parent = tools.find((span) => span.name === 'parent')!
    expect(tools.find((span) => span.name === 'child')!.parent_span_id).toBe(parent.span_id)
  })

  test('finalizes an open tool as error on provider failure', () => {
    const emitter = new emitterModule.SessionEmitter()
    emitter.beginTurn({ sessionId: 'failure', prompt: 'fail', promptSource: 'typed', startedAt: 4_100 })
    emitter.completeSetup('failure', {
      provider: 'claude-code', model: 'claude', projectRoot: '/repo', origin: 'typed', isResume: false,
    }, 4_105)
    emitter.onEvent('failure', { type: 'tool_call', toolName: 'Bash', toolId: 'open', index: 0 }, 4_110)
    emitter.recordTerminal('failure', 'error', 4_120)
    expect(emitter.finishTurn('failure', 'completed')).toBe('failed')
    const spans = rows()
    expect(spans.find((span) => span.kind === 'turn')?.status).toBe('error')
    expect(spans.find((span) => span.kind === 'tool_call')?.status).toBe('error')
  })

  test('records queue wait and granted and denied permission waits', () => {
    const emitter = new emitterModule.SessionEmitter()
    emitter.beginTurn({ sessionId: 'permissions', prompt: 'apply', promptSource: 'queued', startedAt: 5_000 })
    emitter.completeSetup('permissions', {
      provider: 'claude-code', model: 'claude', projectRoot: '/repo', origin: 'queued', isResume: true,
    }, 5_010)
    emitter.recordQueueWait('permissions', 4_900, 5_000)
    emitter.onEvent('permissions', {
      type: 'permission_request', questionId: 'q1', toolName: 'Bash', options: [
        { id: 'allow', label: 'Allow', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' },
      ],
    }, 5_020)
    emitter.resolvePermission('permissions', 'q1', 'allow', 5_030)
    emitter.onEvent('permissions', {
      type: 'permission_request', questionId: 'q2', toolName: 'Write', options: [
        { id: 'accept', label: 'Allow', kind: 'allow' }, { id: 'decline', label: 'Deny', kind: 'deny' },
      ],
    }, 5_035)
    emitter.resolvePermission('permissions', 'q2', 'decline', 5_045)
    emitter.recordTerminal('permissions', 'ok', 5_050)
    emitter.finishTurn('permissions', 'completed')

    const spans = rows()
    expect(spans.find((span) => span.kind === 'queue_wait')).toMatchObject({ started_at: 4_900, ended_at: 5_000 })
    const permissions = spans.filter((span) => span.kind === 'permission_wait')
    expect(permissions.map((span) => attrs(span).decision)).toEqual(['granted', 'denied'])
    expect(attrs(spans.find((span) => span.kind === 'turn')!)).toMatchObject({ permissionDenialCount: 1 })
  })

  test('omits a missing Codex resume baseline, handles a counter reset, and records failed status', () => {
    const emitter = new emitterModule.SessionEmitter()
    emitter.beginTurn({ sessionId: 'resume', prompt: 'resume', promptSource: 'agent', startedAt: 6_000 })
    emitter.completeSetup('resume', {
      provider: 'codex', model: 'gpt', projectRoot: '/repo', origin: 'agent', isResume: true,
    }, 6_005)
    emitter.onEvent('resume', { type: 'usage', run: { inputTokens: 500, outputTokens: 50 } }, 6_010)
    emitter.recordTerminal('resume', 'error', 6_020)
    expect(emitter.finishTurn('resume', 'completed')).toBe('failed')
    let turn = rows().find((span) => span.kind === 'turn')!
    expect(turn.status).toBe('error')
    expect(attrs(turn).inputTokens).toBeUndefined()

    metricsDb.closeMetricsDb()
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `metrics.db${suffix}`), { force: true })
    emitter.beginTurn({ sessionId: 'resume', prompt: 'reset', promptSource: 'agent', startedAt: 7_000 })
    emitter.completeSetup('resume', {
      provider: 'codex', model: 'gpt', projectRoot: '/repo', origin: 'agent', isResume: true,
    }, 7_005)
    emitter.onEvent('resume', { type: 'usage', run: { inputTokens: 10, outputTokens: 5 } }, 7_010)
    emitter.recordTerminal('resume', 'ok', 7_020)
    emitter.finishTurn('resume', 'completed')
    turn = rows().find((span) => span.kind === 'turn')!
    expect(attrs(turn)).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })

  test('records accepted rate-limit waits and non-blocking background tasks', () => {
    const emitter = new emitterModule.SessionEmitter()
    emitter.beginTurn({ sessionId: 'waits', prompt: 'wait', promptSource: 'automation', startedAt: 8_000 })
    emitter.completeSetup('waits', {
      provider: 'claude-code', model: 'claude', projectRoot: '/repo', origin: 'automation', isResume: false,
    }, 8_005)
    emitter.onEvent('waits', { type: 'background_task_started', taskId: 'bg-1' }, 8_007)
    emitter.acceptRateLimit('waits', 'five-hour', 8_010)
    emitter.onEvent('waits', { type: 'background_task_settled', taskId: 'bg-1', status: 'completed' }, 8_015)
    emitter.resolveRateLimit('waits', 8_020)
    emitter.recordTerminal('waits', 'ok', 8_030)
    emitter.finishTurn('waits', 'completed')
    const spans = rows()
    expect(spans.find((span) => span.kind === 'rate_limit_wait')).toMatchObject({ started_at: 8_010, ended_at: 8_020 })
    const background = spans.find((span) => span.kind === 'background_task')!
    expect(attrs(background)).toMatchObject({ blocking: false, outcomeStatus: 'completed' })
  })

  test('groups bounded turn traces by session and orders them by start time', () => {
    const emitter = new emitterModule.SessionEmitter()
    for (const startedAt of [9_000, 10_000]) {
      emitter.beginTurn({ sessionId: 'ordered', prompt: 'continue', promptSource: 'typed', startedAt })
      emitter.completeSetup('ordered', {
        provider: 'claude-code', model: 'claude', projectRoot: '/repo', origin: 'typed', isResume: startedAt > 9_000,
      }, startedAt + 5)
      emitter.recordTerminal('ordered', 'ok', startedAt + 20)
      emitter.finishTurn('ordered', 'completed', startedAt + 20)
    }

    const turns = rows().filter((span) => span.kind === 'turn')
    expect(turns.map((turn) => turn.started_at)).toEqual([9_000, 10_000])
    expect(turns.every((turn) => turn.session_id === 'ordered')).toBe(true)
    expect(new Set(turns.map((turn) => turn.trace_id)).size).toBe(2)
  })
})
