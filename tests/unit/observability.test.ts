import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ROOT_CONTEXT, trace } from '@opentelemetry/api'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type SpanTableModule = typeof import('../../src/main/observability/span-table')
type MetricsDbModule = typeof import('../../src/main/observability/metrics-db')
type RolloverModule = typeof import('../../src/main/observability/rollover')
type RegistriesModule = typeof import('../../src/main/observability/registries')
type TracerModule = typeof import('../../src/main/observability/tracer')

interface PersistedSpanRow {
  span_id: string
  parent_span_id: string | null
  trace_id: string
  kind: string
  name: string
  service: string
  session_id: string | null
  provider: string | null
  model: string | null
  project_root: string | null
  origin: string | null
  started_at: number
  ended_at: number
  duration_ms: number
  status: string
  attrs: string
}

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let spanTable: SpanTableModule
let metricsDb: MetricsDbModule
let rollover: RolloverModule
let registries: RegistriesModule
let tracer: TracerModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-observability-'))
  process.env.SOLUS_DATA_DIR = dataDir
  spanTable = await import('../../src/main/observability/span-table')
  metricsDb = await import('../../src/main/observability/metrics-db')
  rollover = await import('../../src/main/observability/rollover')
  registries = await import('../../src/main/observability/registries')
  tracer = await import('../../src/main/observability/tracer')
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

