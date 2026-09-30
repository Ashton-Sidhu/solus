import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { SNIPPET_HIT_CLOSE, SNIPPET_HIT_OPEN } from '@solus/contracts/search-snippet'
import { encodePathAsFolder } from '@solus/contracts/types'

// The DB layer imports `node:sqlite`, which Bun's test runtime lacks; the
// indexer's calls work the same on bun:sqlite. Modules load after the mock.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type IndexerModule = typeof import('@solus/server/db/session-indexer')
type SearchModule = typeof import('@solus/server/db/session-search')
let indexer: IndexerModule
let search: SearchModule
let closeDb: () => void
let getDb: typeof import('@solus/server/db').getDb
let runMigrations: typeof import('@solus/server/db/migrations').runMigrations

let dataDir: string
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-search-index-'))
  process.env.SOLUS_DATA_DIR = dataDir
  indexer = await import('@solus/server/db/session-indexer')
  search = await import('@solus/server/db/session-search')
  ;({ closeDb, getDb } = await import('@solus/server/db'))
  ;({ runMigrations } = await import('@solus/server/db/migrations'))
})
afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
})
afterEach(() => {
  closeDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

function seed(sessionId: string, cwd: string, texts: string[]): void {
  indexer.persistIndexedSessionStart(sessionId, 'codex', cwd, encodePathAsFolder(cwd), 'gpt-5.5', 'high')
  indexer.indexSessionMessages(sessionId, texts.map((content, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content,
    timestamp: (index + 1) * 100,
  })))
}

describe('searchSessionIndex', () => {
  test('a word still being typed answers the best sessions, each passage marked, three at most per session', () => {
    // WHY: passages are cut only for the page answered. Each session is listed
    // once, with its other passages under it, and the page holds `limit`.
    for (let i = 0; i < 6; i++) {
      seed(`s-${i}`, '/repo', ['a reconnect loop', 'reconnecting again', 'the reconnect timer', 'reconnects once more', 'unrelated'])
    }
    const { results, total } = search.searchSessionIndex('reconn', { limit: 4 })
    expect(total).toBe(6)
    expect(results).toHaveLength(4)
    expect(new Set(results.map((result) => result.session.sessionId)).size).toBe(4)
    for (const result of results) {
      expect(result.snippet).toContain(SNIPPET_HIT_OPEN)
      expect(result.snippet).toContain(SNIPPET_HIT_CLOSE)
      expect(result.additionalMatches).toHaveLength(2)
      for (const passage of result.additionalMatches!) expect(passage.snippet).toContain(SNIPPET_HIT_OPEN)
      expect(result.session.cwd).toBe('/repo')
    }
  })

  test('a project scope keeps only that project\'s sessions', () => {
    seed('here', '/repo', ['the pelican lands'])
    seed('there', '/elsewhere', ['the pelican flies'])
    const scoped = search.searchSessionIndex('pelican', { projectRoot: '/repo' }).results
    expect(scoped.map((result) => result.session.sessionId)).toEqual(['here'])
    expect(search.searchSessionIndex('pelican').results.map((result) => result.session.sessionId).toSorted()).toEqual(['here', 'there'])
  })

  test('a session matches when its words are in different messages, and not when one word is missing', () => {
    // WHY: a person remembers what a session was about, not one message of it.
    seed('spread', '/repo', ['the lighthouse audit failed', 'then we added a cache header'])
    seed('partial', '/repo', ['the lighthouse audit failed', 'nothing else'])
    const { results, total } = search.searchSessionIndex('lighthouse header')
    expect(total).toBe(1)
    expect(results.map((result) => result.session.sessionId)).toEqual(['spread'])
  })

  test('a message that holds every word ranks above words spread over messages', () => {
    seed('apart', '/repo', ['the websocket dropped', 'a reconnect later', 'more websocket', 'more reconnect'])
    seed('together', '/repo', ['the websocket reconnect loop'])
    const { results } = search.searchSessionIndex('websocket reconnect')
    expect(results.map((result) => result.session.sessionId)).toEqual(['together', 'apart'])
    expect(results[0]!.snippet).toBe(`the ${SNIPPET_HIT_OPEN}websocket${SNIPPET_HIT_CLOSE} ${SNIPPET_HIT_OPEN}reconnect${SNIPPET_HIT_CLOSE} loop`)
  })

  test('a session is found by its title, its branch and its pull requests, and a name hit ranks first with no passage', async () => {
    // WHY: generated and renamed titles are rarely words anyone said. A
    // session a person named is found by that name, above sessions that only
    // mention the words.
    seed('named', '/repo', ['we sketched the overlay'])
    await indexer.setSessionCustomTitle('named', 'Keyboard cheatsheet overlay')
    seed('mentions', '/repo', ['the cheatsheet overlay idea', 'cheatsheet overlay again'])
    indexer.persistIndexedSessionStart('branched', 'codex', '/repo', encodePathAsFolder('/repo'), 'gpt-5.5', 'high', null, 'fix/ws-jitter-backoff')
    seed('pr', '/repo', ['unrelated words'])

    const byTitle = search.searchSessionIndex('cheatsheet overlay').results
    expect(byTitle.map((result) => result.session.sessionId)).toEqual(['named', 'mentions'])
    expect(search.searchSessionIndex('keyboard').results.map((result) => result.session.sessionId)).toEqual(['named'])
    const [byName] = search.searchSessionIndex('keyboard').results
    expect(byName).toMatchObject({ snippet: '', messageId: -1, additionalMatches: [] })

    expect(search.searchSessionIndex('jitter backoff').results.map((result) => result.session.sessionId)).toEqual(['branched'])
    const metadata = new Map([['pr', '#482 Stop the reconnect storm']])
    expect(search.searchSessionIndex('482', { metadata }).results.map((result) => result.session.sessionId)).toEqual(['pr'])
    expect(search.searchSessionIndex('reconnect storm', { metadata }).results.map((result) => result.session.sessionId)).toEqual(['pr'])
  })

  test('names only reads no message', async () => {
    // WHY: "Keywords in names only" lists sessions by what they are called.
    seed('titled', '/repo', ['nothing here'])
    await indexer.setSessionCustomTitle('titled', 'Pelican migration plan')
    seed('said', '/repo', ['the pelican migration is next'])
    expect(search.searchSessionIndex('pelican', { namesOnly: true }).results.map((result) => result.session.sessionId)).toEqual(['titled'])
  })

  test('pages cover every match once, and the total counts them all', () => {
    // WHY: the picker lists every session that matches, a page at a time.
    for (let i = 0; i < 7; i++) seed(`p-${i}`, '/repo', [`the heron ${i}`])
    const first = search.searchSessionIndex('heron', { limit: 3 })
    const second = search.searchSessionIndex('heron', { limit: 3, offset: 3 })
    const third = search.searchSessionIndex('heron', { limit: 3, offset: 6 })
    expect([first.total, second.total, third.total]).toEqual([7, 7, 7])
    const ids = [...first.results, ...second.results, ...third.results].map((result) => result.session.sessionId)
    expect(new Set(ids).size).toBe(7)
  })

  test('every word matches as a prefix, and only a whole word\'s start', () => {
    seed('typed', '/repo', ['the websocket reconnect loop'])
    expect(search.searchSessionIndex('web reco').results).toHaveLength(1)
    expect(search.searchSessionIndex('socket').results).toHaveLength(0)
  })

  test('active since keeps only sessions active at or after the instant', () => {
    seed('old', '/repo', ['the egret'])
    seed('new', '/repo', ['the egret'])
    const db = getDb()
    db.prepare('UPDATE sessions SET last_timestamp = ? WHERE session_id = ?').run(1_000, 'old')
    db.prepare('UPDATE sessions SET last_timestamp = ? WHERE session_id = ?').run(9_000, 'new')
    expect(search.searchSessionIndex('egret', { activeSince: 5_000 }).results.map((result) => result.session.sessionId)).toEqual(['new'])
  })
})

describe('the session match migration', () => {
  test('clears the messages, re-reads every transcript, and says the index is rebuilding', () => {
    // WHY: the index changed shape (encoded row ids, no stemmer). Rows written
    // before it would be misread, so every transcript is read again, and a
    // search says it answers from part of them until the sweep ends.
    const db = getDb()
    db.prepare('DELETE FROM kv').run()
    expect(indexer.sessionMessagesRebuilding()).toBe(false)
    db.prepare("INSERT INTO session_files(path, provider, last_offset) VALUES ('/t/a.jsonl', 'claude', 500)").run()
    db.prepare("INSERT INTO kv(key, value) VALUES ('codex-session-index-watermark', '5')").run()
    seed('before', '/repo', ['the osprey'])
    // A file at the version before: no session numbers yet.
    db.exec('DROP TABLE session_keys')
    db.exec('PRAGMA user_version = 1')
    runMigrations(db)
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_files').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_messages').get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT value FROM kv WHERE key = 'codex-session-index-watermark'").get()).toBeNull()
    expect(indexer.sessionMessagesRebuilding()).toBe(true)
  })
})
