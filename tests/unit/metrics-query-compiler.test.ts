import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { MetricsQuerySpec } from '@solus/contracts/observability-types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type SpanTableModule = typeof import('@solus/server/observability/span-table')
type MetricsDbModule = typeof import('@solus/server/observability/metrics-db')
type CompilerModule = typeof import('@solus/server/observability/query-compiler')
type SqlGuardModule = typeof import('@solus/server/observability/sql-guard')
type RegistriesModule = typeof import('@solus/server/observability/registries')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let spanTable: SpanTableModule
let metricsDb: MetricsDbModule
let compiler: CompilerModule
let sqlGuard: SqlGuardModule
let registries: RegistriesModule

const HOUR = 60 * 60 * 1000

function run(spec: MetricsQuerySpec) {
  const compiled = compiler.compileQuerySpec(spec)
  return sqlGuard.runCompiledSql(compiled.sql, compiled.params)
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-metrics-compiler-'))
  process.env.SOLUS_DATA_DIR = dataDir
  spanTable = await import('@solus/server/observability/span-table')
  metricsDb = await import('@solus/server/observability/metrics-db')
  compiler = await import('@solus/server/observability/query-compiler')
  sqlGuard = await import('@solus/server/observability/sql-guard')
  registries = await import('@solus/server/observability/registries')
  metricsDb.closeMetricsDb()

  // Day 1 (epoch hour 0-2): turns and tool calls across two models.
  const { turn, toolCall } = registries.SPAN_KINDS
  const sessions = registries.SPAN_SERVICES.sessions
  const base = { service: sessions, sessionId: 'session-1', provider: 'claude', projectRoot: '/p' }
  spanTable.writeSpan({ ...base, spanId: 't1', traceId: 't1', kind: turn, name: 'turn', model: 'fable', startedAt: 0, endedAt: 1_000, status: 'ok', attrs: { costUsd: 0.5, inputTokens: 10 } })
  spanTable.writeSpan({ ...base, spanId: 't2', traceId: 't2', kind: turn, name: 'turn', model: 'fable', startedAt: HOUR, endedAt: HOUR + 3_000, status: 'ok', attrs: { costUsd: 0.25 } })
  spanTable.writeSpan({ ...base, spanId: 't3', traceId: 't3', kind: turn, name: 'turn', model: 'opus', startedAt: 2 * HOUR, endedAt: 2 * HOUR + 5_000, status: 'error', attrs: {} })
  // Day 2: one more fable turn.
  spanTable.writeSpan({ ...base, spanId: 't4', traceId: 't4', kind: turn, name: 'turn', model: 'fable', startedAt: 24 * HOUR, endedAt: 24 * HOUR + 7_000, status: 'ok', attrs: { costUsd: 0.75 } })

  // 100 Bash calls with durations 1..100 ms for the percentile pass.
  for (let index = 1; index <= 100; index++) {
    spanTable.writeSpan({
      ...base, spanId: `bash-${String(index).padStart(3, '0')}`,
      traceId: `bash-${String(index).padStart(3, '0')}`, kind: toolCall, name: 'Bash',
      startedAt: 10_000 + index, endedAt: 10_000 + index * 2, status: 'ok',
      attrs: { input: '{"command":"bun run build"}', isSubagent: false },
    })
  }
  spanTable.writeSpan({
    ...base, spanId: 'read-1', traceId: 'read-1', kind: toolCall, name: 'Read', startedAt: 10_000, endedAt: 10_500,
    status: 'ok', attrs: { input: '{"file_path":"/p/a.ts"', inputTruncated: true, isSubagent: true },
  })
})

