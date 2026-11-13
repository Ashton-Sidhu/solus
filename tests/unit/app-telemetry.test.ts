import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-node'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

type EmitterModule = typeof import('@solus/server/execution/observability/app-emitter')
type TracerModule = typeof import('@solus/server/execution/observability/tracer')
type MetricsDbModule = typeof import('@solus/server/data/insights/metrics-db')
type TelemetryModule = typeof import('@solus/server/apps/app-telemetry')

/**
 * An app's telemetry as OpenTelemetry (docs/plans/apps.md §9.4). These tests
 * read the spans as a collector gets them (the OTLP copy, here an exporter in
 * memory) and as Insights keeps them (`metrics.db`).
 */

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let emitter: EmitterModule
let tracer: TracerModule
let metricsDb: MetricsDbModule
let telemetry: TelemetryModule
const collector = new InMemorySpanExporter()

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-app-telemetry-'))
  process.env.SOLUS_DATA_DIR = dataDir
  metricsDb = await import('@solus/server/data/insights/metrics-db')
  tracer = await import('@solus/server/execution/observability/tracer')
  emitter = await import('@solus/server/execution/observability/app-emitter')
  telemetry = await import('@solus/server/apps/app-telemetry')
  // The copy an owner turns on in Settings → Telemetry: every span the tracer ends goes to it.
  await tracer.replaceOtlpSpanProcessor(new SimpleSpanProcessor(collector))
})

afterEach(() => {
  collector.reset()
  telemetry.setAppTelemetry(null)
  metricsDb.closeMetricsDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `metrics.db${suffix}`), { force: true })
})

