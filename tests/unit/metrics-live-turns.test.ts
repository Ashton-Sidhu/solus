import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ROOT_CONTEXT, trace } from '@opentelemetry/api'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type MetricsDbModule = typeof import('@solus/server/data/insights/metrics-db')
type RegistriesModule = typeof import('@solus/server/data/insights/registries')
type TracerModule = typeof import('@solus/server/execution/observability/tracer')
type RollupsModule = typeof import('@solus/server/data/insights/rollups')
type SpanTableModule = typeof import('@solus/server/data/insights/span-table')

interface PersistedSpanRow {
  span_id: string
  trace_id: string
  kind: string
  started_at: number
  ended_at: number | null
  duration_ms: number | null
  status: string
}

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let metricsDb: MetricsDbModule
let registries: RegistriesModule
let tracer: TracerModule
let rollups: RollupsModule
let spanTable: SpanTableModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-live-turns-'))
  process.env.SOLUS_DATA_DIR = dataDir
  metricsDb = await import('@solus/server/data/insights/metrics-db')
  registries = await import('@solus/server/data/insights/registries')
  tracer = await import('@solus/server/execution/observability/tracer')
  rollups = await import('@solus/server/data/insights/rollups')
  spanTable = await import('@solus/server/data/insights/span-table')
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

function spanRows(): PersistedSpanRow[] {
  // SAFETY: the SELECT names the columns `PersistedSpanRow` declares.
  return metricsDb.getMetricsDb()
    .prepare('SELECT span_id, trace_id, kind, started_at, ended_at, duration_ms, status FROM spans ORDER BY started_at')
    .all() as PersistedSpanRow[]
}

