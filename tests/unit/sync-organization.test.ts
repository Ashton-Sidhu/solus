import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/organization-scope.md §6, §6.1: every queued row of the runner's
// three streams names the organization it goes to, persisted with the row, so
// one organization's acknowledgement removes only its rows and a retry cannot
// choose another destination. Whether a session's transcript or Insights leave
// this machine at all is the session record's fact and the organization's policy.

let mirrorLog: typeof import('@solus/server/sync/mirror/mirror-log')
let outbox: typeof import('@solus/server/sync/outbox/outbox-store')
let transcriptMirror: typeof import('@solus/server/sync/mirror/transcript-mirror')
let insightMirror: typeof import('@solus/server/sync/mirror/insight-mirror')
let records: typeof import('@solus/server/data/sessions/session-records')
let registries: typeof import('@solus/server/data/insights/registries')
let hostCategory: typeof import('@solus/server/host/host-category')
let dbModule: typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-sync-organization-'))
  process.env.SOLUS_DATA_DIR = dataDir
  mirrorLog = await import('@solus/server/sync/mirror/mirror-log')
  outbox = await import('@solus/server/sync/outbox/outbox-store')
  transcriptMirror = await import('@solus/server/sync/mirror/transcript-mirror')
  insightMirror = await import('@solus/server/sync/mirror/insight-mirror')
  records = await import('@solus/server/data/sessions/session-records')
  registries = await import('@solus/server/data/insights/registries')
  hostCategory = await import('@solus/server/host/host-category')
  dbModule = await import('@solus/server/db')
  hostCategory.resetHostCategoryForTests()
})

afterAll(async () => {
  insightMirror.useInsightsPolicy({ syncAllInsights: () => null, optedIn: () => false, attached: () => false })
  await resetTestDatabase()
  dbModule.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  hostCategory.resetHostCategoryForTests()
})

const report = (sessionId: string) => ({ sessionId, provider: 'claude-code' as const, projectPath: '-repo', lastActivityAt: 1 })

/** A destination with no named person: the host's linker delivers it (plans/010-standard-oauth.md). */
const to = (organizationId: string) => ({ organizationId, actorUserId: '' })

