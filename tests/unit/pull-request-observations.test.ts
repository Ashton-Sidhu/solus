import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

/**
 * `pull_request_observations`: PR facts once per organization and source
 * authority, and the stored `keeps_session` bit on the links that read them
 * (plans/029 §5.1; plans/data-model-validation/relationship-semantics.sh and
 * relationship-benchmark.sh). The observation and every dependent bit are one
 * transaction; a title-only change writes no link; the session list's candidate
 * query reads the bit through its covering index.
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))

const PERSON = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }
const REPO = 'github.com/x/r'
const url = (number: number) => `https://github.com/x/r/pull/${number}`
/** SAFETY: the stores read only these fields of a pull request. */
const observed = (state: 'open' | 'merged' | 'closed', title = 'PR') => ({ title, state, draft: false, updatedAt: '2026-10-01T10:00:00Z' }) as never

let dataDir: string
let db: typeof import('@solus/server/db')
let database: typeof import('@solus/server/db/database')
let sessionPrs: typeof import('@solus/server/data/sessions/session-pull-requests')
let sessionRecords: typeof import('@solus/server/data/sessions/session-records')
let sessionStates: typeof import('@solus/server/data/sessions/session-states')
let observations: typeof import('@solus/server/data/links/pull-request-observations')
let taskStore: typeof import('@solus/server/data/tasks/task-store')
let tasks: typeof import('@solus/server/data/tasks/task')
let taskLinks: typeof import('@solus/server/data/tasks/task-links')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-pr-observations-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  database = await import('@solus/server/db/database')
  sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
  sessionRecords = await import('@solus/server/data/sessions/session-records')
  sessionStates = await import('@solus/server/data/sessions/session-states')
  observations = await import('@solus/server/data/links/pull-request-observations')
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
  taskLinks = await import('@solus/server/data/tasks/task-links')
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const bitRow = z.object({ source_id: z.string(), authority_key: z.string().nullable(), keeps_session: z.number(), created_at: z.number() })
const observationRow = z.object({ organization_id: z.string(), authority_key: z.string(), state: z.string(), title: z.string() })

async function bits(number: number) {
  return bitRow.array().parse(await database.getDatabase().all(sql`
    SELECT source_id, authority_key, keeps_session, created_at FROM resource_links WHERE target_kind = 'pr' AND number = ${number} ORDER BY source_kind, source_id`))
}

async function stored(number: number) {
  return observationRow.array().parse(await database.getDatabase().all(sql`
    SELECT organization_id, authority_key, state, title FROM pull_request_observations WHERE number = ${number} ORDER BY organization_id, authority_key`))
}

async function sessionIn(sessionId: string, organizationId: string): Promise<void> {
  await database.getDatabase().run(sql`INSERT INTO session(session_id, organization_id, created_by, created_at) VALUES (${sessionId}, ${organizationId}, 'owner', 1)`)
}

