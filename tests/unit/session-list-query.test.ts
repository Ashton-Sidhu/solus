import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql, type SQL } from 'drizzle-orm'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'
import { SESSION_LIST_IDLE_MS } from '@solus/contracts/session-state'

/**
 * The session list reads only the sessions that can be in it — recent ones,
 * the reader's snoozes, open pull requests, and the reader's direct shares —
 * then builds rows for those (docs/plans/session-archive.md). The answer must
 * be the one the old scan of every record gave: the same rows, in the same
 * order, with the same fields, across every page.
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))

const ALICE = 'user:alice'
const BOB = 'user:bob'
const TEAM = 'team-1'
const DAY = 24 * 60 * 60_000
const PERSON = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }

let dataDir: string
let db: typeof import('@solus/server/db')
let records: typeof import('@solus/server/data/sessions/session-records')
let states: typeof import('@solus/server/data/sessions/session-states')
let sessionPrs: typeof import('@solus/server/data/sessions/session-pull-requests')
let database: typeof import('@solus/server/db/database')
let page: typeof import('@solus/server/data/workspace/page')
const previousDataDir = process.env.SOLUS_DATA_DIR
const now = Date.now()
const old = now - SESSION_LIST_IDLE_MS - DAY

async function recorded(sessionId: string, lastActivityAt: number, fields: { owner?: string; parent?: string; createdAt?: number } = {}) {
  await records.upsertSessionRecord('local', {
    sessionId, provider: 'codex', projectPath: '-repo', lastActivityAt, parentSessionId: fields.parent ?? null, createdAt: fields.createdAt ?? lastActivityAt,
  }, { organizationId: 'local', ownerKey: fields.owner ?? ALICE })
}

let grants = 0
async function granted(sessionId: string, subjectKind: 'user' | 'team' | 'organization', subjectId: string, grantedAt: number, expiresAt: number | null = null) {
  await database.getDatabase().run(sql`INSERT INTO acl_entry (id, resource_kind, resource_id, subject_kind, subject_id, role, granted_by_user_id, created_at, granted_at, expires_at, organization_id)
    VALUES (${`grant-${++grants}`}, 'session', ${sessionId}, ${subjectKind}, ${subjectId}, 'viewer', ${BOB}, ${grantedAt}, ${grantedAt}, ${expiresAt}, 'local')`)
}

async function linked(sessionId: string, number: number, state: 'open' | 'merged' | 'closed' | null) {
  const url = `https://github.com/acme/solus/pull/${number}`
  await sessionPrs.linkSessionPullRequest(sessionId, { url, source: 'manual', by: PERSON })
  // SAFETY: the store reads only these fields of a pull request.
  if (state) await sessionPrs.recordSessionPullRequestObservation('github.com/acme/solus', number, { title: '', state, draft: false, updatedAt: new Date(old).toISOString() } as never)
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-list-query-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  records = await import('@solus/server/data/sessions/session-records')
  states = await import('@solus/server/data/sessions/session-states')
  sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
  database = await import('@solus/server/db/database')
  page = await import('@solus/server/data/workspace/page')

  // Recent sessions; groups of three share one activity time, so the cursor's id breaks ties.
  for (let index = 0; index < 60; index++) await recorded(`recent-${String(index).padStart(2, '0')}`, now - Math.floor(index / 3) * 1000, { createdAt: old - index })
  for (let index = 0; index < 40; index++) await recorded(`old-${index}`, old - index)
  await recorded('child', now, { parent: 'recent-00' })
  await recorded('old-child-snoozed', old, { parent: 'old-0' })
  await new states.SessionViewer('old-child-snoozed', ALICE).snooze(now + DAY)

  await recorded('archived', now)
  await new states.SessionViewer('archived', ALICE).archive(now - 10)
  await recorded('old-snoozed', old)
  await new states.SessionViewer('old-snoozed', ALICE).snooze(now + DAY)
  await recorded('old-snoozed-archived', old)
  await new states.SessionViewer('old-snoozed-archived', ALICE).snooze(now + DAY)
  await new states.SessionViewer('old-snoozed-archived', ALICE).archive(now - 10)

  await recorded('old-open-pr', old)
  await linked('old-open-pr', 1, 'open')
  await recorded('old-unsynced-pr', old)
  await linked('old-unsynced-pr', 2, null)
  await recorded('old-merged-pr', old)
  await linked('old-merged-pr', 3, 'merged')
  await recorded('old-dismissed-pr', old)
  await linked('old-dismissed-pr', 4, 'open')
  await sessionPrs.unlinkSessionPullRequest('old-dismissed-pr', 'github.com/acme/solus', 4)

  // Bob's sessions: not Alice's until she prompts one or someone shares it with her.
  await recorded('bobs-recent', now, { owner: BOB })
  await recorded('bobs-prompted', now - 5, { owner: BOB })
  await new states.SessionShelf('bobs-prompted').recordPrompt(ALICE)
  await recorded('bobs-old-prompted', old, { owner: BOB })
  await new states.SessionShelf('bobs-old-prompted').recordPrompt(ALICE)
  await recorded('bobs-old-open-pr', old, { owner: BOB })
  await linked('bobs-old-open-pr', 5, 'open')
  await recorded('shared-old', old, { owner: BOB })
  await granted('shared-old', 'user', ALICE, now - DAY)
  await recorded('shared-long-ago', old - DAY, { owner: BOB })
  await granted('shared-long-ago', 'user', ALICE, old)
  await recorded('shared-with-team', old, { owner: BOB })
  await granted('shared-with-team', 'team', TEAM, now - 2 * DAY)
  await recorded('shared-expired', old, { owner: BOB })
  await granted('shared-expired', 'user', ALICE, now - DAY, now - 1)
  await recorded('shared-with-organization', old, { owner: BOB })
  await granted('shared-with-organization', 'organization', 'local', now - DAY)
  await recorded('shared-then-archived', old, { owner: BOB })
  await granted('shared-then-archived', 'user', ALICE, now - DAY)
  await new states.SessionViewer('shared-then-archived', ALICE).archive(now - 10)
  await recorded('archived-then-shared', old, { owner: BOB })
  await new states.SessionViewer('archived-then-shared', ALICE).archive(now - 2 * DAY)
  await granted('archived-then-shared', 'user', ALICE, now - DAY)
  await recorded('shared-recent-archived-then-shared', now, { owner: BOB })
  await new states.SessionViewer('shared-recent-archived-then-shared', ALICE).archive(now - 2 * DAY)
  await granted('shared-recent-archived-then-shared', 'team', TEAM, now - DAY)
})

afterAll(async () => {
  await resetTestDatabase()
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

type Time = 'created_at' | 'last_activity_at'

/** Every page of a list read, through the cursor the API writes. */
async function allPages(read: (where: SQL, limit: number, time: Time) => Promise<unknown[]>, filter: SQL, limit: number, time: Time) {
  const pages: unknown[][] = []
  let after: import('@solus/server/data/workspace/page').PageCursor | undefined
  for (;;) {
    const rows = await read(sql`${filter} AND ${page.seekClause(sql`session_records.${sql.identifier(time)}`, sql`session_records.session_id`, after)}`, limit + 1, time) as Array<{ sessionId: string; createdAt: number; lastActivityAt: number }>
    const result = page.pageOf(rows, limit, (item) => ({ time: time === 'created_at' ? item.createdAt : item.lastActivityAt, id: item.sessionId }))
    pages.push(result.items)
    if (!result.nextCursor) return pages
    after = page.readCursor(result.nextCursor)
  }
}