describe('the queues name their organization', () => {
  test('mirror rows for A and B interleave in one sequence; an ack for A through a seq removes only A\'s rows at or below it', () => {
    const a1 = mirrorLog.appendMirror(to('A'), 'transcripts', [{ key: 'a:0', payload: 1 }]).lastSeq
    const b1 = mirrorLog.appendMirror(to('B'), 'transcripts', [{ key: 'b:0', payload: 2 }]).lastSeq
    const a2 = mirrorLog.appendMirror(to('A'), 'insights', [{ key: 'span-a', payload: 3 }]).lastSeq
    expect(a1 < b1 && b1 < a2).toBe(true)
    expect(new Set(mirrorLog.mirrorDestinations())).toEqual(new Set([to('A'), to('B')]))
    expect(mirrorLog.listMirror(to('A'), 10).map((item) => item.key)).toEqual(['a:0', 'span-a'])
    expect(mirrorLog.listMirror(to('B'), 10).map((item) => item.key)).toEqual(['b:0'])

    // The ack is A's and reaches past B's row without touching it.
    expect(mirrorLog.ackMirrorThrough(to('A'), a2)).toBe(2)
    expect(mirrorLog.mirrorPendingThrough('A', a2)).toBe(false)
    expect(mirrorLog.mirrorPendingThrough('B', b1)).toBe(true)
    expect(mirrorLog.mirrorDestinations()).toEqual([to('B')])
    expect(mirrorLog.ackMirrorThrough(to('B'), b1)).toBe(1)
    expect(mirrorLog.mirrorDestinations()).toEqual([])
    expect(mirrorLog.appendMirror(to('A'), 'transcripts', [])).toEqual({ count: 0, lastSeq: 0 })
  })

  test('cloud outbox ops are recorded with their organization, listed and acked per organization; a cloud op with none is refused', () => {
    expect(() => outbox.recordOutboxOp({ domain: 'works', resourceId: 'w', name: 'create', payload: {}, destination: 'cloud' })).toThrow(/names the organization/)
    const a1 = outbox.recordOutboxOp({ domain: 'works', resourceId: 'w-a', name: 'create', payload: { title: 'A' }, destination: 'cloud', organizationId: 'A' })
    const b1 = outbox.recordOutboxOp({ domain: 'tasks', resourceId: 't-b', name: 'create', payload: { title: 'B' }, destination: 'cloud', organizationId: 'B' })
    const a2 = outbox.recordOutboxOp({ domain: 'works', resourceId: 'w-a', name: 'update', payload: { content: 'x' }, destination: 'cloud', organizationId: 'A' })
    expect(a1.seq < b1.seq && b1.seq < a2.seq).toBe(true)
    expect(new Set(outbox.cloudOutboxDestinations())).toEqual(new Set([to('A'), to('B')]))
    expect(outbox.listCloudOutboxOps(to('A'), 10).map((entry) => [entry.seq, entry.op.name])).toEqual([[a1.seq, 'create'], [a2.seq, 'update']])
    expect(outbox.listCloudOutboxOps(to('B'), 10).map((entry) => entry.op.id)).toEqual([b1.id])
    // A cloud op never reaches a client courier.
    expect(outbox.listOutboxOps()).toEqual([])

    expect(outbox.ackCloudOutboxOpsThrough(to('A'), a2.seq)).toBe(2)
    expect(outbox.cloudOutboxPendingThrough('A', a2.seq)).toBe(false)
    expect(outbox.cloudOutboxPendingThrough('B', b1.seq)).toBe(true)
    expect(outbox.cloudOutboxDestinations()).toEqual([to('B')])
    expect(outbox.ackCloudOutboxOpsThrough(to('B'), b1.seq)).toBe(1)
    expect(outbox.cloudOutboxDestinations()).toEqual([])
  })

  test('session reports queue per organization, one row per session, and are acked per organization', () => {
    const a = outbox.queueSessionReport(to('A'), { ...report('s-a'), title: 'First' })
    const b = outbox.queueSessionReport(to('B'), report('s-b'))
    // A later report of the same session merges into the queued one and takes a fresh seq.
    const a2 = outbox.queueSessionReport(to('A'), { ...report('s-a'), status: 'running', lastActivityAt: 9 })
    expect(a < b && b < a2).toBe(true)
    expect(new Set(outbox.sessionReportDestinations())).toEqual(new Set([to('A'), to('B')]))
    expect(outbox.listSessionReports(to('A'), 10)).toEqual([{ seq: a2, record: { ...report('s-a'), title: 'First', status: 'running', lastActivityAt: 9 } }])
    expect(outbox.listSessionReports(to('B'), 10).map((entry) => entry.record.sessionId)).toEqual(['s-b'])
    // An ack through the first seq is stale for the re-queued report: it stays.
    expect(outbox.ackSessionReportsThrough(to('A'), a)).toBe(0)
    expect(outbox.sessionReportPendingThrough('A', a2)).toBe(true)
    expect(outbox.ackSessionReportsThrough(to('A'), a2)).toBe(1)
    expect(outbox.sessionReportPendingThrough('B', b)).toBe(true)
    expect(outbox.sessionReportDestinations()).toEqual([to('B')])
    expect(outbox.ackSessionReportsThrough(to('B'), b)).toBe(1)
    expect(outbox.sessionReportDestinations()).toEqual([])
  })
})

