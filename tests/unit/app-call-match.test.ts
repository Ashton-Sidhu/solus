import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppCaller } from '@solus/contracts/apps'
import type { AppCallEnd } from '@solus/server/data/apps/app-store'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const dataDir = mkdtempSync(join(tmpdir(), 'solus-app-call-match-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
let store: typeof import('@solus/server/data/apps/app-store')
let observability: typeof import('@solus/server/apps/app-observability')

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/apps/app-store')
  observability = await import('@solus/server/apps/app-observability')
})

afterAll(async () => {
  await resetTestDatabase()
  process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const appId = 'app-match'
const ended: AppCallEnd = { outcome: 'ok', error: null, errorStack: null, resultBytes: 2, logs: [], logsTruncated: false, spans: [], finishedAt: 0 }
const workflow: AppCaller = { kind: 'workflow', runId: 'run_8f2c', workflow: 'release', step: 'ask-model' }

async function record(id: string, operation: string, at: number, caller: AppCaller, version: number, end: Partial<AppCallEnd> = {}, kind: 'operation' | 'model' = 'operation') {
  await store.insertCall({ id, appId, version, kind, operation, caller, startedAt: at, input: '{}', inputTruncated: false, runId: caller.kind === 'workflow' ? caller.runId : null, traceId: null, spanId: null })
  await store.finishCall(id, { ...ended, finishedAt: at + 100, ...end })
}

describe('the query of the call log on the host', () => {
  test('each group must match, and a group matches when one of its terms does', async () => {
    // WHY: `operation:summarizeRelease or caller:workflow` and `outcome:failed` are what
    // the Activity query sends; the host must apply them to the whole log, not to a page.
    await store.insertApp({
      id: appId, organizationId: 'local', ownerKey: 'owner', slug: 'match', name: 'Match', description: '', customName: null, customDescription: null, colorHue: null, activeVersion: 14, stopped: false,
      agentAccess: true, repository: '/nowhere', latestRevision: null, project: null, createdBy: { kind: 'system' }, webhookIds: {}, createdAt: 0, updatedAt: 0,
    })
    await record('c1', 'pollRepositories', 1000, { kind: 'schedule', name: 'hourly' }, 13)
    await record('c2', 'summarizeRelease', 2000, workflow, 14, { outcome: 'failed', error: 'TimeoutError: the model call took longer than 30 s' })
    await record('c3', 'getRelease', 3000, { kind: 'agent', sessionId: null }, 14)
    await record('c4', 'addRepository', 4000, workflow, 14)
    await record('m1', 'fast', 5000, { kind: 'ui' }, 14, {}, 'model')
    const ids = async (filter: Parameters<typeof store.listCalls>[2]) => (await store.listCalls(appId, 50, filter)).map((call) => call.id)

    expect(await ids({ match: [[{ field: 'operation', value: 'summarizeRelease' }, { field: 'caller', value: 'workflow' }]] })).toEqual(['c4', 'c2'])
    expect(await ids({ match: [[{ field: 'caller', value: 'workflow' }], [{ field: 'outcome', value: 'failed' }]] })).toEqual(['c2'])
    // Operation names and words take any case.
    expect(await ids({ match: [[{ field: 'operation', value: 'GETRELEASE' }]] })).toEqual(['c3'])
    expect(await ids({ match: [[{ field: 'version', value: '13' }]] })).toEqual(['c1'])
    // A version that is not a number matches no call; it does not fail the read.
    expect(await ids({ match: [[{ field: 'version', value: 'latest' }]] })).toEqual([])
    expect(await ids({ match: [[{ field: 'run', value: 'run_8f2c' }]] })).toEqual(['c4', 'c2'])
    expect(await ids({ match: [[{ field: 'error', value: 'took longer' }]] })).toEqual(['c2'])
    expect(await ids({ match: [[{ field: 'text', value: 'hourly' }]] })).toEqual(['c1'])
    // A wildcard of SQL in a value is text to find.
    expect(await ids({ match: [[{ field: 'error', value: '%' }]] })).toEqual([])
    // The Calls and Model calls switch.
    expect(await ids({ kind: 'model' })).toEqual(['m1'])
    expect(await ids({ kind: 'operation', since: 3000 })).toEqual(['c4', 'c3'])
    // A range the chart zoomed to: from `since`, up to but not at `until`.
    expect(await ids({ kind: 'operation', since: 2000, until: 4000 })).toEqual(['c3', 'c2'])
  })

  test('the numbers of a zoomed range end at its end, not at now', async () => {
    // WHY: dragging across the Activity chart narrows the query to a range in the past; its bars
    // and its totals must count only the calls in that range, with the last bar ending at its end.
    const stats = await observability.appCallStats(appId, { kind: 'operation', since: 2000, until: 4000 }, 10 * 60_000)
    expect(stats.calls).toBe(2)
    expect(stats.failed).toBe(1)
    expect(stats.until).toBe(4000)
    // A range that ends after now ends at now.
    expect((await observability.appCallStats(appId, { kind: 'operation', until: 99 * 60_000 }, 10 * 60_000)).until).toBe(10 * 60_000)
  })
})

describe('the numbers of the Activity chart', () => {
  const timing = (startedAt: number, durationMs: number | null, outcome: 'ok' | 'failed' | 'running' = 'ok') =>
    ({ operation: 'op', startedAt, finishedAt: durationMs === null ? null : startedAt + durationMs, outcome })
  const HOUR = 3_600_000
  const now = 100 * HOUR

  test('the last 24 hours are 24 bars of an hour, the last one ending now', () => {
    const stats = observability.callStatsFrom([timing(now - 30 * 60_000, 100), timing(now - 23.5 * HOUR, 300, 'failed'), timing(now - 60_000, null, 'running')], now - 24 * HOUR, now)
    expect(stats.bucketMs).toBe(HOUR)
    expect(stats.buckets).toHaveLength(24)
    expect(stats.buckets.at(-1)?.start).toBe(now - HOUR)
    expect(stats.buckets[0]).toEqual({ start: now - 24 * HOUR, calls: 1, failed: 1 })
    expect(stats.buckets.at(-1)?.calls).toBe(2)
    expect(stats.calls).toBe(3)
    expect(stats.failed).toBe(1)
    // A call that still runs has no duration yet.
    expect([stats.p50Ms, stats.p95Ms]).toEqual([100, 300])
  })

  test('a longer range takes larger bars, never more than the chart can draw', () => {
    // WHY: a week of hour bars is 168 slivers; the chart must stay readable at any range.
    const week = observability.callStatsFrom([], now - 7 * 24 * HOUR, now)
    expect(week.bucketMs).toBe(6 * HOUR)
    expect(week.buckets.length).toBeLessThanOrEqual(36)
    expect(observability.callStatsFrom([], now - HOUR, now).bucketMs).toBe(5 * 60_000)
  })

  test('with no start, the range starts at the oldest call that passes', () => {
    const stats = observability.callStatsFrom([timing(now - 3 * 24 * HOUR, 10), timing(now - HOUR, 10)], undefined, now)
    expect(stats.since).toBe(now - 3 * 24 * HOUR)
    expect(stats.buckets[0].calls).toBe(1)
    expect(stats.buckets.reduce((sum, bucket) => sum + bucket.calls, 0)).toBe(2)
    expect(observability.callStatsFrom([], undefined, now).since).toBe(now - 24 * HOUR)
  })
})