describe.serial('the span record', () => {
  test('a recorded span lands in the typed columns its trace joins on', () => {
    // The tracer knows one flat attribute bag; Insights is a SQL surface. The
    // exporter is where the promoted dimensions become columns, the Solus
    // vocabulary leaves `attrs`, and a trace root takes its trace's id — the
    // identity `events` reads a turn's facts through.
    const root = tracer.startSolusSpan({
      kind: registries.SPAN_KINDS.turn,
      name: 'turn',
      service: registries.SPAN_SERVICES.sessions,
      startedAt: 900,
      parent: ROOT_CONTEXT,
    })
    const tool = tracer.startSolusSpan({
      kind: registries.SPAN_KINDS.toolCall,
      name: 'Bash',
      service: registries.SPAN_SERVICES.sessions,
      startedAt: 1_000,
      dimensions: {
        sessionId: 'session-1',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        projectRoot: '/workspace/solus',
        origin: 'typed',
      },
      attrs: { command: 'bun test', isSubagent: false },
      parent: trace.setSpan(ROOT_CONTEXT, root),
    })
    tracer.endSolusSpan(tool, { endedAt: 1_250, status: 'ok', attrs: { exitCode: 0 } })
    tracer.endSolusSpan(root, { endedAt: 1_300, status: 'ok' })

    const rows = metricsDb.getMetricsDb()
      .prepare('SELECT * FROM spans ORDER BY started_at').all() as PersistedSpanRow[]
    const [turn, bash] = rows
    expect(bash).toMatchObject({
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
    // Only the kind's own fields, under the names the field registry resolves:
    // nothing of the OTel vocabulary that carried them here.
    expect(JSON.parse(bash.attrs)).toEqual({ command: 'bun test', isSubagent: false, exitCode: 0 })
    expect(turn.span_id).toBe(turn.trace_id)
    expect(bash.parent_span_id).toBe(turn.span_id)
    expect(bash.trace_id).toBe(turn.trace_id)
  })

  test('the ids Insights shows are the ids an operator pastes into a collector', () => {
    // One turn is one trace in both systems, so a trace found here is findable
    // there by the id this table printed. The stored ids are OTLP's own, at
    // OTLP's widths; a trace root is the single restatement — the table names
    // it by its trace, and the collector by the first half of that trace.
    const root = tracer.startSolusSpan({
      kind: registries.SPAN_KINDS.turn,
      name: 'turn',
      service: registries.SPAN_SERVICES.sessions,
      startedAt: 3_000,
      parent: ROOT_CONTEXT,
    })
    const step = tracer.startSolusSpan({
      kind: registries.SPAN_KINDS.internalDispatchStep,
      name: 'worktree_create',
      service: registries.SPAN_SERVICES.sessions,
      startedAt: 3_010,
      parent: trace.setSpan(ROOT_CONTEXT, root),
    })
    const rootIds = root.spanContext()
    const stepIds = step.spanContext()
    tracer.endSolusSpan(step, { endedAt: 3_020, status: 'ok' })
    tracer.endSolusSpan(root, { endedAt: 3_030, status: 'ok' })

    expect(rootIds.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(stepIds.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(rootIds.traceId.startsWith(rootIds.spanId)).toBe(true)

    const rows = metricsDb.getMetricsDb()
      .prepare('SELECT * FROM spans ORDER BY started_at').all() as PersistedSpanRow[]
    expect(rows.map((row) => [row.span_id, row.trace_id])).toEqual([
      [rootIds.traceId, rootIds.traceId],
      [stepIds.spanId, rootIds.traceId],
    ])
  })

  test('a status OTel cannot express survives the round trip', () => {
    // 'interrupted' is a Solus outcome and OTel has UNSET, OK and ERROR. A turn
    // the user stopped must not read as one that failed, or as one that worked.
    const span = tracer.startSolusSpan({
      kind: registries.SPAN_KINDS.toolCall,
      name: 'Bash',
      service: registries.SPAN_SERVICES.sessions,
      startedAt: 2_000,
      parent: ROOT_CONTEXT,
    })
    tracer.endSolusSpan(span, { endedAt: 2_010, status: 'interrupted' })
    expect(metricsDb.getMetricsDb().prepare('SELECT status FROM spans').get())
      .toEqual({ status: 'interrupted' })
  })

  test('a span is in the record the moment it ends, with nothing to flush', async () => {
    // The record's processor is synchronous on purpose. A batch processor drops
    // on queue overflow, which is a copy's problem to have and not the table
    // Insights answers from — so a burst must arrive whole, and be queryable
    // without waiting for anything.
    for (let index = 0; index < 200; index++) {
      const span = tracer.startSolusSpan({
        kind: registries.SPAN_KINDS.turn,
        name: 'turn',
        service: registries.SPAN_SERVICES.sessions,
        startedAt: 5_000 + index,
        parent: ROOT_CONTEXT,
      })
      tracer.endSolusSpan(span, { endedAt: 5_001 + index, status: 'ok' })
    }
    expect(metricsDb.getMetricsDb().prepare('SELECT COUNT(*) AS spans FROM spans').get())
      .toEqual({ spans: 200 })
  })

  test('the OTLP copy is attached and detached without touching the record', async () => {
    // The settings toggle moves one processor. The record is not a sink among
    // several that an operator can turn off — it is the one Insights reads.
    const copied: string[] = []
    let shutdowns = 0
    const collector = {
      onStart: () => {},
      onEnd: (span: { name: string }) => { copied.push(span.name) },
      forceFlush: async () => {},
      shutdown: async () => { shutdowns += 1 },
    }
    const record = (name: string, startedAt: number) => {
      const span = tracer.startSolusSpan({
        kind: registries.SPAN_KINDS.turn,
        name,
        service: registries.SPAN_SERVICES.sessions,
        startedAt,
        parent: ROOT_CONTEXT,
      })
      tracer.endSolusSpan(span, { endedAt: startedAt + 1, status: 'ok' })
    }

    record('before', 6_000)
    await tracer.replaceOtlpSpanProcessor(collector)
    record('exported', 6_100)
    await tracer.replaceOtlpSpanProcessor(null)
    record('after', 6_200)

    expect(copied).toEqual(['exported'])
    // Detaching flushes the processor it replaced rather than dropping it.
    expect(shutdowns).toBe(1)
    expect(metricsDb.getMetricsDb().prepare('SELECT name FROM spans ORDER BY started_at').all())
      .toEqual([{ name: 'before' }, { name: 'exported' }, { name: 'after' }])
  })

  test('removes only spans older than the rollover cutoff', () => {
    spanTable.writeSpan({
      spanId: 'old', traceId: 'old', kind: registries.SPAN_KINDS.turn, name: 'old', service: registries.SPAN_SERVICES.sessions,
      startedAt: 9_999, endedAt: 10_000, status: 'ok',
    })
    spanTable.writeSpan({
      spanId: 'cutoff', traceId: 'cutoff', kind: registries.SPAN_KINDS.turn, name: 'cutoff', service: registries.SPAN_SERVICES.sessions,
      startedAt: 10_000, endedAt: 10_001, status: 'ok',
    })
    spanTable.writeSpan({
      spanId: 'new', traceId: 'new', kind: registries.SPAN_KINDS.turn, name: 'new', service: registries.SPAN_SERVICES.sessions,
      startedAt: 10_001, endedAt: 10_002, status: 'ok',
    })

    expect(rollover.runMetricsRollover(1, 10_000 + 24 * 60 * 60 * 1000)).toBe(1)
    expect(metricsDb.getMetricsDb().prepare('SELECT span_id FROM spans ORDER BY span_id').all()).toEqual([
      { span_id: 'cutoff' },
      { span_id: 'new' },
    ])
  })

  test('a span outside the registered vocabulary never enters the record', () => {
    // `kind` selects a view and `service` names the owning subsystem, so a span
    // carrying neither is a row no view could claim. It is refused where a span
    // becomes a row — the exporter — and logged rather than thrown, because an
    // exporter that throws takes the ending span's caller down with it.
    for (const unregistered of [
      { kind: 'not_registered' as never, service: registries.SPAN_SERVICES.sessions },
      { kind: registries.SPAN_KINDS.turn, service: 'solus.unknown' as never },
    ]) {
      const span = tracer.startSolusSpan({
        ...unregistered,
        name: 'bad',
        startedAt: 8_000,
        parent: ROOT_CONTEXT,
      })
      tracer.endSolusSpan(span, { endedAt: 8_001, status: 'ok' })
    }

    expect(metricsDb.getMetricsDb().prepare('SELECT COUNT(*) AS spans FROM spans').get())
      .toEqual({ spans: 0 })
  })
})