// WHY: Insights doubles as a monitor only if a turn is readable while it runs.
// The exporter writes a span when it ends, so a running turn had no root row
// and its trace read as "no spans recorded" until it settled. The root is
// written open at start and replaced by the finished span at the end.
describe.serial('a running turn', () => {
  test('is readable before it ends, with no end and no status yet', () => {
    const root = tracer.startSolusSpan({
      kind: registries.SPAN_KINDS.turn,
      name: 'turn',
      service: registries.SPAN_SERVICES.sessions,
      startedAt: 1_000,
      dimensions: { sessionId: 'session-1' },
      parent: ROOT_CONTEXT,
    })
    const tool = tracer.startSolusSpan({
      kind: registries.SPAN_KINDS.toolCall,
      name: 'Bash',
      service: registries.SPAN_SERVICES.sessions,
      startedAt: 1_100,
      parent: trace.setSpan(ROOT_CONTEXT, root),
    })
    tracer.endSolusSpan(tool, { endedAt: 1_200, status: 'ok' })

    const [turn, bash] = spanRows()
    expect(turn).toMatchObject({ kind: 'turn', ended_at: null, duration_ms: null, status: 'unknown' })
    expect(bash).toMatchObject({ kind: 'tool_call', ended_at: 1_200 })

    // The waterfall's read of it: a root with its finished child under it.
    const readable = rollups.turnTrace(turn.trace_id)
    expect(readable.spans.map((span) => span.kind)).toEqual(['turn', 'tool_call'])
    expect(readable.spans[0].endedAt).toBeNull()

    tracer.endSolusSpan(root, { endedAt: 1_300, status: 'ok' })
  })

  test('the finished turn replaces the open row rather than sitting beside it', () => {
    const root = tracer.startSolusSpan({
      kind: registries.SPAN_KINDS.turn,
      name: 'turn',
      service: registries.SPAN_SERVICES.sessions,
      startedAt: 2_000,
      parent: ROOT_CONTEXT,
    })
    tracer.endSolusSpan(root, { endedAt: 2_500, status: 'ok' })

    const rows = spanRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ started_at: 2_000, ended_at: 2_500, duration_ms: 500, status: 'ok' })
  })

  // WHY: clients re-read the turn list when a turn's row changes, in place of
  // polling. The announcement must come after the write — a client that reads
  // on it before the commit shows the old "Running" row as if it were current.
  test('announces the start and the end of a turn, each after its row is readable', () => {
    const seen: { status: string; storedStatus: string | undefined }[] = []
    const stop = spanTable.onTurnRowWritten((change) => {
      const stored = spanRows().find((row) => row.trace_id === change.traceId)
      seen.push({ status: change.status, storedStatus: stored?.status })
      expect(change.sessionId).toBe('session-4')
    })
    try {
      const root = tracer.startSolusSpan({
        kind: registries.SPAN_KINDS.turn,
        name: 'turn',
        service: registries.SPAN_SERVICES.sessions,
        startedAt: 4_000,
        dimensions: { sessionId: 'session-4' },
        parent: ROOT_CONTEXT,
      })
      const tool = tracer.startSolusSpan({
        kind: registries.SPAN_KINDS.toolCall,
        name: 'Bash',
        service: registries.SPAN_SERVICES.sessions,
        startedAt: 4_100,
        parent: trace.setSpan(ROOT_CONTEXT, root),
      })
      tracer.endSolusSpan(tool, { endedAt: 4_200, status: 'ok' })
      tracer.endSolusSpan(root, { endedAt: 4_500, status: 'error' })
    } finally {
      stop()
    }
    // Two announcements, not one per span: a tool call is not a turn row.
    expect(seen).toEqual([
      { status: 'unknown', storedStatus: 'unknown' },
      { status: 'error', storedStatus: 'error' },
    ])
  })

  // WHY: a running turn is listed from its open row. What the turn learns
  // after it starts — the model that runs, the task it runs under — must reach
  // that row then, or the list shows "—" until the turn ends.
  test('what a running turn learns is written to its open row, and announced', () => {
    const seen: string[] = []
    const stop = spanTable.onTurnRowWritten((change) => seen.push(change.status))
    try {
      const root = tracer.startSolusSpan({
        kind: registries.SPAN_KINDS.turn,
        name: 'turn',
        service: registries.SPAN_SERVICES.sessions,
        startedAt: 5_000,
        dimensions: { sessionId: 'session-5', provider: 'claude' },
        parent: ROOT_CONTEXT,
      })
      tracer.updateOpenTurn(root, { attrs: { taskTitle: 'Ship it' }, dimensions: { sessionId: 'session-5', provider: 'claude', model: 'claude-opus-5-5' } })

      const open = metricsDb.getMetricsDb()
        .prepare('SELECT model, ended_at, attrs FROM spans WHERE kind = ?')
        .get('turn') as { model: string | null; ended_at: number | null; attrs: string }
      expect(open).toMatchObject({ model: 'claude-opus-5-5', ended_at: null })
      expect(JSON.parse(open.attrs)).toMatchObject({ taskTitle: 'Ship it' })

      tracer.endSolusSpan(root, { endedAt: 5_500, status: 'ok' })
      // After the end the finished row is the record; an update is not written.
      tracer.updateOpenTurn(root, { dimensions: { model: 'other-model' } })
      expect(spanRows()[0]).toMatchObject({ ended_at: 5_500, status: 'ok' })
    } finally {
      stop()
    }
    expect(seen).toEqual(['unknown', 'unknown', 'ok'])
  })

  // WHY: a row is open only while the process that started it runs. A host
  // that stopped mid-turn left the row open, and the list showed it running
  // for ever — a lying indicator.
  test('a turn a stopped host left open is closed as interrupted where its work ended', () => {
    const db = metricsDb.getMetricsDb()
    const insert = db.prepare(`INSERT INTO spans (span_id, parent_span_id, trace_id, kind, name, service, started_at, ended_at, duration_ms, status, attrs)
      VALUES (?, ?, ?, ?, 'x', 'sessions', ?, ?, ?, ?, '{}')`)
    insert.run('left-open', null, 'left-open', 'turn', 6_000, null, null, 'unknown')
    insert.run('its-tool', 'left-open', 'left-open', 'tool_call', 6_100, 6_400, 300, 'ok')
    insert.run('bare-open', null, 'bare-open', 'turn', 7_000, null, null, 'unknown')
    insert.run('finished', null, 'finished', 'turn', 8_000, 8_200, 200, 'ok')

    expect(metricsDb.closeAbandonedTurns(db)).toBe(2)

    const byId = new Map(spanRows().map((row) => [row.span_id, row]))
    expect(byId.get('left-open')).toMatchObject({ status: 'interrupted', ended_at: 6_400, duration_ms: 400 })
    expect(byId.get('bare-open')).toMatchObject({ status: 'interrupted', ended_at: 7_000, duration_ms: 0 })
    expect(byId.get('finished')).toMatchObject({ status: 'ok', ended_at: 8_200 })
  })

  test('only a turn is written open — a tool call is recorded once, when it ends', () => {
    const tool = tracer.startSolusSpan({
      kind: registries.SPAN_KINDS.toolCall,
      name: 'Read',
      service: registries.SPAN_SERVICES.sessions,
      startedAt: 3_000,
      parent: ROOT_CONTEXT,
    })
    expect(spanRows()).toHaveLength(0)
    tracer.endSolusSpan(tool, { endedAt: 3_100, status: 'ok' })
    expect(spanRows()).toHaveLength(1)
  })
})