afterAll(async () => {
  await tracer.replaceOtlpSpanProcessor(null)
  ;(await import('@solus/server/db')).closeDb()
  metricsDb.closeMetricsDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const START = Date.parse('2026-11-13T12:00:00Z')
const facts = (extra: object = {}) => ({
  callId: 'call-1', appId: 'app-1', appSlug: 'reports', appVersion: 3, organizationId: 'local',
  operation: 'save', operationKind: 'mutation' as const, caller: { kind: 'ui' as const }, startedAt: START, ...extra,
})
const named = (name: string): ReadableSpan => {
  const span = collector.getFinishedSpans().find((candidate) => candidate.name === name)
  if (!span) throw new Error(`The collector has no span named ${name}.`)
  return span
}
const epochMs = (time: [number, number]) => Math.round(time[0] * 1000 + time[1] / 1e6)

describe.serial('an app call as OpenTelemetry', () => {
  test('a call is one span with W3C ids, and each thing it waited for is a child span with the names of the conventions', () => {
    // WHY: a collector's own views (an HTTP view, a service map, an error
    // list) read the standard names. A trace with names of our own would need
    // a mapping at every collector.
    const call = emitter.otelAppTelemetry(facts())
    expect(call.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(call.spanId).toMatch(/^[0-9a-f]{16}$/)
    call.work({ kind: 'fetch', name: 'POST api.example.com', startMs: 5, durationMs: 120, ok: false, detail: '503', attributes: { 'http.request.method': 'POST', 'server.address': 'api.example.com', 'server.port': 443, 'url.scheme': 'https', 'http.response.status_code': 503, 'error.type': '503' } })
    call.work({ kind: 'sql', name: '2 statements', startMs: 0, durationMs: 4, ok: true, attributes: { 'db.system.name': 'sqlite', 'db.operation.batch.size': 2 } })
    call.end({ endedAt: START + 200, resultBytes: 12 })

    const root = named('save')
    expect(root.spanContext()).toMatchObject({ traceId: call.traceId, spanId: call.spanId })
    expect(root.parentSpanContext).toBeUndefined()
    expect(root.kind).toBe(SpanKind.INTERNAL)
    expect(root.status.code).toBe(SpanStatusCode.OK)
    expect(root.resource.attributes['service.name']).toBe('solus')
    expect(root.attributes).toMatchObject({
      'solus.kind': 'app_call', 'solus.service': 'solus.apps', 'solus.organization_id': 'local',
      appId: 'app-1', appSlug: 'reports', appVersion: 3, operationKind: 'mutation', caller: 'ui', callId: 'call-1',
      'code.function.name': 'save', resultBytes: 12,
    })
    expect([epochMs(root.startTime), epochMs(root.endTime)]).toEqual([START, START + 200])

    const request = named('POST api.example.com')
    expect(request.spanContext().traceId).toBe(call.traceId ?? '')
    expect(request.parentSpanContext?.spanId).toBe(call.spanId ?? '')
    // An outgoing request is a CLIENT span, and one that the server refused is an error with its `error.type`.
    expect(request.kind).toBe(SpanKind.CLIENT)
    expect(request.status.code).toBe(SpanStatusCode.ERROR)
    expect(request.attributes).toMatchObject({ 'http.request.method': 'POST', 'server.address': 'api.example.com', 'server.port': 443, 'http.response.status_code': 503, 'error.type': '503', work: 'fetch' })
    // The runner measured the times; the span has them, not the time the host heard of it.
    expect([epochMs(request.startTime), epochMs(request.endTime)]).toEqual([START + 5, START + 125])
    expect(named('2 statements').attributes).toMatchObject({ 'db.system.name': 'sqlite', 'db.operation.batch.size': 2, work: 'sql' })
  })

  test('a failed call is an error span with an exception event, and each line the app logged is an event of the span', () => {
    const call = emitter.otelAppTelemetry(facts({ operation: 'broken' }))
    call.log({ atMs: 10, level: 'log', text: 'saving Q3' })
    call.log({ atMs: 20, level: 'error', text: 'about to fail' })
    call.end({ endedAt: START + 50, error: { message: 'the report is broken', stack: 'Error: the report is broken\n    at broken (app.ts:3:9)' }, resultBytes: null })

    const root = named('broken')
    expect(root.status.code).toBe(SpanStatusCode.ERROR)
    expect(root.attributes).toMatchObject({ error: 'the report is broken', 'error.type': 'AppOperationError', 'solus.status': 'error' })
    expect(root.events.map((event) => [event.name, epochMs(event.time)])).toEqual([['app_log', START + 10], ['app_log', START + 20], ['exception', START + 50]])
    // `console.log` has no level of its own in OpenTelemetry: it is `info`.
    expect(root.events[0]?.attributes).toMatchObject({ message: 'saving Q3', 'log.level': 'info' })
    expect(root.events[1]?.attributes).toMatchObject({ message: 'about to fail', 'log.level': 'error' })
    expect(root.events[2]?.attributes).toMatchObject({ 'exception.type': 'AppOperationError', 'exception.message': 'the report is broken' })
    expect(String(root.events[2]?.attributes?.['exception.stacktrace'])).toContain('at broken (app.ts:3:9)')
  })

  test('a step\'s operation is a child of the execution of its run, in one trace', () => {
    // WHY: a run is read as one trace: the function, its steps, and the
    // operations the steps ran. Three unrelated traces would hide which call
    // made a run slow.
    const run = emitter.otelAppTelemetry(facts({ callId: 'call-run', operation: 'build', operationKind: 'workflow', caller: { kind: 'workflow', runId: 'run-1', workflow: 'build', step: '' } }))
    run.work({ kind: 'step', name: 'count', startMs: 1, durationMs: 30, ok: true, attributes: { step: 'count', attempt: 1 } })
    const step = emitter.otelAppTelemetry(facts({ callId: 'call-step', caller: { kind: 'workflow', runId: 'run-1', workflow: 'build', step: 'save' }, startedAt: START + 40 }))
    step.end({ endedAt: START + 60, resultBytes: 4 })
    run.end({ endedAt: START + 70, resultBytes: 10 })

    expect(step.traceId).toBe(run.traceId)
    expect(named('save').parentSpanContext?.spanId).toBe(run.spanId ?? '')
    expect(named('build').attributes).toMatchObject({ 'solus.kind': 'app_run', operationKind: 'workflow', runId: 'run-1' })
    expect(named('save').attributes).toMatchObject({ 'solus.kind': 'app_call', runId: 'run-1', step: 'save', caller: 'workflow' })
    // After the execution ended, a call of the same run is a trace of its own: its parent is gone.
    const later = emitter.otelAppTelemetry(facts({ callId: 'call-later', caller: { kind: 'workflow', runId: 'run-1', workflow: 'build', step: 'again' } }))
    later.end({ endedAt: START + 90, resultBytes: 1 })
    expect(later.traceId).not.toBe(run.traceId)
  })

  test('Insights keeps the same spans and log lines in metrics.db, and an agent\'s call names its session', () => {
    const call = emitter.otelAppTelemetry(facts({ caller: { kind: 'agent', sessionId: 'session-9' } }))
    call.log({ atMs: 3, level: 'warn', text: 'slow' })
    call.work({ kind: 'tool', name: 'linear.list_issues', startMs: 1, durationMs: 9, ok: true, attributes: { 'gen_ai.tool.name': 'list_issues', integration: 'linear' } })
    call.end({ endedAt: START + 15, resultBytes: 2 })

    const db = metricsDb.getMetricsDb()
    const rows = db.prepare('SELECT kind, name, service, session_id, status, trace_id, parent_span_id, attrs FROM spans ORDER BY kind').all() as { kind: string; name: string; service: string; session_id: string | null; status: string; trace_id: string; parent_span_id: string | null; attrs: string }[]
    expect(rows.map((row) => [row.kind, row.name, row.service, row.status, row.trace_id])).toEqual([
      ['app_call', 'save', 'solus.apps', 'ok', call.traceId ?? ''],
      ['app_work', 'linear.list_issues', 'solus.apps', 'ok', call.traceId ?? ''],
    ])
    expect(rows[0]?.session_id).toBe('session-9')
    expect(JSON.parse(rows[0]?.attrs ?? '{}')).toMatchObject({ appSlug: 'reports', caller: 'agent', callId: 'call-1' })
    expect(JSON.parse(rows[1]?.attrs ?? '{}')).toMatchObject({ work: 'tool', integration: 'linear', 'gen_ai.tool.name': 'list_issues' })
    expect(db.prepare('SELECT level, name, tag, file, attrs FROM log_events').all()).toEqual([{ level: 'warn', name: 'app_log', tag: 'app', file: 'app.ts', attrs: '{"message":"slow"}' }])
  })

  test('the apps domain runs with no tracer: a call then has no trace id, and nothing throws', () => {
    // WHY: the tracer reaches metrics.db. A host or a test that has none must still run an app.
    const none = telemetry.startAppCallTelemetry(facts())
    expect([none.traceId, none.spanId]).toEqual([null, null])
    none.log({ atMs: 1, level: 'log', text: 'x' })
    none.end({ endedAt: START + 1, resultBytes: 0 })
    telemetry.setAppTelemetry(() => { throw new Error('the tracer is broken') })
    expect(telemetry.startAppCallTelemetry(facts()).traceId).toBeNull()
    telemetry.setAppTelemetry(emitter.otelAppTelemetry)
    expect(telemetry.startAppCallTelemetry(facts()).traceId).toMatch(/^[0-9a-f]{32}$/)
  })
})
