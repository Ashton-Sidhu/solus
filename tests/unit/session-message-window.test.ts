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
let indexer: IndexerModule
let closeDb: () => void

const CWD = '/Users/test/proj'
const PROJECT = encodePathAsFolder(CWD)

let dataDir: string
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-window-'))
  process.env.SOLUS_DATA_DIR = dataDir
  indexer = await import('@solus/server/db/session-indexer')
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
  indexer.indexSessionMessages(
    sessionId,
    'codex',
    texts.map((text, index) => msg(index % 2 === 0 ? 'user' : 'assistant', text, (index + 1) * 100)),
  )
}

describe('getSessionMessageWindow', () => {
  test('a search hit names the message the preview window then centres on', () => {
    // WHY: the picker's preview opened on the transcript's ends, so a hit deep
    // in a long session showed none of the words that matched. The hit has to
    // carry the message row, and the window has to be built around that row.
    seed('s-1', ['one', 'two', 'three', 'the pelican lands here', 'five', 'six', 'seven'])
    const [hit] = indexer.searchIndexedSessions('pelican')
    expect(hit.session.sessionId).toBe('s-1')

    const window = indexer.getSessionMessageWindow('s-1', hit.messageId, 1)
    expect(window.messages.map((message) => message.text)).toEqual(['three', 'the pelican lands here', 'five'])
    expect(window.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(window.messages[1].messageId).toBe(hit.messageId)
    expect(window).toMatchObject({ hiddenBefore: 2, hiddenAfter: 2 })
  })

  test('a hit marks the tokens the index matched and carries its score', () => {
    // WHY: the index stems, so "landing" finds "lands" and no client can mark
    // that by spelling. The markers say what hit; the score lets a reader
    // order hits by how well they matched rather than only by date.
    seed('s-0', ['one', 'the pelican lands here'])
    const [hit] = indexer.searchIndexedSessions('landing')
    expect(hit.snippet).toContain(`${SNIPPET_HIT_OPEN}lands${SNIPPET_HIT_CLOSE}`)
    expect(plainSnippet(hit.snippet)).toBe('the pelican lands here')
    expect(typeof hit.rank).toBe('number')
  })

  test('the window stops at the transcript ends and counts nothing beyond them', () => {
    seed('s-2', ['heron first', 'second'])
    const [hit] = indexer.searchIndexedSessions('heron')
    const window = indexer.getSessionMessageWindow('s-2', hit.messageId, 3)
    expect(window.messages.map((message) => message.text)).toEqual(['heron first', 'second'])
    expect(window).toMatchObject({ hiddenBefore: 0, hiddenAfter: 0 })
  })

  test('a message the index no longer holds yields an empty window, not a neighbour', () => {
    // WHY: a re-index replaces every row of the session, so a hit from before
    // it can name a row that is gone. Guessing a nearby row would show the
    // wrong passage as if it were the match.
    seed('s-3', ['one', 'two', 'egret once'])
    const [hit] = indexer.searchIndexedSessions('egret')
    indexer.indexSessionMessages('s-3', 'codex', [msg('user', 'shorter now', 100)])
    expect(indexer.getSessionMessageWindow('s-3', hit.messageId)).toEqual({
      messages: [],
      hiddenBefore: 0,
      hiddenAfter: 0,
    })
  })

  test('the window never crosses into another session', () => {
    seed('s-4', ['stork alpha'])
    seed('s-5', ['stork beta', 'reply'])
    const hit = indexer.searchIndexedSessions('stork').find((result) => result.session.sessionId === 's-4')!
    const window = indexer.getSessionMessageWindow('s-4', hit.messageId, 5)
    expect(window.messages.map((message) => message.text)).toEqual(['stork alpha'])
    // Asking for the row under the wrong session is a miss, not a leak.
    expect(indexer.getSessionMessageWindow('s-5', hit.messageId).messages).toEqual([])
  })
})


test('search returns a saved session title and bounded additional matches in one result', () => {
  seed('named', ['pelican one', 'pelican two', 'pelican three', 'pelican four'])
  indexer.setSessionCustomTitle('named', 'Saved session title')
  const hits = indexer.searchIndexedSessions('pelican')
  expect(hits).toHaveLength(1)
  expect(hits[0].session.customTitle).toBe('Saved session title')
  expect(hits[0].additionalMatches).toHaveLength(2)
  expect(new Set([hits[0].messageId, ...hits[0].additionalMatches!.map((hit) => hit.messageId)]).size).toBe(3)
  seed('other', ['pelican other'])
  expect(indexer.searchIndexedSessions('pelican', {}, 1)).toHaveLength(1)
})