describe('an observation and its links change together', () => {
  test('a new link keeps its session until PR sync answers; a state change flips every bit; a title-only change writes no link', async () => {
    // WHY (fixture 'state transition updates two linked candidate bits',
    // 'title-only observation writes no link projection', benchmark write counts
    // F → F+1 on a close and F → 1 on a title): the bit is a stored fact, written
    // only when the state it summarizes changes.
    await sessionPrs.linkSessionPullRequest('s1', { url: url(1), source: 'manual', by: PERSON })
    await sessionPrs.linkSessionPullRequest('s2', { url: url(1), source: 'manual', by: PERSON })
    const task = await tasks.Task.byId('local', (await taskStore.createTask('local', { title: 'Direct' })).id)
    await task.linkPullRequest({ number: 1, targetScope: REPO, url: url(1) }, PERSON)
    expect((await bits(1)).map((row) => [row.source_id, row.authority_key, row.keeps_session])).toEqual([['s1', null, 1], ['s2', null, 1], [task.id, null, 0]])

    await sessionPrs.recordSessionPullRequestObservation(REPO, 1, observed('closed', 'first title'))
    expect((await bits(1)).map((row) => [row.authority_key, row.keeps_session])).toEqual([['host', 0], ['host', 0], ['host', 0]])
    expect(await stored(1)).toEqual([{ organization_id: 'local', authority_key: 'host', state: 'closed', title: 'first title' }])

    await sessionPrs.recordSessionPullRequestObservation(REPO, 1, observed('open', 'reopened'))
    expect((await bits(1)).map((row) => row.keeps_session)).toEqual([1, 1, 0])
    // Non-session edges never keep a session listed (fixture 'non-session cannot keep a session listed').
    expect((await bits(1)).find((row) => row.source_id === task.id)?.keeps_session).toBe(0)

    // The title reaches every reader; no edge row is written for it.
    const before = await bits(1)
    await sessionPrs.recordSessionPullRequestObservation(REPO, 1, observed('open', 'newer title'))
    expect(await bits(1)).toEqual(before)
    expect((await sessionPrs.readSessionPullRequests('local', ['s1', 's2']))['s2']?.[0]).toMatchObject({ title: 'newer title', snapshot: expect.objectContaining({ state: 'open', title: 'newer title' }) })
    expect(((await taskLinks.readTaskPrLinks(database.getDatabase(), 'local', [task.id]))[task.id] ?? []).map((link) => link.title)).toEqual(['newer title'])
  })

  test('a failed write rolls the observation and every bit back together', async () => {
    // WHY (fixture 'rollback restores observation', 'rollback restores candidate
    // projection'): a read must never see a closed pull request still keeping its
    // session listed, or the reverse.
    await sessionPrs.linkSessionPullRequest('s1', { url: url(1), source: 'manual', by: PERSON })
    await sessionPrs.recordSessionPullRequestObservation(REPO, 1, observed('open', 'open title'))
    await expect(database.getDatabase().transaction(async (tx) => {
      await observations.recordObservation(tx, { repository: REPO, number: 1, scopes: [], pullRequest: observed('closed', 'rolled back') })
      throw new Error('abort')
    })).rejects.toThrow('abort')
    expect(await stored(1)).toEqual([{ organization_id: 'local', authority_key: 'host', state: 'open', title: 'open title' }])
    expect((await bits(1)).map((row) => row.keeps_session)).toEqual([1])
  })

  test('a missing pull request is an answer: the bit drops and the last title stays', async () => {
    await sessionPrs.linkSessionPullRequest('s1', { url: url(1), title: 'linked as', source: 'manual', by: PERSON })
    await sessionPrs.recordSessionPullRequestObservation(REPO, 1, observed('open', 'seen'))
    await sessionPrs.recordSessionPullRequestObservation(REPO, 1, null)
    expect(await stored(1)).toEqual([{ organization_id: 'local', authority_key: 'host', state: 'missing', title: 'seen' }])
    expect((await bits(1)).map((row) => row.keeps_session)).toEqual([0])
    expect((await sessionPrs.readSessionPullRequests('local', ['s1']))['s1']?.[0]).toMatchObject({ missing: true, title: 'seen' })
  })
})

