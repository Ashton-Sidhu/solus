import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type FacadeModule = typeof import('../../src/main/observability/facade')
type MetricsDbModule = typeof import('../../src/main/observability/metrics-db')
type RolloverModule = typeof import('../../src/main/observability/rollover')
type RegistriesModule = typeof import('../../src/main/observability/registries')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let facade: FacadeModule
let metricsDb: MetricsDbModule
let rollover: RolloverModule
let registries: RegistriesModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-observability-'))
  process.env.SOLUS_DATA_DIR = dataDir
  facade = await import('../../src/main/observability/facade')
  metricsDb = await import('../../src/main/observability/metrics-db')
  rollover = await import('../../src/main/observability/rollover')
  registries = await import('../../src/main/observability/registries')
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

describe.serial('observability facade', () => {
  test('writes and finalizes a span with its dimensions and merged attrs', () => {
    const spanId = facade.startSpan({
      spanId: 'span-1',
      traceId: 'trace-1',
      parentSpanId: 'parent-1',
      kind: registries.SPAN_KINDS.toolCall,
      name: 'Bash',
      service: registries.SPAN_SERVICES.sessions,
      startedAt: 1_000,
      sessionId: 'session-1',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      projectRoot: '/workspace/solus',
      origin: 'typed',
      attrs: { command: 'bun test', isSubagent: false },
    })
    facade.endSpan(spanId, { endedAt: 1_250, status: 'ok', attrs: { exitCode: 0 } })

    const row = metricsDb.getMetricsDb().prepare('SELECT * FROM spans WHERE span_id = ?').get(spanId) as Record<string, unknown>
    expect(row).toMatchObject({
      span_id: 'span-1',
      parent_span_id: 'parent-1',
      trace_id: 'trace-1',
      kind: 'tool_call',
      name: 'Bash',
      service: 'solus.sessions',
      session_id: 'session-1',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      project_root: '/workspace/solus',
      origin: 'typed',
      started_at: 1_000,
      ended_at: 1_250,
      duration_ms: 250,
      status: 'ok',
    })
    expect(JSON.parse(row.attrs as string)).toEqual({ command: 'bun test', isSubagent: false, exitCode: 0 })
  })

  test('removes only spans older than the rollover cutoff', () => {
    facade.writeSpan({
      spanId: 'old', kind: registries.SPAN_KINDS.turn, name: 'old', service: registries.SPAN_SERVICES.sessions,
      startedAt: 9_999, endedAt: 10_000, status: 'ok',
    })
    facade.writeSpan({
      spanId: 'cutoff', kind: registries.SPAN_KINDS.turn, name: 'cutoff', service: registries.SPAN_SERVICES.sessions,
      startedAt: 10_000, endedAt: 10_001, status: 'ok',
    })
    facade.writeSpan({
      spanId: 'new', kind: registries.SPAN_KINDS.turn, name: 'new', service: registries.SPAN_SERVICES.sessions,
      startedAt: 10_001, endedAt: 10_002, status: 'ok',
    })

    expect(rollover.runMetricsRollover(1, 10_000 + 24 * 60 * 60 * 1000)).toBe(1)
    expect(metricsDb.getMetricsDb().prepare('SELECT span_id FROM spans ORDER BY span_id').all()).toEqual([
      { span_id: 'cutoff' },
      { span_id: 'new' },
    ])
  })

  test('rejects unregistered kinds and services', () => {
    expect(() => facade.writeSpan({
      kind: 'not_registered' as never, name: 'bad', service: registries.SPAN_SERVICES.sessions,
      startedAt: 1, endedAt: 2, status: 'ok',
    })).toThrow('Unregistered span kind')
    expect(() => facade.writeSpan({
      kind: registries.SPAN_KINDS.turn, name: 'bad', service: 'solus.unknown' as never,
      startedAt: 1, endedAt: 2, status: 'ok',
    })).toThrow('Unregistered span service')
  })
})
