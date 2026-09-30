import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/organization-scope.md §6, §6.1: a finished span of a session's turn
// tree is mirrored with its log events, named by the ids the runner's own table
// assigned, to the organization the session's record names — and only when that
// organization's Insights leave this machine. A host-internal span names no
// session and stays local; so does every span of a Local session.

let insightMirror: typeof import('@solus/server/sync/mirror/insight-mirror')
let mirrorLog: typeof import('@solus/server/sync/mirror/mirror-log')
let records: typeof import('@solus/server/data/sessions/session-records')
let spanTable: typeof import('@solus/server/data/insights/span-table')
let metricsDb: typeof import('@solus/server/data/insights/metrics-db')
let registries: typeof import('@solus/server/data/insights/registries')
let dbModule: typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-insight-mirror-'))
  process.env.SOLUS_DATA_DIR = dataDir
  insightMirror = await import('@solus/server/sync/mirror/insight-mirror')
  mirrorLog = await import('@solus/server/sync/mirror/mirror-log')
  records = await import('@solus/server/data/sessions/session-records')
  spanTable = await import('@solus/server/data/insights/span-table')
  metricsDb = await import('@solus/server/data/insights/metrics-db')
  registries = await import('@solus/server/data/insights/registries')
  dbModule = await import('@solus/server/db')
})

afterAll(async () => {
  insightMirror.useInsightsPolicy({ syncAllInsights: () => null, optedIn: () => false, attached: () => false })
  metricsDb.closeMetricsDb()
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

async function sessionIn(sessionId: string, organizationId: string | null): Promise<void> {
  await records.upsertOwnSessionRecord({ sessionId, provider: 'claude-code', projectPath: '-repo', lastActivityAt: 1 })
  if (organizationId) await records.assignSessionOrganization(sessionId, organizationId)
}

function turnSpan(spanId: string, sessionId?: string, organizationId?: string) {
  const span = { spanId, traceId: spanId, kind: registries.SPAN_KINDS.turn, name: 'turn', service: registries.SPAN_SERVICES.sessions, startedAt: 0, endedAt: 100, status: 'ok' as const }
  return sessionId ? { ...span, sessionId, organizationId, userId: 'bob' } : span
}

/** Where a span goes: its organization, carried by the person who acted (plans/010-standard-oauth.md). */
const bobIn = (organizationId: string) => ({ organizationId, actorUserId: 'bob' })

describe('insight mirror', () => {
  test('a span of an organization\'s session is appended to that organization with its events under the ids the table assigned; a host-internal span stays local', async () => {
    insightMirror.useInsightsPolicy({ syncAllInsights: (organizationId) => (organizationId === 'org1' ? true : null), optedIn: () => false, attached: () => false })
    await sessionIn('session-1', 'org1')
    const span = turnSpan('trace-1', 'session-1', 'org1')
    const events = [
      { traceId: 'trace-1', spanId: 'trace-1', occurredAt: 20, level: 'info' as const, name: 'tool_started', tag: 'SessionRuntime', file: 'session-runtime.ts', attrs: { tool: 'Bash' } },
      { traceId: 'trace-1', spanId: 'trace-1', occurredAt: 30, level: 'info' as const, name: 'tool_finished', tag: 'SessionRuntime', file: 'session-runtime.ts' },
    ]
    const eventIds = spanTable.writeSpanRecord(span, events)
    expect(eventIds).toHaveLength(2)
    expect(eventIds[1]).toBe(eventIds[0] + 1)

    expect(await insightMirror.mirrorInsightSpan(span, events, eventIds)).toBe(1)
    expect(await insightMirror.mirrorInsightSpan(turnSpan('boot-1'), [], [])).toBe(0)

    const queued = mirrorLog.listMirror(bobIn('org1'), 10)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ domain: 'insights', key: 'trace-1' })
    // The payload's span names the organization it was mirrored to: the record's, never a guess of the service's.
    expect(queued[0].payload).toEqual({
      span: { ...span, organizationId: 'org1' },
      events: [{ ...events[0], eventId: eventIds[0] }, { ...events[1], eventId: eventIds[1] }],
    })
    expect(mirrorLog.mirrorDestinations()).toEqual([bobIn('org1')])
  })

  test('a Local session, a session with no record, and a session whose organization sends no Insights append nothing', async () => {
    insightMirror.useInsightsPolicy({ syncAllInsights: () => false, optedIn: () => false, attached: () => false })
    mirrorLog.ackMirrorThrough(bobIn('org1'), Number.MAX_SAFE_INTEGER)
    await sessionIn('session-local', null)
    await sessionIn('session-org2', 'org2')
    expect(await insightMirror.mirrorInsightSpan(turnSpan('trace-local', 'session-local'), [], [])).toBe(0)
    expect(await insightMirror.mirrorInsightSpan(turnSpan('trace-unknown', 'session-unknown'), [], [])).toBe(0)
    expect(await insightMirror.mirrorInsightSpan(turnSpan('trace-org2', 'session-org2', 'org2'), [], [])).toBe(0)
    expect(mirrorLog.mirrorDestinations()).toEqual([])

    // The person at this host opts the machine in for org2: its sessions send from now on.
    insightMirror.useInsightsPolicy({ syncAllInsights: () => false, optedIn: (organizationId) => organizationId === 'org2', attached: () => false })
    expect(await insightMirror.mirrorInsightSpan(turnSpan('trace-org2', 'session-org2', 'org2'), [], [])).toBe(1)
    expect(mirrorLog.listMirror(bobIn('org2'), 10).map((item) => item.key)).toEqual(['trace-org2'])
    expect(mirrorLog.listMirror(bobIn('org1'), 10)).toEqual([])
  })
})


test('captured organization routes setup spans before the record exists and never backfills unassigned spans', async () => {
  insightMirror.useInsightsPolicy({ syncAllInsights: () => true, optedIn: () => false, attached: () => false })
  expect(await records.getSessionRecord('org-setup', 'no-record-yet')).toBeNull()
  const setup = turnSpan('setup-before-record', 'no-record-yet', 'org-setup')
  expect(await insightMirror.mirrorInsightSpan(setup, [], [])).toBe(1)
  expect(mirrorLog.listMirror(bobIn('org-setup'), 10)[0]?.payload).toMatchObject({ span: setup })
  await sessionIn('assigned-later', 'org-setup')
  expect(await insightMirror.mirrorInsightSpan(turnSpan('old-local-span', 'assigned-later', 'local'), [], [])).toBe(0)
  expect(await insightMirror.mirrorInsightSpan(turnSpan('unassigned-span', 'assigned-later'), [], [])).toBe(0)
})