describe('the session list reads only the sessions that can be in it', () => {
  for (const reader of [
    { name: 'Alice in her team', personKey: ALICE, teamIds: [TEAM] },
    { name: 'Alice alone', personKey: ALICE, teamIds: [] },
    { name: 'Bob', personKey: BOB, teamIds: [] },
    { name: 'no person', personKey: null, teamIds: [] },
  ]) {
    for (const time of ['last_activity_at', 'created_at'] as const) {
      test(`${reader.name}, by ${time}: the same pages as the scan of every record`, async () => {
        const pageReader = { personKey: reader.personKey, teamIds: reader.teamIds, now }
        for (const filter of [sql`session_records.parent_session_id IS NULL`, sql`1 = 1`]) {
          const before = await allPages((where, limit, order) => records.readSessionMetadataPage(sql`${where} AND ${records.sessionListedClause(pageReader)}`, limit, order, pageReader), filter, 7, time)
          const after = await allPages((where, limit, order) => records.readSessionListPage(where, limit, order, pageReader), filter, 7, time)
          expect(after).toEqual(before)
        }
      })
    }
  }

  test('the fixture covers every way into and out of the list', async () => {
    // WHY: an equal answer on a fixture with nothing in it proves nothing.
    const reader = { personKey: ALICE, teamIds: [TEAM], now }
    const listed = new Set((await records.readSessionListPage(sql`session_records.parent_session_id IS NULL`, 1000, 'last_activity_at', reader)).map((record) => record.sessionId))
    for (const sessionId of ['recent-00', 'recent-59', 'old-snoozed', 'old-open-pr', 'old-unsynced-pr', 'bobs-prompted', 'shared-old', 'shared-with-team', 'archived-then-shared', 'shared-recent-archived-then-shared']) {
      expect([sessionId, listed.has(sessionId)]).toEqual([sessionId, true])
    }
    for (const sessionId of ['old-0', 'archived', 'old-snoozed-archived', 'old-merged-pr', 'bobs-recent', 'bobs-old-prompted', 'bobs-old-open-pr', 'shared-long-ago', 'shared-expired', 'shared-with-organization', 'shared-then-archived', 'child', 'old-child-snoozed']) {
      expect([sessionId, listed.has(sessionId)]).toEqual([sessionId, false])
    }
  })
})
