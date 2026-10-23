import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/organization-scope.md §6, §6.1; simplify-auth-and-sync.md §4.5: every
// row of the host's one delivery queue names the organization it goes to, persisted with the row, so
// one organization's acknowledgement removes only its rows and a retry cannot
// choose another destination. Whether a session's transcript or Insights leave
// this machine at all is the session record's fact and the organization's policy.

let queue: typeof import('@solus/server/sync/delivery-queue')
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
  queue = await import('@solus/server/sync/delivery-queue')
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

describe('the queue names its organization', () => {
  test('rows for A and B interleave in one sequence; an answer for A through a seq removes only A\'s rows at or below it', () => {
    const a1 = queue.appendDelivery(to('A'), 'transcript', [{ key: 'a:0', payload: 1 }]).lastSeq
    const b1 = queue.appendDelivery(to('B'), 'transcript', [{ key: 'b:0', payload: 2 }]).lastSeq
    const a2 = queue.appendDelivery(to('A'), 'insights', [{ key: 'trace-a', payload: 3 }]).lastSeq
    expect(a1 < b1 && b1 < a2).toBe(true)
    expect(new Set(queue.deliveryDestinations())).toEqual(new Set([to('A'), to('B')]))
    expect(queue.listDelivery(to('A'), 10)).toEqual([{ seq: a1, kind: 'transcript', payload: 1 }, { seq: a2, kind: 'insights', payload: 3 }])
    expect(queue.listDelivery(to('B'), 10).map((item) => item.payload)).toEqual([2])

    // The answer is A's and reaches past B's row without touching it.
    expect(queue.ackDelivery(to('A'), a2, [])).toBe(2)
    expect(queue.deliveryDestinations()).toEqual([to('B')])
    expect(queue.ackDelivery(to('B'), b1, [])).toBe(1)
    expect(queue.deliveryDestinations()).toEqual([])
    expect(queue.appendDelivery(to('A'), 'transcript', [])).toEqual({ count: 0, lastSeq: 0 })
  })

  test('an item the API refused for good stays in the queue, named and counted, and is not sent again', () => {
    const bad = queue.appendDelivery(to('A'), 'activity', [{ key: 'activity-1', payload: { broken: true } }]).lastSeq
    const good = queue.appendDelivery(to('A'), 'transcript', [{ key: 'a:1', payload: 4 }]).lastSeq
    expect(queue.ackDelivery(to('A'), good, [{ seq: bad, error: 'Malformed activity mirror payload' }])).toBe(1)
    expect(queue.listDelivery(to('A'), 10)).toEqual([])
    expect(queue.deliveryDestinations()).toEqual([])
    expect(queue.deliveryBacklog()).toEqual([{ organizationId: 'A', pending: 0, failed: 1 }])
    expect(queue.dropQueuedFor(to('A'))).toBe(1)
  })

  test('a session\'s facts coalesce into one row that takes a fresh seq, so an answer for the older seq keeps the newer facts', () => {
    // WHY: a turn changes its record many times; the queue holds one row per session, not one per change.
    const a = queue.queueSessionFacts(to('A'), { ...report('s-a'), title: 'First' })
    const b = queue.queueSessionFacts(to('B'), report('s-b'))
    const a2 = queue.queueSessionFacts(to('A'), { ...report('s-a'), status: 'running', lastActivityAt: 9 })
    const a3 = queue.queueSessionFacts(to('A'), { ...report('s-a'), lastActivityAt: 3 })
    expect(a < b && b < a2 && a2 < a3).toBe(true)
    expect(queue.listDelivery(to('A'), 10)).toEqual([{ seq: a3, kind: 'session', payload: { ...report('s-a'), title: 'First', status: 'running', lastActivityAt: 9 } }])
    expect(queue.listDelivery(to('B'), 10).map((item) => item.kind)).toEqual(['session'])
    // An answer through the first seq is stale for the coalesced row: it stays.
    expect(queue.ackDelivery(to('A'), a, [])).toBe(0)
    expect(queue.ackDelivery(to('A'), a3, [])).toBe(1)
    expect(queue.ackDelivery(to('B'), b, [])).toBe(1)
    expect(queue.deliveryDestinations()).toEqual([])
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
    hostCategory.adoptProvisionedRegistration({ organizationId: 'B' })
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
    expect(queue.listDelivery(to('A'), 10).map((item) => item.payload)).toEqual([{ spans: [{ span: { ...span('sp-a', 'i-a', 'A'), organizationId: 'A' }, events: [] }] }])
    expect(queue.listDelivery(to('B'), 10).map((item) => item.payload)).toEqual([{ spans: [{ span: { ...span('sp-b', 'i-b', 'B'), organizationId: 'B' }, events: [] }] }])
    expect(queue.listDelivery(to('local'), 10)).toEqual([])
  })
})

describe('the queues name the person who delivers', () => {
  test('two people in one organization are listed, acknowledged, and dropped apart', async () => {
    // WHY: each person's rows travel with their own token, and removal drops only theirs (plans/010-standard-oauth.md).
    const bob = { organizationId: 'P', actorUserId: 'bob' }
    const carol = { organizationId: 'P', actorUserId: 'carol' }
    const b1 = queue.appendDelivery(bob, 'transcript', [{ key: 'bob:0', payload: 1 }]).lastSeq
    const c1 = queue.appendDelivery(carol, 'transcript', [{ key: 'carol:0', payload: 2 }]).lastSeq
    queue.appendDelivery(bob, 'activity', [{ key: 'bob:activity', payload: 3 }])
    queue.queueSessionFacts(carol, report('s-carol'))
    expect(queue.deliveryDestinations()).toEqual(expect.arrayContaining([bob, carol]))
    // An answer for carol through a later sequence leaves bob's earlier row.
    expect(queue.ackDelivery(carol, Math.max(b1, c1), [])).toBe(1)
    expect(queue.listDelivery(bob, 10).map((item) => item.payload)).toContain(1)
    // Removal drops everything bob's work left here, and nothing of carol's.
    expect(queue.dropQueuedFor(bob)).toBe(2)
    expect(queue.listDelivery(bob, 10)).toEqual([])
    expect(queue.listDelivery(carol, 10).map((item) => item.kind)).toEqual(['session'])
    queue.ackDelivery(carol, Number.MAX_SAFE_INTEGER, [])
  })
})
