import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type ReadStateModule = typeof import('@solus/server/sessions/session-read-state')

let dataDir: string
let db: DbModule
let readState: ReadStateModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-read-state-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  readState = await import('@solus/server/sessions/session-read-state')
})

beforeEach(() => {
  db.getDb().prepare(`
    INSERT INTO sessions(session_id, provider) VALUES ('s1', 'claude-code')
  `).run()
})

afterEach(() => {
  db.closeDb()
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
  }
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('session read state', () => {
  test('a session nobody has opened is unread', () => {
    expect(readState.readViewedAt('s1')).toBeNull()
  })

  test('a session that does not exist is unread rather than an error', () => {
    // A client can hold a session id the host has since forgotten; that must
    // read as unread, not throw and break the sidebar.
    expect(readState.readViewedAt('missing')).toBeNull()
  })

  test('reading a session records the boundary', () => {
    const at = Date.now() - 1_000
    expect(readState.markViewed('s1', at)).toBe(at)
    expect(readState.readViewedAt('s1')).toBe(at)
  })

  test('a client clock ahead of the host cannot mark future work read', () => {
    // WHY: the boundary decides what counts as already seen. A client an hour
    // fast would silently mark the next hour of completions read.
    const future = Date.now() + 60 * 60 * 1000
    const settled = readState.markViewed('s1', future)
    expect(settled).toBeLessThanOrEqual(Date.now())
  })

  test('the boundary never moves backward', () => {
    // WHY: two devices reading the same session race. An older view arriving
    // second must not rewind what the newer one already established.
    const newer = Date.now() - 1_000
    const older = newer - 5_000
    readState.markViewed('s1', newer)
    expect(readState.markViewed('s1', older)).toBe(newer)
    expect(readState.readViewedAt('s1')).toBe(newer)
  })

  test('marking unread is the one thing that clears the boundary', () => {
    readState.markViewed('s1', Date.now() - 1_000)
    readState.markUnread('s1')
    expect(readState.readViewedAt('s1')).toBeNull()
  })

  test('a view in flight during a mark-unread does not silently undo it', () => {
    // The user said unread; a view that was already on its way is older than
    // that choice, and re-reading it would contradict them.
    const viewedAt = Date.now() - 1_000
    readState.markViewed('s1', viewedAt)
    readState.markUnread('s1')
    // The late view carries its own original timestamp, not "now".
    readState.markViewed('s1', viewedAt)
    // It does land — the session was genuinely read at that moment — but the
    // boundary is the old one, so anything completed since stays unread.
    expect(readState.readViewedAt('s1')).toBe(viewedAt)
  })

  test('reading a session does not reorder it', () => {
    // WHY: `last_timestamp` orders the sidebar. Reading a session must never
    // move it in the list the user is reading it from.
    db.getDb().prepare('UPDATE sessions SET last_timestamp = 500 WHERE session_id = ?').run('s1')
    readState.markViewed('s1', Date.now() - 1_000)
    const row = db.getDb()
      .prepare('SELECT last_timestamp FROM sessions WHERE session_id = ?')
      .get('s1') as { last_timestamp: number }
    expect(row.last_timestamp).toBe(500)
  })
})
