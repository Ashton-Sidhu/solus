import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { plainSnippet, SNIPPET_HIT_CLOSE, SNIPPET_HIT_OPEN } from '@solus/contracts/search-snippet'
import { encodePathAsFolder } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'

// The production DB layer imports `node:sqlite`, which Bun's test runtime does
// not provide. bun:sqlite is API-compatible for what the indexer uses, so shim
// it in before the DB module loads; the modules under test are imported in
// beforeAll, after the mock is in place.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type IndexerModule = typeof import('@solus/server/db/session-indexer')
type SearchModule = typeof import('@solus/server/db/session-search')
let indexer: IndexerModule
let search: SearchModule
let closeDb: () => void

const CWD = '/Users/test/proj'
const PROJECT = encodePathAsFolder(CWD)

let dataDir: string
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-window-'))
  process.env.SOLUS_DATA_DIR = dataDir
  indexer = await import('@solus/server/db/session-indexer')
  search = await import('@solus/server/db/session-search')
  ;({ closeDb } = await import('@solus/server/db'))
})
afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
})
afterEach(() => {
  closeDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

function msg(role: string, content: string, timestamp: number): SessionLoadMessage {
  return { role, content, timestamp }
}

function seed(sessionId: string, texts: string[]): void {
  indexer.persistIndexedSessionStart(sessionId, 'codex', CWD, PROJECT, 'gpt-5.5', 'high')
  indexer.indexSessionMessages(sessionId, texts.map((text, index) => msg(index % 2 === 0 ? 'user' : 'assistant', text, (index + 1) * 100)),
  )
}

describe('getSessionMessageWindow', () => {
  test('a search hit names the message the preview window then centres on', () => {
    // WHY: the picker's preview opened on the transcript's ends, so a hit deep
    // in a long session showed none of the words that matched. The hit has to
    // carry the message row, and the window has to be built around that row.
    seed('s-1', ['one', 'two', 'three', 'the pelican lands here', 'five', 'six', 'seven'])
    const [hit] = search.searchSessionIndex('pelican').results
    expect(hit.session.sessionId).toBe('s-1')

    const window = indexer.getSessionMessageWindow('s-1', hit.messageId, 1)
    expect(window.messages.map((message) => message.text)).toEqual(['three', 'the pelican lands here', 'five'])
    expect(window.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(window.messages[1].messageId).toBe(hit.messageId)
    expect(window).toMatchObject({ hiddenBefore: 2, hiddenAfter: 2 })
  })

  test('a hit marks each whole word a query word starts, and carries its rank', () => {
    // WHY: every word matches as a prefix (docs/plans/unified-search.md), so
    // "lan" finds "lands" and the mark covers the word it starts, as the
    // client marks a name. Nothing is stemmed: "landing" is not "lands".
    seed('s-0', ['one', 'the pelican lands here'])
    const [hit] = search.searchSessionIndex('lan').results
    expect(hit.snippet).toContain(`${SNIPPET_HIT_OPEN}lands${SNIPPET_HIT_CLOSE}`)
    expect(plainSnippet(hit.snippet)).toBe('the pelican lands here')
    expect(typeof hit.rank).toBe('number')
    expect(search.searchSessionIndex('landing').results).toEqual([])
  })

  test('the window stops at the transcript ends and counts nothing beyond them', () => {
    seed('s-2', ['heron first', 'second'])
    const [hit] = search.searchSessionIndex('heron').results
    const window = indexer.getSessionMessageWindow('s-2', hit.messageId, 3)
    expect(window.messages.map((message) => message.text)).toEqual(['heron first', 'second'])
    expect(window).toMatchObject({ hiddenBefore: 0, hiddenAfter: 0 })
  })

  test('a message the index no longer holds yields an empty window, not a neighbour', () => {
    // WHY: a re-index replaces every row of the session, so a hit from before
    // it can name a row that is gone. Guessing a nearby row would show the
    // wrong passage as if it were the match.
    seed('s-3', ['one', 'two', 'egret once'])
    const [hit] = search.searchSessionIndex('egret').results
    indexer.indexSessionMessages('s-3', [msg('user', 'shorter now', 100)])
    expect(indexer.getSessionMessageWindow('s-3', hit.messageId)).toEqual({
      messages: [],
      hiddenBefore: 0,
      hiddenAfter: 0,
    })
  })

  test('the window never crosses into another session', () => {
    seed('s-4', ['stork alpha'])
    seed('s-5', ['stork beta', 'reply'])
    const hit = search.searchSessionIndex('stork').results.find((result) => result.session.sessionId === 's-4')!
    const window = indexer.getSessionMessageWindow('s-4', hit.messageId, 5)
    expect(window.messages.map((message) => message.text)).toEqual(['stork alpha'])
    // Asking for the row under the wrong session is a miss, not a leak.
    expect(indexer.getSessionMessageWindow('s-5', hit.messageId).messages).toEqual([])
  })
})


test('a machine answers GET /v1/sessions/search from its own index, with the record a resume needs', async () => {
  // WHY: clients search a machine through the HTTP API now, not the
  // `searchSessions` RPC. The hits must be the ones the index finds, and each
  // must carry the session's record, working directory included, or the row
  // it lands on cannot be opened.
  seed('s-http', ['the osprey nests', 'reply'])
  const { SessionApiOperations } = await import('@solus/server/data/sessions/api-operations')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const { getDatabase } = await import('@solus/server/db/database')
  const { getSessionRecord } = await import('@solus/server/data/sessions/session-records')
  const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
  // The start writes its record behind the index row; wait for it to land.
  for (let attempt = 0; attempt < 50 && !(await getSessionRecord(ANY_ORGANIZATION, 's-http')); attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  const operations = new SessionApiOperations(new ShareManager({ db: getDatabase() }))
  const found = await operations.search({
    principal: { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' },
    home: { kind: 'local', hostId: 'this-mac' },
    scopes: ['sessions:read'],
  }, { q: 'osprey' })
  expect(found.items.map((item) => item.session.id)).toEqual(['s-http'])
  expect(found.items[0]!.session).toMatchObject({ cwd: CWD, isWorktree: false, projectRoot: CWD })
  expect(plainSnippet(found.items[0]!.snippet)).toBe('the osprey nests')
  // Its message id is the index's own, so the preview window opens on it.
  expect(indexer.getSessionMessageWindow('s-http', found.items[0]!.messageId).messages[0]?.text).toBe('the osprey nests')
})

test('a session named by a long opening message is still listed and found, within the schema clients check', async () => {
  // WHY: a session with no title is named by its opening message. One longer
  // than the schema's 500 characters failed a client's check of the whole
  // page, and the picker listed no session at all.
  const opening = `the heron ${'long opening message '.repeat(100)}`
  indexer.persistIndexedSessionStart('s-long', 'codex', CWD, PROJECT, 'gpt-5.5', 'high', opening)
  indexer.indexSessionMessages('s-long', [msg('user', opening, 100)])
  const { SessionApiOperations } = await import('@solus/server/data/sessions/api-operations')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const { getDatabase } = await import('@solus/server/db/database')
  const { getSessionRecord } = await import('@solus/server/data/sessions/session-records')
  const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
  const { workspaceSessionPageSchema, workspaceSessionSearchResultSchema } = await import('@solus/contracts/solus-api')
  for (let attempt = 0; attempt < 50 && !(await getSessionRecord(ANY_ORGANIZATION, 's-long')); attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  const operations = new SessionApiOperations(new ShareManager({ db: getDatabase() }))
  const context = {
    principal: { kind: 'local-owner' as const, deviceId: null, deviceLabel: 'Mac' },
    home: { kind: 'local' as const, hostId: 'this-mac' },
    scopes: ['sessions:read' as const],
  }
  const page = workspaceSessionPageSchema.parse(await operations.list(context, { limit: 50 }))
  expect(page.items.map((item) => item.id)).toContain('s-long')
  expect(page.items.find((item) => item.id === 's-long')!.title!.length).toBeLessThanOrEqual(500)
  const found = workspaceSessionSearchResultSchema.parse(await operations.search(context, { q: 'heron' }))
  expect(found.items.map((item) => item.session.id)).toEqual(['s-long'])
})

test('search returns a saved session title and bounded additional matches in one result', async () => {
  seed('named', ['pelican one', 'pelican two', 'pelican three', 'pelican four'])
  await indexer.setSessionCustomTitle('named', 'Saved session title')
  const hits = search.searchSessionIndex('pelican').results
  expect(hits).toHaveLength(1)
  expect(hits[0].session.customTitle).toBe('Saved session title')
  expect(hits[0].additionalMatches).toHaveLength(2)
  expect(new Set([hits[0].messageId, ...hits[0].additionalMatches!.map((hit) => hit.messageId)]).size).toBe(3)
  seed('other', ['pelican other'])
  expect(search.searchSessionIndex('pelican', { limit: 1 }).results).toHaveLength(1)
})
