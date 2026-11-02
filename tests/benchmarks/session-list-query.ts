/**
 * Session list read: what one page of a person's list costs on a host with a
 * long history (docs/plans/session-archive.md). Compares the old scan of every
 * record (`sessionListedClause` in `where`) with `readSessionListPage`, which
 * reads only the sessions that can be in the list.
 *
 * Run with: SESSIONS=30000 RECENT_EVERY=200 bun test ./tests/benchmarks/session-list-query.ts
 *
 * A disposable SOLUS_DATA_DIR; no live Solus data is read or written. Not part
 * of the unit suite: the file name does not end in `.test.ts`.
 */
import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql, type SQL } from 'drizzle-orm'
import { SESSION_LIST_IDLE_MS } from '@solus/contracts/session-state'
import { DatabaseSync } from '../unit/helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const SESSIONS = Number(process.env.SESSIONS ?? 3000)
const RUNS = 30
/** One session in this many is recent. */
const RECENT_EVERY = Number(process.env.RECENT_EVERY ?? 20)
const ALICE = 'user:alice'
const DAY = 24 * 60 * 60_000

const dataDir = mkdtempSync(join(tmpdir(), 'solus-session-list-bench-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = dataDir

afterAll(async () => {
  const { closeDatabase } = await import('@solus/server/db/database')
  await closeDatabase()
  ;(await import('@solus/server/db')).closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

test(`one list page over ${SESSIONS} sessions`, async () => {
  const records = await import('@solus/server/data/sessions/session-records')
  const { getDatabase } = await import('@solus/server/db/database')
  const db = getDatabase()
  const now = Date.now()
  const since = now - SESSION_LIST_IDLE_MS
  // A long history: most sessions are old and quiet, a few are recent; every
  // tenth has a pull request, most of them merged; a few are snoozed or shared.
  const insert = async (statement: SQL) => { await db.run(statement) }
  for (let index = 0; index < SESSIONS; index++) {
    const recent = index % RECENT_EVERY === 0
    const time = recent ? now - index * 1000 : since - DAY - index * 60_000
    await insert(sql`INSERT INTO session (session_id, organization_id, created_by, provider, project_path, status, created_at, last_activity_at, started_at)
      VALUES (${`s-${index}`}, 'local', ${ALICE}, 'codex', '-repo', 'idle', ${time}, ${time}, ${time})`)
    await insert(sql`INSERT INTO personal_resource_state (resource_kind, resource_id, created_by, organization_id, snoozed_until, archived_at)
      VALUES ('session', ${`s-${index}`}, ${ALICE}, 'local', ${index % 150 === 7 ? now + DAY : null}, ${index % 9 === 0 ? now - DAY : null})`)
    if (index % 10 === 3) {
      await insert(sql`INSERT INTO session_pull_requests (session_id, repository, number, url, source, created_by, linked_at, pr_state, organization_id)
        VALUES (${`s-${index}`}, 'github.com/acme/solus', ${index}, 'https://github.com/acme/solus/pull/1', 'branch', 'host', ${time}, ${index % 100 === 3 ? 'open' : 'merged'}, 'local')`)
    }
    await insert(sql`INSERT INTO acl_entry (id, resource_kind, resource_id, subject_kind, subject_id, role, granted_by_user_id, created_at, organization_id)
      VALUES (${`acl-${index}`}, 'session', ${`s-${index}`}, ${index % 200 === 11 ? 'user' : 'organization'}, ${index % 200 === 11 ? ALICE : 'local'}, 'viewer', 'user:bob', ${time}, 'local')`)
  }

  const reader = { personKey: ALICE, teamIds: [], now }
  const where = sql`session.parent_session_id IS NULL`
  // Every page, as the client reads the list: 200 at a time, by the activity cursor.
  const allPages = async (read: (where: SQL) => Promise<Array<{ sessionId: string; lastActivityAt: number }>>) => {
    const ids: string[] = []
    let seek = sql`1 = 1`
    for (;;) {
      const page = await read(sql`${where} AND ${seek}`)
      ids.push(...page.slice(0, 200).map((record) => record.sessionId))
      if (page.length <= 200) return ids
      const last = page[199]!
      seek = sql`(session.last_activity_at, session.session_id) < (${last.lastActivityAt}, ${last.sessionId})`
    }
  }
  const before = () => allPages((filter) => records.readSessionMetadataPage(sql`${filter} AND ${records.sessionListedClause(reader)}`, 201, 'last_activity_at', reader))
  const after = () => allPages((filter) => records.readSessionListPage(filter, 201, 'last_activity_at', reader))
  expect(await after()).toEqual(await before())

  const time = async (read: () => Promise<unknown>) => {
    const runs: number[] = []
    for (let run = 0; run < RUNS; run++) {
      const start = performance.now()
      await read()
      runs.push(performance.now() - start)
    }
    return median(runs)
  }
  const plan = async (statement: SQL) => (await db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${statement}`)).map((row) => row.detail)
  const candidates = await plan(sql`SELECT session.session_id FROM (
      SELECT session_id FROM session WHERE last_activity_at >= ${since}
      UNION SELECT resource_id AS session_id FROM personal_resource_state WHERE created_by = ${ALICE} AND resource_kind = 'session' AND snoozed_until IS NOT NULL
      UNION SELECT session_id FROM session_pull_requests WHERE session_pull_requests.source <> 'dismissed'
        AND (session_pull_requests.pr_state IS NULL OR session_pull_requests.pr_state NOT IN ('merged', 'closed', 'missing'))
      UNION SELECT resource_id FROM acl_entry WHERE resource_kind = 'session' AND subject_kind = 'user' AND subject_id = ${ALICE}
    ) AS list_candidates CROSS JOIN session WHERE session.session_id = list_candidates.session_id`)
  const listed = (await before()).length
  const beforeMs = await time(before)
  const afterMs = await time(after)
  console.log(`${SESSIONS} sessions, ${listed} listed`)
  console.log(`every page, scan of every record: ${beforeMs.toFixed(2)} ms (median of ${RUNS})`)
  console.log(`every page, list candidates:      ${afterMs.toFixed(2)} ms (median of ${RUNS})`)
  console.log(`candidate plan:\n  ${candidates.join('\n  ')}`)
}, 120_000)
