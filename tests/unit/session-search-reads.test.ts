import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { searchText } from '@solus/contracts/search-query'
import { DatabaseSync } from './helpers/bun-sqlite'
import { StatementLog } from './helpers/statement-log'

mock.module('node:sqlite', () => ({ DatabaseSync }))

/**
 * plans/028 C3 and C4, plans/029 §8: a search request is bounded by what it
 * matched, not by the size of the store. Before, every request read every
 * `session` row, every pull request link and watch, and ran one lineage
 * query per unbound thread. Now the record and `viewed_at` reads name only
 * the matched sessions, pull request names are read once and kept until a link
 * changes, and a lineage miss is remembered.
 */

const SESSIONS = 2_000
let dataDir: string
let log: StatementLog
let closeDb: () => void
let closeDatabase: () => Promise<void>
let operations: InstanceType<typeof import('@solus/server/data/sessions/api-operations')['SessionApiOperations']>
let hostUserKey: string
const context = {
  principal: { kind: 'owner' as const, via: 'local' as const, expiresAt: null, deviceId: null, deviceLabel: 'Mac' },
  home: { kind: 'local' as const, hostId: 'this-mac' },
  scopes: ['sessions:read' as const],
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-search-reads-'))
  process.env.SOLUS_DATA_DIR = dataDir
  const hostDb = await import('@solus/server/db')
  closeDb = hostDb.closeDb
  const db = hostDb.getDb()
  log = new StatementLog(db)
  const { getDatabase, closeDatabase: close } = await import('@solus/server/db/database')
  closeDatabase = close
  const { SessionApiOperations } = await import('@solus/server/data/sessions/api-operations')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const { linkSessionPullRequest } = await import('@solus/server/data/sessions/session-pull-requests')
  ;({ hostUserKey } = await import('@solus/server/host/host-user'))
  operations = new SessionApiOperations(new ShareManager({ db: getDatabase() }))

  // 2,000 indexed sessions with records; 40 of them hold the rare word.
  const index = db.prepare(`INSERT INTO transcript_index(session_id, provider, cwd, project_path, project_root, is_worktree, custom_title, last_timestamp, size)
    VALUES (?, 'codex', '/repo', '-repo', '/repo', 0, ?, ?, 10)`)
  const key = db.prepare('INSERT INTO session_keys(number, session_id) VALUES (?, ?)')
  const message = db.prepare('INSERT INTO session_messages(id, session_id, uuid, role, ts, text) VALUES (?, ?, NULL, ?, ?, ?)')
  const fts = db.prepare('INSERT INTO session_fts(rowid, text) VALUES (?, ?)')
  const record = db.prepare(`INSERT INTO session(session_id, organization_id, created_by, provider, project_path, project_root, cwd, status, title, created_at, last_activity_at, started_at)
    VALUES (?, 'local', ?, 'codex', '-repo', '/repo', '/repo', 'idle', ?, ?, ?, ?)`)
  db.exec('BEGIN')
  for (let i = 0; i < SESSIONS; i++) {
    const sessionId = `s-${String(i).padStart(4, '0')}`
    const rare = i % 50 === 0
    const texts = ['hello there', rare ? `the pelican lands ${i}` : `an ordinary message ${i}`]
    index.run(sessionId, `Session ${i}`, 1_000 + i)
    key.run(i + 1, sessionId)
    for (const [position, text] of texts.entries()) {
      const id = (i + 1) * 2 ** 20 + position
      message.run(id, sessionId, position % 2 ? 'assistant' : 'user', 100 * (position + 1), text)
      fts.run(id, searchText(text))
    }
    record.run(sessionId, hostUserKey(), `Session ${i}`, 1_000 + i, 1_000 + i, 1_000 + i)
  }
  db.exec('COMMIT')
  // A session known by its pull request alone, and one the person read recently.
  await linkSessionPullRequest('s-0001', { url: 'https://github.com/acme/solus/pull/77', title: 'Teach the pelican to land', source: 'manual', by: { kind: 'system' } })
  await getDatabase().run(sql`INSERT INTO personal_resource_state(organization_id, resource_kind, resource_id, created_by, viewed_at) VALUES ('local', 'session', 's-0050', ${hostUserKey()}, ${Date.now()})`)
  log.clear()
})

afterAll(async () => {
  await closeDatabase()
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

function explain(statement: { text: string }): string {
  const { getDb } = require('@solus/server/db') as typeof import('@solus/server/db')
  return (getDb().prepare(`EXPLAIN QUERY PLAN ${statement.text}`).all() as Array<{ detail: string }>).map((row) => row.detail).join('\n')
}

test('a search reads the records and views of the sessions it matched, not of every session', async () => {
  const page = await operations.search(context, { q: 'pelican', limit: 20 })
  // 40 message hits and the session named by its pull request.
  expect(page.total).toBe(41)
  expect(page.items.map((item) => item.session.id)).toContain('s-0001')
  // The pull request name ranks first; the person's recent read of s-0050 orders it first among the message hits.
  expect(page.items[1]!.session.id).toBe('s-0050')

  const sessionReads = log.of('SELECT', 'session')
  // Every record read names the sessions it is about; none reads the table whole.
  for (const read of sessionReads) {
    expect(read.text).toMatch(/session_id IN \(/)
    expect(read.params).toBeLessThanOrEqual(page.total + 4)
    expect(explain(read)).toMatch(/SEARCH "?session"? USING/)
    expect(explain(read)).not.toMatch(/SCAN "?session"?\b/)
  }
  expect(sessionReads.length).toBeGreaterThan(0)
  // `viewed_at` is read for the matched sessions alone.
  for (const read of log.of('SELECT', 'personal_resource_state')) expect(read.params).toBeLessThanOrEqual(page.total + 4)
  // The whole store is 2,000 sessions; the request's statements are a handful.
  expect(log.statements.length).toBeLessThan(40)
})

test('a second search reads the links of the page alone, and no lineage row', async () => {
  log.clear()
  const page = await operations.search(context, { q: 'pelican', limit: 20 })
  // The names of every link were read once; a page reads its own sessions' links.
  for (const read of [...log.of('SELECT', 'session_pull_requests'), ...log.of('SELECT', 'session_pull_request_watches')]) {
    expect(read.text).toMatch(/session_id IN \(/)
    expect(read.params).toBeLessThanOrEqual(page.items.length)
  }
  // A thread with no lineage is remembered as its own session.
  expect(log.of('SELECT', 'session_lineage_members')).toHaveLength(0)
})

test('a link that changes is in the next search', async () => {
  const { linkSessionPullRequest } = await import('@solus/server/data/sessions/session-pull-requests')
  await linkSessionPullRequest('s-0002', { url: 'https://github.com/acme/solus/pull/78', title: 'A heron too', source: 'manual', by: { kind: 'system' } })
  const page = await operations.search(context, { q: 'heron', limit: 20 })
  expect(page.items.map((item) => item.session.id)).toEqual(['s-0002'])
})
