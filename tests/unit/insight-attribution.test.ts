import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/organization-scope.md §6.1: every span of a turn carries the
// verified acting account and the session's organization, in `metrics.db` on
// the host and in the mirrored `insight_spans` on the Solus API, so an
// organization's Insights can be read per person and never widen past the
// organization asked for.

let emitterModule: typeof import('@solus/server/execution/observability/session-emitter')
let metricsDb: typeof import('@solus/server/data/insights/metrics-db')
let fieldRegistry: typeof import('@solus/server/data/insights/field-registry')
let registries: typeof import('@solus/server/data/insights/registries')
let sinks: typeof import('@solus/server/sync/mirror/mirror-sinks')
let organizationTurns: typeof import('@solus/server/data/insights/api-turns')
let dbModule: typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-insight-attribution-'))
  process.env.SOLUS_DATA_DIR = dataDir
  emitterModule = await import('@solus/server/execution/observability/session-emitter')
  metricsDb = await import('@solus/server/data/insights/metrics-db')
  fieldRegistry = await import('@solus/server/data/insights/field-registry')
  registries = await import('@solus/server/data/insights/registries')
  sinks = await import('@solus/server/sync/mirror/mirror-sinks')
  organizationTurns = await import('@solus/server/data/insights/api-turns')
  dbModule = await import('@solus/server/db')
})