afterAll(() => {
  metricsDb.closeMetricsDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe.serial('metrics query compiler', () => {
  test('counts and averages grouped by a promoted column', () => {
    const result = run({
      filters: [{ field: 'kind', op: 'eq', value: 'turn' }],
      groupBy: [{ field: 'model' }],
      aggregates: [{ fn: 'count' }, { fn: 'avg', field: 'duration_ms' }],
      orderBy: [{ field: 'count', dir: 'desc' }],
    })
    expect(result.columns).toEqual(['model', 'count', 'avg_duration_ms'])
    expect(result.rows).toEqual([
      ['fable', 3, (1_000 + 3_000 + 7_000) / 3],
      ['opus', 1, 5_000],
    ])
  })

  test('timeRange bounds started_at inclusively below and exclusively above', () => {
    const result = run({
      timeRange: { from: HOUR, to: 24 * HOUR },
      filters: [{ field: 'kind', op: 'eq', value: 'turn' }],
      aggregates: [{ fn: 'count' }],
    })
    expect(result.rows).toEqual([[2]])
  })

  test('buckets by day', () => {
    const result = run({
      filters: [{ field: 'kind', op: 'eq', value: 'turn' }],
      groupBy: [{ timeBucket: 'day' }],
      aggregates: [{ fn: 'sum', field: 'duration_ms' }],
      orderBy: [{ field: 'bucket', dir: 'asc' }],
    })
    expect(result.columns).toEqual(['bucket', 'sum_duration_ms'])
    expect(result.rows).toEqual([
      ['1970-01-01', 9_000],
      ['1970-01-02', 7_000],
    ])
  })

  test('computes nearest-rank percentiles beside plain aggregates', () => {
    const result = run({
      filters: [
        { field: 'kind', op: 'eq', value: 'tool_call' },
        { field: 'name', op: 'eq', value: 'Bash' },
      ],
      groupBy: [{ field: 'name' }],
      aggregates: [
        { fn: 'count' },
        { fn: 'p50', field: 'duration_ms' },
        { fn: 'p95', field: 'duration_ms' },
        { fn: 'max', field: 'duration_ms' },
      ],
    })
    expect(result.columns).toEqual(['name', 'count', 'p50_duration_ms', 'p95_duration_ms', 'max_duration_ms'])
    expect(result.rows).toEqual([['Bash', 100, 50, 95, 100]])
  })

  test('percentile with no group keys returns a single row', () => {
    const result = run({
      filters: [{ field: 'kind', op: 'eq', value: 'tool_call' }, { field: 'name', op: 'eq', value: 'Bash' }],
      aggregates: [{ fn: 'p95', field: 'duration_ms', as: 'p95_ms' }],
    })
    expect(result.columns).toEqual(['p95_ms'])
    expect(result.rows).toEqual([[95]])
  })

  test('filters and groups on attrs JSON paths, converting booleans', () => {
    const result = run({
      filters: [
        { field: 'kind', op: 'eq', value: 'tool_call' },
        { field: 'attrs.isSubagent', op: 'eq', value: true },
      ],
      aggregates: [{ fn: 'count' }],
    })
    expect(result.rows).toEqual([[1]])
  })

  test('resolves registry fields through the pinned kind, surviving malformed tool input', () => {
    const result = run({
      filters: [
        { field: 'kind', op: 'eq', value: 'tool_call' },
        { field: 'command', op: 'eq', value: 'bun run build' },
      ],
      aggregates: [{ fn: 'count' }],
    })
    expect(result.rows).toEqual([[100]])
  })

  test('lists spans without aggregates, newest first, capped by limit', () => {
    const result = run({
      filters: [{ field: 'kind', op: 'eq', value: 'turn' }],
      limit: 2,
    })
    expect(result.columns).toContain('attrs')
    const spanIds = result.rows.map((row) => row[result.columns.indexOf('span_id')])
    expect(spanIds).toEqual(['t4', 't3'])
  })

  test("supports 'in' and 'like' filters", () => {
    const inResult = run({
      filters: [{ field: 'kind', op: 'eq', value: 'turn' }, { field: 'model', op: 'in', value: ['opus', 'missing'] }],
      aggregates: [{ fn: 'count' }],
    })
    expect(inResult.rows).toEqual([[1]])
    const likeResult = run({
      filters: [{ field: 'kind', op: 'eq', value: 'tool_call' }, { field: 'name', op: 'like', value: 'Ba%' }],
      aggregates: [{ fn: 'count' }],
    })
    expect(likeResult.rows).toEqual([[100]])
  })

  test('rejects malformed specs with clear errors', () => {
    expect(() => compiler.compileQuerySpec({ filters: [{ field: 'nope', op: 'eq', value: 1 }] }))
      .toThrow('Unknown query field: nope')
    expect(() => compiler.compileQuerySpec({
      filters: [{ field: 'command', op: 'eq', value: 'x' }],
    })).toThrow('registry fields need an eq filter on kind')
    expect(() => compiler.compileQuerySpec({ groupBy: [{ field: 'model' }] }))
      .toThrow('groupBy needs at least one aggregate')
    expect(() => compiler.compileQuerySpec({
      aggregates: [{ fn: 'count' }],
      orderBy: [{ field: 'model', dir: 'asc' }],
    })).toThrow('not an output column')
    expect(() => compiler.compileQuerySpec({
      filters: [{ field: 'model', op: 'in', value: [] }],
    })).toThrow("'in' needs a non-empty array")
    expect(() => compiler.compileQuerySpec({
      aggregates: [{ fn: 'median' as never, field: 'duration_ms' }],
    })).toThrow('Unknown aggregate: median')
    expect(() => compiler.compileQuerySpec({
      filters: [{ field: 'attrs.bad path', op: 'eq', value: 1 }],
    })).toThrow('Invalid attrs path')
    expect(() => compiler.compileQuerySpec({
      aggregates: [{ fn: 'count', as: 'bad alias' }],
    })).toThrow('Invalid aggregate alias')
  })

  test('every value rides in a bind parameter, never in the SQL text', () => {
    const compiled = compiler.compileQuerySpec({
      timeRange: { from: 1, to: 2 },
      filters: [
        { field: 'kind', op: 'eq', value: 'tool_call' },
        { field: 'attrs.isSubagent', op: 'eq', value: true },
      ],
      aggregates: [{ fn: 'count' }],
      limit: 5,
    })
    expect(compiled.params).toEqual([1, 2, 'tool_call', 1, 5])
    expect(compiled.sql).not.toContain('tool_call')
  })
})

describe.serial('declared grain (sourceView)', () => {
  test('a pinned kind declares its view; an unpinned spec declares nothing', () => {
    expect(compiler.compileQuerySpec({
      filters: [{ field: 'kind', op: 'eq', value: 'turn' }],
    }).sourceView).toBe('turns')
    expect(compiler.compileQuerySpec({
      filters: [{ field: 'kind', op: 'eq', value: 'tool_call' }],
      aggregates: [{ fn: 'p95', field: 'duration_ms' }],
    }).sourceView).toBe('events')
    expect(compiler.compileQuerySpec({}).sourceView).toBeUndefined()
  })
})
