import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { MetricsTurnPageRequest } from '@solus/contracts/observability-types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type MetricsDbModule = typeof import('@solus/server/observability/metrics-db')
type RegistriesModule = typeof import('@solus/server/observability/registries')
type SpanTableModule = typeof import('@solus/server/observability/span-table')
type TurnPageModule = typeof import('@solus/server/observability/turn-page')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let metricsDb: MetricsDbModule
let turnPageModule: TurnPageModule

const baseRequest: MetricsTurnPageRequest = {
  timeRange: { from: 0, to: 1_000 },
  pageIndex: 0,
  pageSize: 25,
  sort: { field: 'started_at', dir: 'desc' },
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-metrics-turn-page-'))
  process.env.SOLUS_DATA_DIR = dataDir
  const spanTable: SpanTableModule = await import('@solus/server/observability/span-table')
  metricsDb = await import('@solus/server/observability/metrics-db')
  const registries: RegistriesModule = await import('@solus/server/observability/registries')
  turnPageModule = await import('@solus/server/observability/turn-page')
  metricsDb.closeMetricsDb()

  for (let index = 0; index < 120; index++) {
    spanTable.writeSpan({
      spanId: `turn-${String(index).padStart(3, '0')}`,
      traceId: `turn-${String(index).padStart(3, '0')}`,
      kind: registries.SPAN_KINDS.turn,
      name: 'turn',
      service: registries.SPAN_SERVICES.sessions,
      sessionId: index < 60 ? 'session-a' : 'session-b',
      provider: index % 2 === 0 ? 'claude-code' : 'codex',
      model: index % 2 === 0 ? 'opus' : 'gpt',
      startedAt: index,
      endedAt: index + index + 1,
      status: index % 3 === 0 ? 'error' : 'ok',
      attrs: {
        prompt: `Investigate turn ${index}`,
        costUsd: index % 2 === 0 ? 1 : undefined,
        inputTokens: index,
        outputTokens: index * 2,
      },
    })
  }
})

afterAll(() => {
  metricsDb.closeMetricsDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe.serial('Insights turn pagination', () => {
  test('pages rows without truncating the full-range count, chart, or statistics', () => {
    const first = turnPageModule.turnPage(baseRequest)
    expect(first.page.rows).toHaveLength(25)
    expect(first.totalRows).toBe(120)
    expect(first.pageIndex).toBe(0)
    expect(first.statusCounts).toEqual({ ok: 80, error: 40, interrupted: 0 })
    expect(first.stats).toMatchObject({
      counted: 120,
      failed: 40,
      failureRate: 1 / 3,
      totalCostUsd: 60,
      p50DurationMs: 61,
      p95DurationMs: 115,
    })
    expect(first.volume.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(120)
    expect(first.volume.reduce((sum, bucket) => sum + bucket.costUsd, 0)).toBe(60)

    const last = turnPageModule.turnPage({ ...baseRequest, pageIndex: 4 })
    expect(last.page.rows).toHaveLength(20)
    expect(last.totalRows).toBe(120)
  })

  test('applies status, search, scope, time, and sorting before pagination', () => {
    const filtered = turnPageModule.turnPage({
      ...baseRequest,
      timeRange: { from: 30, to: 90 },
      pageSize: 10,
      status: 'error',
      sessionId: 'session-a',
      search: 'turn 3',
      sort: { field: 'started_at', dir: 'asc' },
    })
    expect(filtered.totalRows).toBe(4)
    expect(filtered.page.rows).toHaveLength(4)
    const startedAtIndex = filtered.page.columns.findIndex((column) => column.name === 'started_at')
    expect(filtered.page.rows.map((row) => row[startedAtIndex])).toEqual([30, 33, 36, 39])
    // Status chips describe the same scoped/search result before the active
    // status filter, not merely the current page.
    expect(filtered.statusCounts).toEqual({ ok: 6, error: 4, interrupted: 0 })
    expect(filtered.stats.counted).toBe(4)
    expect(filtered.volume.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(4)
  })

  test('clamps page size and an out-of-range page safely', () => {
    const result = turnPageModule.turnPage({ ...baseRequest, pageIndex: 99, pageSize: 1_000 })
    expect(result.pageSize).toBe(100)
    expect(result.pageIndex).toBe(1)
    expect(result.page.rows).toHaveLength(20)
  })
})
