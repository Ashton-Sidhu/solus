import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type FacadeModule = typeof import('../../src/main/observability/facade')
type MetricsDbModule = typeof import('../../src/main/observability/metrics-db')
type FieldRegistryModule = typeof import('../../src/main/observability/field-registry')
type RegistriesModule = typeof import('../../src/main/observability/registries')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let facade: FacadeModule
let metricsDb: MetricsDbModule
let fieldRegistry: FieldRegistryModule
let registries: RegistriesModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-metrics-views-'))
  process.env.SOLUS_DATA_DIR = dataDir
  facade = await import('../../src/main/observability/facade')
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

describe.serial('metrics per-kind views', () => {
  test('boot creates one view per registered kind, named from the registry', () => {
    const db = metricsDb.getMetricsDb()
    const views = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all() as Array<{ name: string }>)
      .map((row) => row.name))
    for (const kind of Object.values(registries.SPAN_KINDS)) {
      expect(views.has(fieldRegistry.viewNameForKind(kind))).toBe(true)
    }
  })

  test('view columns match the field registry exactly, in order', () => {
    const db = metricsDb.getMetricsDb()
    for (const view of fieldRegistry.metricsSchema().views) {
      const columns = (db.prepare(`PRAGMA table_info(${view.view})`).all() as Array<{ name: string }>)
        .map((row) => row.name)
      expect(columns).toEqual(view.columns.map((column) => column.name))
    }
  })

  test('tool input fields resolve through the JSON-string attr, and malformed input yields NULL, not an error', () => {
    const base = {
      kind: registries.SPAN_KINDS.toolCall,
      service: registries.SPAN_SERVICES.sessions,
      status: 'ok' as const,
    }
    facade.writeSpan({
      ...base, spanId: 'tool-good', name: 'Bash', startedAt: 1, endedAt: 2,
      attrs: { input: '{"command":"bun run build"}' },
    })
    facade.writeSpan({
      ...base, spanId: 'tool-truncated', name: 'Bash', startedAt: 3, endedAt: 4,
      attrs: { input: '{"command":"bun run bui', inputTruncated: true },
    })

    const rows = metricsDb.getMetricsDb()
      .prepare('SELECT span_id, tool, command FROM tool_calls ORDER BY started_at')
      .all() as Array<{ span_id: string; tool: string; command: string | null }>
    expect(rows).toEqual([
      { span_id: 'tool-good', tool: 'Bash', command: 'bun run build' },
      { span_id: 'tool-truncated', tool: 'Bash', command: null },
    ])
  })

  test('turn attrs lift into typed view columns', () => {
    facade.writeSpan({
      kind: registries.SPAN_KINDS.turn, service: registries.SPAN_SERVICES.sessions,
      spanId: 'turn-1', name: 'turn', startedAt: 10, endedAt: 20, status: 'ok',
      sessionId: 'session-1', model: 'fable',
      attrs: { costUsd: 0.5, promptSource: 'typed', hasThinking: true, toolCallCount: 3 },
    })
    const row = metricsDb.getMetricsDb()
      .prepare('SELECT cost_usd, prompt_source, has_thinking, tool_call_count FROM turns WHERE span_id = ?')
      .get('turn-1') as { cost_usd: number; prompt_source: string; has_thinking: number; tool_call_count: number }
    expect(row).toEqual({ cost_usd: 0.5, prompt_source: 'typed', has_thinking: 1, tool_call_count: 3 })
  })

  test('views only expose their own kind', () => {
    const count = metricsDb.getMetricsDb()
      .prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number }
    expect(count.n).toBe(1)
  })
})