describe('what leaves this machine', () => {
  test('a transcript has a destination only when its record is published into an organization', async () => {
    await records.upsertOwnSessionRecord(report('t-local'))
    await records.upsertOwnSessionRecord(report('t-assigned'))
    await records.upsertOwnSessionRecord(report('t-published'))
    await records.assignSessionOrganization('t-assigned', 'A')
    await records.assignSessionOrganization('t-published', 'A')
    // Publishing a Local record is refused: there is no organization to publish it to.
    await records.markSessionPublished('t-local')
    await records.markSessionPublished('t-published')
    expect((await records.getSessionRecord('local', 't-local'))?.publication).toBe('local')
    expect((await records.getSessionRecord('A', 't-published'))?.publication).toBe('published')
    expect(await transcriptMirror.transcriptDestination('t-local')).toBeNull()
    expect(await transcriptMirror.transcriptDestination('t-assigned')).toBeNull()
    expect(await transcriptMirror.transcriptDestination('t-published')).toEqual(to('A'))
    expect(await transcriptMirror.transcriptDestination('t-missing')).toBeNull()
    // Only published records the host settled at boot are touched again.
    await records.setSessionRecordStatus('A', 't-published', 'interrupted')
    await records.setSessionRecordStatus('A', 't-assigned', 'interrupted')
    expect((await transcriptMirror.listOwnInterruptedSessions()).map((entry) => entry.sessionId)).toEqual(['t-published'])
  })

  test('Insights eligibility follows §6.1: never for Local; always from a machine attached to the organization; else the policy, else the opt-in', () => {
    insightMirror.useInsightsPolicy({ syncAllInsights: (organizationId) => ({ A: true, B: false }[organizationId] ?? null), optedIn: (organizationId) => organizationId === 'C', attached: (organizationId) => organizationId === 'B' })
    expect(insightMirror.insightsEligible('local')).toBe(false)
    expect(insightMirror.insightsEligible('A')).toBe(true)
    expect(insightMirror.insightsEligible('B')).toBe(false)
    expect(insightMirror.insightsEligible('C')).toBe(true)
    // An organization the host has not heard of and nobody opted into stays silent.
    expect(insightMirror.insightsEligible('D')).toBe(false)

    // A personal computer shared with B still follows B's policy (organization-vms §1).
    expect(insightMirror.insightsEligible('B')).toBe(false)
    // A managed machine runs its organization's work: B's Insights always leave it, D's do not.
    hostCategory.adoptProvisionedLink({ organizationId: 'B' })
    try {
      expect(insightMirror.insightsEligible('B')).toBe(true)
      expect(insightMirror.insightsEligible('D')).toBe(false)
      expect(insightMirror.insightsEligible('local')).toBe(false)
    } finally {
      hostCategory.resetHostCategoryForTests()
    }
  })

  test('a span is mirrored to its session\'s organization with that organization on the span payload', async () => {
    insightMirror.useInsightsPolicy({ syncAllInsights: () => true, optedIn: () => false, attached: () => false })
    await records.upsertOwnSessionRecord(report('i-a'))
    await records.assignSessionOrganization('i-a', 'A')
    await records.upsertOwnSessionRecord(report('i-b'))
    await records.assignSessionOrganization('i-b', 'B')
    await records.upsertOwnSessionRecord(report('i-local'))
    const span = (spanId: string, sessionId: string, organizationId: string) => ({ organizationId, spanId, traceId: spanId, kind: registries.SPAN_KINDS.turn, name: 'turn', service: registries.SPAN_SERVICES.sessions, sessionId, startedAt: 0, endedAt: 1, status: 'ok' as const })
    expect(await insightMirror.mirrorInsightSpan(span('sp-a', 'i-a', 'A'), [], [])).toBe(1)
    expect(await insightMirror.mirrorInsightSpan(span('sp-b', 'i-b', 'B'), [], [])).toBe(1)
    expect(await insightMirror.mirrorInsightSpan(span('sp-local', 'i-local', 'local'), [], [])).toBe(0)
    expect(mirrorLog.listMirror(to('A'), 10).map((item) => item.payload)).toEqual([{ span: { ...span('sp-a', 'i-a', 'A'), organizationId: 'A' }, events: [] }])
    expect(mirrorLog.listMirror(to('B'), 10).map((item) => item.payload)).toEqual([{ span: { ...span('sp-b', 'i-b', 'B'), organizationId: 'B' }, events: [] }])
    expect(mirrorLog.listMirror(to('local'), 10)).toEqual([])
  })
})

describe('the queues name the person who delivers', () => {
  test('two people in one organization are listed, acknowledged, and dropped apart', async () => {
    // WHY: each person's rows travel with their own token, and removal drops only theirs (plans/010-standard-oauth.md).
    const bob = { organizationId: 'P', actorUserId: 'bob' }
    const carol = { organizationId: 'P', actorUserId: 'carol' }
    const b1 = mirrorLog.appendMirror(bob, 'transcripts', [{ key: 'bob:0', payload: 1 }]).lastSeq
    const c1 = mirrorLog.appendMirror(carol, 'transcripts', [{ key: 'carol:0', payload: 2 }]).lastSeq
    outbox.recordOutboxOp({ domain: 'tasks', resourceId: 't-bob', name: 'comment', payload: {}, destination: 'cloud', organizationId: 'P', actorUserId: 'bob' })
    outbox.queueSessionReport(carol, report('s-carol'))
    expect(mirrorLog.mirrorDestinations()).toEqual(expect.arrayContaining([bob, carol]))
    // An acknowledgement for carol through a later sequence leaves bob's earlier row.
    expect(mirrorLog.ackMirrorThrough(carol, Math.max(b1, c1))).toBe(1)
    expect(mirrorLog.listMirror(bob, 10).map((item) => item.key)).toEqual(['bob:0'])
    // Removal drops everything bob's work left here, and nothing of carol's.
    expect(outbox.dropQueuedFor(bob)).toBe(2)
    expect(mirrorLog.listMirror(bob, 10)).toEqual([])
    expect(outbox.listCloudOutboxOps(bob, 10)).toEqual([])
    expect(outbox.listSessionReports(carol, 10).map((entry) => entry.record.sessionId)).toEqual(['s-carol'])
    outbox.ackSessionReportsThrough(carol, Number.MAX_SAFE_INTEGER)
  })
})
