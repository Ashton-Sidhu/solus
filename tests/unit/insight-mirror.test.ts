import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/cloud-service-model.md §6: a finished span of a session's turn
// tree is mirrored with its log events, named by the ids the runner's own
// table assigned; a host-internal span names no session and stays local.

let insightMirror: typeof import('@solus/server/mirror/insight-mirror')
let mirrorLog: typeof import('@solus/server/mirror/mirror-log')
let ownership: typeof import('@solus/server/outbox/cloud-ownership')
let spanTable: typeof import('@solus/server/observability/span-table')
let metricsDb: typeof import('@solus/server/observability/metrics-db')
let registries: typeof import('@solus/server/observability/registries')
let dbModule: typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-insight-mirror-'))
  process.env.SOLUS_DATA_DIR = dataDir
  insightMirror = await import('@solus/server/mirror/insight-mirror')
  mirrorLog = await import('@solus/server/mirror/mirror-log')
  ownership = await import('@solus/server/outbox/cloud-ownership')
  spanTable = await import('@solus/server/observability/span-table')
  metricsDb = await import('@solus/server/observability/metrics-db')
  registries = await import('@solus/server/observability/registries')
  dbModule = await import('@solus/server/db')
})

afterAll(async () => {
  ownership.setCloudOwnedOrganization(null)
  metricsDb.closeMetricsDb()
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('insight mirror', () => {
  test('a session span is appended with its events under the ids the table assigned; a host-internal span stays local', () => {
    ownership.setCloudOwnedOrganization('org1')
    const service = registries.SPAN_SERVICES.sessions
    const turnSpan = { spanId: 'trace-1', traceId: 'trace-1', kind: registries.SPAN_KINDS.turn, name: 'turn', service, sessionId: 'session-1', startedAt: 0, endedAt: 100, status: 'ok' as const }
    const events = [
      { traceId: 'trace-1', spanId: 'trace-1', occurredAt: 20, level: 'info' as const, name: 'tool_started', tag: 'ControlPlane', file: 'control-plane.ts', attrs: { tool: 'Bash' } },
      { traceId: 'trace-1', spanId: 'trace-1', occurredAt: 30, level: 'info' as const, name: 'tool_finished', tag: 'ControlPlane', file: 'control-plane.ts' },
    ]
    const eventIds = spanTable.writeSpanRecord(turnSpan, events)
    expect(eventIds).toHaveLength(2)
    expect(eventIds[1]).toBe(eventIds[0] + 1)

    expect(insightMirror.mirrorInsightSpan(turnSpan, events, eventIds)).toBe(1)
    const bootSpan = { spanId: 'boot-1', traceId: 'boot-1', kind: registries.SPAN_KINDS.turn, name: 'boot', service, startedAt: 0, endedAt: 5, status: 'ok' as const }
    expect(insightMirror.mirrorInsightSpan(bootSpan, [], [])).toBe(0)

    const queued = mirrorLog.listMirror(10)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ domain: 'insights', key: 'trace-1' })
    expect(queued[0].payload).toEqual({
      span: turnSpan,
      events: [{ ...events[0], eventId: eventIds[0] }, { ...events[1], eventId: eventIds[1] }],
    })
  })

  test('a host that mirrors nowhere appends nothing, session span or not', () => {
    ownership.setCloudOwnedOrganization(null)
    mirrorLog.ackMirrorThrough(Number.MAX_SAFE_INTEGER)
    const service = registries.SPAN_SERVICES.sessions
    const turnSpan = { spanId: 'trace-2', traceId: 'trace-2', kind: registries.SPAN_KINDS.turn, name: 'turn', service, sessionId: 'session-2', startedAt: 0, endedAt: 1, status: 'ok' as const }
    expect(insightMirror.mirrorInsightSpan(turnSpan, [], [])).toBe(0)
    expect(mirrorLog.listMirror(10)).toEqual([])
  })
})
