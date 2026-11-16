import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppCallEnd } from '@solus/server/data/apps/app-store'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const dataDir = mkdtempSync(join(tmpdir(), 'solus-app-call-search-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
let store: typeof import('@solus/server/data/apps/app-store')

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/apps/app-store')
})

afterAll(async () => {
  await resetTestDatabase()
  process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const appId = 'app-search'
const ended: AppCallEnd = { outcome: 'ok', error: null, errorStack: null, resultBytes: 2, logs: [], logsTruncated: false, spans: [], finishedAt: 0 }

async function record(id: string, operation: string, at: number, input: object, end: Partial<AppCallEnd> = {}) {
  await store.insertCall({ id, appId, version: 1, kind: 'operation', operation, caller: { kind: 'schedule', name: 'nightly' }, startedAt: at, input: JSON.stringify(input), inputTruncated: false, runId: null, traceId: null, spanId: null })
  await store.finishCall(id, { ...ended, finishedAt: at + 5, ...end })
}

test('a search of the call log finds a call by the text it holds, in any case, across the whole log', async () => {
  // WHY: the owner looks for the call that touched one record or failed one
  // way. The host searches, so a match is found past the page a view read.
  await store.insertApp({
    id: appId, organizationId: 'local', ownerKey: 'owner', slug: 'search', name: 'Search', description: '', customName: null, customDescription: null, colorHue: null, activeVersion: 1, stopped: false,
    agentAccess: true, repository: '/nowhere', latestRevision: null, project: null, createdBy: { kind: 'system' }, webhookIds: {}, createdAt: 0, updatedAt: 0,
  })
  await record('c1', 'save', 1000, { title: 'Invoice-4471' })
  await record('c2', 'save', 2000, { title: 'other' }, { logs: [{ atMs: 3, level: 'warn', text: 'Slow upstream: 4s' }] })
  await record('c3', 'sync', 3000, {}, { outcome: 'failed', error: 'The token expired' })
  await record('c4', 'sync', 4000, { title: '100%' })
  const ids = async (search: string, limit = 10) => (await store.listCalls(appId, limit, { search })).map((call) => call.id)

  expect(await ids('invoice-4471')).toEqual(['c1'])
  expect(await ids('SLOW UPSTREAM')).toEqual(['c2'])
  expect(await ids('token expired')).toEqual(['c3'])
  // The caller is text to find: the schedule's name matches every call.
  expect(await ids('nightly')).toEqual(['c4', 'c3', 'c2', 'c1'])
  // A wildcard of SQL is text to find, not a pattern.
  expect(await ids('0%')).toEqual(['c4'])
  expect(await ids('_')).toEqual([])
  // The search narrows the read; the page size still holds.
  expect(await ids('save', 1)).toEqual(['c2'])
})

test('a model call is a row of the same log: it keeps its kind, and its prompt is text to find', async () => {
  // WHY: Activity is the one log of an app (docs/plans/app-models.md); a model call that the search cannot find is missing from it.
  await store.insertCall({
    id: 'm1', appId, version: 1, kind: 'model', operation: 'analyst', caller: { kind: 'ui' }, startedAt: 5000,
    input: JSON.stringify({ setting: 'analyst', prompt: 'Compare the release timelines' }), inputTruncated: false, runId: null, traceId: null, spanId: null,
  })
  const found = await store.listCalls(appId, 10, { search: 'release timelines' })
  expect(found.map((call) => [call.id, call.kind, call.operation])).toEqual([['m1', 'model', 'analyst']])
  expect((await store.listCalls(appId, 10, { search: 'invoice-4471' }))[0].kind).toBe('operation')
})