describe('observations are kept per organization and authority', () => {
  test('what one organization or authority saw is not written over by another, and a new link binds to its own organization\'s observation', async () => {
    // WHY (fixture 'org and authority observations separated', 'qualified cache
    // update leaves other authority unchanged', 'authority b remains missing and
    // excluded', 'org boundary in task query', the two FK rejections): visibility
    // differs by who read; an edge names the observation its organization holds.
    await sessionIn('in-p', 'p')
    await sessionPrs.linkSessionPullRequest('s1', { url: url(1), source: 'manual', by: PERSON })
    await sessionPrs.linkSessionPullRequest('in-p', { url: url(1), source: 'manual', by: PERSON })
    await observations.recordObservation(database.getDatabase(), { repository: REPO, number: 1, scopes: [], pullRequest: observed('open', 'a sees it'), authorityKey: 'person:a' })
    await observations.recordObservation(database.getDatabase(), { repository: REPO, number: 1, scopes: [], pullRequest: null, authorityKey: 'person:b' })
    expect(await stored(1)).toEqual([
      { organization_id: 'local', authority_key: 'person:a', state: 'open', title: 'a sees it' },
      { organization_id: 'local', authority_key: 'person:b', state: 'missing', title: '' },
      { organization_id: 'p', authority_key: 'person:a', state: 'open', title: 'a sees it' },
      { organization_id: 'p', authority_key: 'person:b', state: 'missing', title: '' },
    ])
    // Each edge reads the authority that observed it last, and `person:a` still says open.
    expect((await bits(1)).map((row) => [row.source_id, row.authority_key, row.keeps_session])).toEqual([['in-p', 'person:b', 0], ['s1', 'person:b', 0]])
    await observations.recordObservation(database.getDatabase(), { repository: REPO, number: 1, scopes: [], pullRequest: observed('closed', 'a closed'), authorityKey: 'person:a' })
    expect((await stored(1)).map((row) => [row.authority_key, row.state])).toEqual([['person:a', 'closed'], ['person:b', 'missing'], ['person:a', 'closed'], ['person:b', 'missing']])

    // A later link binds to the most recent observation its organization holds, never to another organization's or to none.
    await sessionIn('in-q', 'q')
    await sessionPrs.linkSessionPullRequest('s3', { url: url(1), source: 'manual', by: PERSON })
    await sessionPrs.linkSessionPullRequest('in-q', { url: url(1), source: 'manual', by: PERSON })
    const late = await bits(1)
    expect(late.find((row) => row.source_id === 's3')).toMatchObject({ authority_key: 'person:a', keeps_session: 0 })
    expect(late.find((row) => row.source_id === 'in-q')).toMatchObject({ authority_key: null, keeps_session: 1 })
    // A task in another organization reads none of this.
    expect(await taskLinks.readPrLinkInterests(database.getDatabase(), 'q')).toEqual([])
  })

  test('a merged observation under any authority completes the question the task sync asks', async () => {
    await sessionPrs.linkSessionPullRequest('s1', { url: url(2), source: 'manual', by: PERSON })
    expect(await taskLinks.linkedPullRequestIsMerged({ projectScope: REPO, number: 2 })).toBe(false)
    await sessionPrs.recordSessionPullRequestObservation(REPO, 2, observed('merged'))
    expect(await taskLinks.linkedPullRequestIsMerged({ projectScope: REPO, number: 2 })).toBe(true)
  })
})

describe('the session list reads the bit', () => {
  test('the candidate predicate is a covering search of resource_links_open_session', async () => {
    // WHY (fixture 'candidate index selected'; benchmark: the join-only candidate
    // was 2–11× slower): the list's hot EXISTS must stay on the measured index.
    await sessionPrs.linkSessionPullRequest('s1', { url: url(1), source: 'manual', by: PERSON })
    const plan = z.object({ detail: z.string() }).array().parse(await database.getDatabase().all(sql`
      EXPLAIN QUERY PLAN SELECT 1 FROM resource_links WHERE resource_links.source_id = 's1' AND resource_links.organization_id = 'local' AND resource_links.keeps_session = 1 LIMIT 1`))
    expect(plan.map((step) => step.detail).join('\n')).toContain('COVERING INDEX resource_links_open_session')
    const candidates = z.object({ detail: z.string() }).array().parse(await database.getDatabase().all(sql`
      EXPLAIN QUERY PLAN SELECT source_id AS session_id FROM resource_links WHERE resource_links.keeps_session = 1`))
    expect(candidates.map((step) => step.detail).join('\n')).toContain('COVERING INDEX resource_links_open_session')
  })

  test('an open or unobserved link keeps its session listed; an ended or dismissed one does not', async () => {
    const now = Date.now()
    const old = now - 60 * 24 * 60 * 60_000
    for (const [sessionId, state] of [['open-pr', 'open'], ['unsynced-pr', null], ['merged-pr', 'merged'], ['dismissed-pr', 'open']] as const) {
      await sessionRecords.upsertSessionRecord('local', { sessionId, provider: 'codex', projectPath: '-repo', lastActivityAt: old, createdAt: old }, { organizationId: 'local', ownerKey: 'alice' })
      await sessionPrs.linkSessionPullRequest(sessionId, { url: url(sessionId.length), source: 'manual', by: PERSON })
      if (state) await sessionPrs.recordSessionPullRequestObservation(REPO, sessionId.length, observed(state))
    }
    await sessionPrs.unlinkSessionPullRequest('dismissed-pr', REPO, 'dismissed-pr'.length)
    const listed = (await sessionRecords.readSessionListPage(sql`1 = 1`, 100, 'last_activity_at', { personKey: 'alice', now })).map((record) => record.sessionId).sort()
    expect(listed).toEqual(['open-pr', 'unsynced-pr'])
    // The same bit settles a session whose pull requests all ended.
    expect(await sessionStates.settleSessionsWithEndedPullRequests(() => false)).toEqual(['merged-pr'])
  })
})