afterAll(async () => {
  metricsDb.closeMetricsDb()
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

interface AttributionRow {
  kind: string
  user_id: string | null
  user_email: string | null
  organization_id: string | null
  status: string
}

function rowsOf(sessionId: string): AttributionRow[] {
  return metricsDb.getMetricsDb().prepare('SELECT kind, user_id, user_email, organization_id, status FROM spans WHERE session_id = ? ORDER BY started_at, kind').all(sessionId) as AttributionRow[]
}

describe('attribution on the host', () => {
  test('a turn begun with an actor and an organization writes them on its open root row, keeps them through setup, and stamps every span at the end', () => {
    const emitter = new emitterModule.SessionEmitter()
    emitter.beginTurn({
      sessionId: 'attr-1', prompt: 'ship it', promptSource: 'typed', startedAt: 1_000, provider: 'claude-code', projectRoot: '/repo',
      actor: { userId: 'alice', email: 'alice@example.test' }, organizationId: 'A',
    })
    expect(rowsOf('attr-1')).toEqual([{ kind: 'turn', user_id: 'alice', user_email: 'alice@example.test', organization_id: 'A', status: 'unknown' }])

    // Setup refines the dimensions with the executed model; attribution is not lost in the refinement.
    emitter.completeSetup('attr-1', { provider: 'claude-code', model: 'claude-sonnet-5', projectRoot: '/repo', origin: 'typed', isResume: false }, 1_010)
    emitter.onEvent('attr-1', { type: 'tool_call', toolName: 'Bash', toolId: 'tool-1', index: 0 }, 1_020)
    emitter.onEvent('attr-1', { type: 'tool_call_complete', toolId: 'tool-1', index: 0, toolInput: '{"command":"bun test"}' }, 1_030)
    emitter.onEvent('attr-1', { type: 'tool_result', toolUseId: 'tool-1', content: 'ok' }, 1_040)
    emitter.recordTerminal('attr-1', 'ok', 1_050)
    expect(emitter.finishTurn('attr-1', 'completed', 1_051)).toBe('completed')

    const rows = rowsOf('attr-1')
    expect(rows.map((row) => row.kind)).toContain('tool_call')
    expect(rows.find((row) => row.kind === 'turn')).toEqual({ kind: 'turn', user_id: 'alice', user_email: 'alice@example.test', organization_id: 'A', status: 'ok' })
    for (const row of rows) expect(row).toMatchObject({ user_id: 'alice', user_email: 'alice@example.test', organization_id: 'A' })
  })

  test('a turn with no known account and no organization leaves the columns null rather than empty', () => {
    const emitter = new emitterModule.SessionEmitter()
    emitter.beginTurn({ sessionId: 'attr-none', prompt: 'hi', promptSource: 'typed', startedAt: 2_000 })
    emitter.recordTerminal('attr-none', 'ok', 2_010)
    emitter.finishTurn('attr-none', 'completed', 2_011)
    expect(rowsOf('attr-none').find((row) => row.kind === 'turn')).toMatchObject({ kind: 'turn', user_id: null, user_email: null, organization_id: null })
  })

  test('the field registry lists the attribution columns on the fact table and on every view', () => {
    const base = fieldRegistry.metricsSchema().base.columns.map((column) => column.name)
    expect(base).toEqual(expect.arrayContaining(['user_id', 'user_email', 'organization_id']))
    const turnFields = fieldRegistry.fieldsForKind(registries.SPAN_KINDS.turn).map((field) => field.name)
    expect(turnFields).toEqual(expect.arrayContaining(['user_id', 'user_email', 'organization_id']))
    for (const view of fieldRegistry.metricsSchema().views) {
      expect(view.columns.map((column) => column.name)).toEqual(expect.arrayContaining(['user_id', 'user_email', 'organization_id']))
    }
  })
})

describe('an organization\'s turns on the Solus API', () => {
  const turn = (traceId: string, userId: string, costUsd: number | undefined, startedAt: number) => ({
    spanId: traceId, traceId, kind: 'turn', name: 'turn', service: 'solus.sessions', sessionId: `session-${traceId}`, provider: 'claude-code', model: 'claude-sonnet-5',
    userId, userEmail: `${userId}@example.test`, startedAt, endedAt: startedAt + 100, status: 'ok',
    attrs: costUsd === undefined ? { inputTokens: 10, outputTokens: 5 } : { costUsd, inputTokens: 10, outputTokens: 5 },
  })

  test('only the requested organization\'s turn roots are read, attributed, with costs on each record', async () => {
    // WHY: one Postgres serves every organization; the organization is bound
    // into every statement, and a child span is not a turn.
    const origin = { organizationId: 'A', hostId: 'H' }
    await sinks.applyMirrorItem(origin, { domain: 'insights', payload: { span: turn('t-1', 'alice', 0.5, 1_000), events: [] } })
    await sinks.applyMirrorItem(origin, { domain: 'insights', payload: { span: turn('t-2', 'bob', 0.25, 2_000), events: [] } })
    await sinks.applyMirrorItem(origin, { domain: 'insights', payload: { span: turn('t-3', 'alice', undefined, 3_000), events: [] } })
    await sinks.applyMirrorItem(origin, { domain: 'insights', payload: { span: { ...turn('t-1', 'alice', 9, 1_010), spanId: 'child-1', parentSpanId: 't-1', kind: 'tool_call', name: 'Bash' }, events: [] } })
    await sinks.applyMirrorItem({ organizationId: 'B', hostId: 'H' }, { domain: 'insights', payload: { span: turn('t-b', 'eve', 4, 1_500), events: [] } })

    const a = await organizationTurns.listApiInsights('A', { limit: 50 }, 0, 4_000)
    expect(a.map(row => [row.traceId, row.userId, row.userEmail, row.costUsd, row.inputTokens])).toEqual([
      ['t-3', 'alice', 'alice@example.test', null, 10],
      ['t-2', 'bob', 'bob@example.test', 0.25, 10],
      ['t-1', 'alice', 'alice@example.test', 0.5, 10],
    ])
    expect(a.every(row => row.hostId === 'H' && row.durationMs === 100)).toBe(true)
    expect((await organizationTurns.listApiInsights('A', { limit: 50, userId: 'alice' }, 0, 4_000)).map(row => row.traceId)).toEqual(['t-3', 't-1'])
    expect((await organizationTurns.listApiInsights('A', { limit: 50 }, 1_500, 2_500)).map(row => row.traceId)).toEqual(['t-2'])
    expect((await organizationTurns.listApiInsights('A', { limit: 1 }, 0, 4_000, { time: 3_000, hostId: 'H', id: 't-3' })).map(row => row.traceId)).toEqual(['t-2', 't-1'])
    expect((await organizationTurns.listApiInsights('B', { limit: 50 }, 0, 4_000)).map(row => row.traceId)).toEqual(['t-b'])
    expect(await organizationTurns.listApiInsights('C', { limit: 50 }, 0, 4_000)).toEqual([])
  })
})


test('individual costs preserve zero and ignore invalid numeric attributes', async () => {
  const base = { kind: 'turn', name: 'turn', service: 'solus.sessions', startedAt: 10, endedAt: 20, status: 'ok' }
  const origin = { organizationId: 'cost-types', hostId: 'H' }
  const entries = [
    { spanId: 'zero', traceId: 'zero', attrs: { costUsd: 0 } },
    { spanId: 'invalid', traceId: 'invalid', attrs: { costUsd: '12' } },
    { spanId: 'invalid-token', traceId: 'invalid-token', attrs: { costUsd: 4, inputTokens: 'bad' } },
    { spanId: 'absent', traceId: 'absent', attrs: {} },
  ]
  for (const span of entries) await sinks.applyMirrorItem(origin, { domain: 'insights', payload: { span: { ...base, ...span }, events: [] } })
  const result = await organizationTurns.listApiInsights(origin.organizationId, { limit: 50 }, 0, 30)
  expect(result).toHaveLength(4)
  expect(result.find(row => row.traceId === 'zero')?.costUsd).toBe(0)
  expect(result.find(row => row.traceId === 'invalid')?.costUsd).toBeNull()
  expect(result.find(row => row.traceId === 'absent')?.costUsd).toBeNull()
})
