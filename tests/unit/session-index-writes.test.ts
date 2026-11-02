import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePathAsFolder } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { DatabaseSync } from './helpers/bun-sqlite'
import { StatementLog } from './helpers/statement-log'

mock.module('node:sqlite', () => ({ DatabaseSync }))
// The indexer sweeps `~/.claude/projects`, and Bun's `homedir()` does not follow
// `$HOME`: the sweep must never read this machine's own transcripts, so the home
// is the test's own directory.
let home: string | undefined
const realOs = await import('node:os')
// Kept by value: the namespace above follows the mock once it is installed.
const realHomedir = realOs.homedir
const homedir = () => home ?? realHomedir()
mock.module('node:os', () => ({ ...realOs, default: { ...realOs.default, homedir }, homedir }))

/**
 * plans/028 B1 and B3, plans/029 §8: the index writes of one turn are the size
 * of what changed. A Codex refresh appends the messages after the stored count
 * instead of writing the thread again; a Claude pass over a file that did not
 * grow leaves its `transcript_index` row untouched.
 */

type Indexer = typeof import('@solus/server/db/session-indexer')
let indexer: Indexer
let log: StatementLog
let closeDb: () => void
let getDb: typeof import('@solus/server/db').getDb
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-index-writes-'))
  home = mkdtempSync(join(tmpdir(), 'solus-index-home-'))
  process.env.SOLUS_DATA_DIR = dataDir
  indexer = await import('@solus/server/db/session-indexer')
  ;({ closeDb, getDb } = await import('@solus/server/db'))
  log = new StatementLog(getDb())
})

afterAll(() => {
  indexer.stopSessionIndexer()
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (home) rmSync(home, { recursive: true, force: true })
})

function message(messageId: string, content: string, timestamp: number): SessionLoadMessage {
  return { messageId, role: 'user', content, timestamp }
}

function storedTexts(sessionId: string): string[] {
  return indexer.getSessionMessages(sessionId).map((row) => row.text)
}

describe('a Codex refresh', () => {
  test('appends the messages after the stored count: two new messages are two inserts and no delete', () => {
    indexer.persistIndexedSessionStart('thread', 'codex', '/repo', encodePathAsFolder('/repo'), 'gpt-5.5', 'high')
    const first = [message('m1', 'one', 100), message('m2', 'two', 200), message('m3', 'three', 300)]
    indexer.indexSessionMessages('thread', first)
    expect(storedTexts('thread')).toEqual(['one', 'two', 'three'])

    log.clear()
    indexer.indexSessionMessages('thread', [...first, message('m4', 'four', 400), message('m5', 'five', 500)])
    expect(log.of('INSERT', 'session_messages')).toHaveLength(2)
    expect(log.of('INSERT', 'session_fts')).toHaveLength(2)
    expect(log.of('DELETE')).toHaveLength(0)
    expect(storedTexts('thread')).toEqual(['one', 'two', 'three', 'four', 'five'])

    // A refresh that brings nothing new writes nothing.
    log.clear()
    indexer.indexSessionMessages('thread', [...first, message('m4', 'four', 400), message('m5', 'five', 500)])
    expect(log.of('INSERT', 'session_messages')).toHaveLength(0)
    expect(log.of('INSERT', 'session_fts')).toHaveLength(0)
    expect(log.of('DELETE')).toHaveLength(0)
  })

  test('a thread that shrank is written again whole', () => {
    indexer.persistIndexedSessionStart('shrunk', 'codex', '/repo', encodePathAsFolder('/repo'), 'gpt-5.5', 'high')
    indexer.indexSessionMessages('shrunk', [message('a', 'one', 100), message('b', 'two', 200), message('c', 'three', 300)])
    log.clear()
    indexer.indexSessionMessages('shrunk', [message('a', 'one', 100), message('b', 'two', 200)])
    expect(log.of('DELETE', 'session_messages')).toHaveLength(1)
    expect(log.of('INSERT', 'session_messages')).toHaveLength(2)
    expect(storedTexts('shrunk')).toEqual(['one', 'two'])
  })

  test('a thread whose last stored message moved is written again whole, so no row is left behind', () => {
    // WHY: the append rule trusts the stored prefix. A thread forked or edited
    // under the same id has a different prefix; the one message compared is
    // the last stored one, and a mismatch there rebuilds the set.
    indexer.persistIndexedSessionStart('forked', 'codex', '/repo', encodePathAsFolder('/repo'), 'gpt-5.5', 'high')
    indexer.indexSessionMessages('forked', [message('a', 'one', 100), message('b', 'two', 200)])
    indexer.indexSessionMessages('forked', [message('x', 'zero', 50), message('a', 'one', 100), message('b', 'two', 200)])
    expect(storedTexts('forked')).toEqual(['zero', 'one', 'two'])
  })
})

/** A Claude transcript line, as the indexer and the head reader need it. */
function line(uuid: string, role: 'user' | 'assistant', text: string): string {
  return `${JSON.stringify({ type: role, uuid, timestamp: new Date(1_700_000_000_000 + Number(uuid.slice(1)) * 1000).toISOString(), cwd: home, message: { role, content: text } })}\n`
}

async function sweepUntil(done: () => boolean): Promise<void> {
  indexer.startSessionIndexer()
  const deadline = Date.now() + 10_000
  while (!done()) {
    if (Date.now() > deadline) throw new Error('The index sweep did not finish.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  indexer.stopSessionIndexer()
}

describe('a Claude pass', () => {
  test('over a file that did not grow updates no transcript_index row; a file that grew updates it once', async () => {
    const db = getDb()
    db.exec('CREATE TEMP TABLE index_updates(n INTEGER)')
    db.exec('CREATE TEMP TRIGGER count_index_updates AFTER UPDATE ON transcript_index BEGIN INSERT INTO index_updates VALUES (1); END')
    const updates = () => (db.prepare('SELECT COUNT(*) AS n FROM temp.index_updates').get() as { n: number }).n

    expect(realHomedir()).not.toBe(home)
    const projectDir = join(home!, '.claude', 'projects', encodePathAsFolder(home!))
    mkdirSync(projectDir, { recursive: true })
    const filePath = join(projectDir, 'claude-thread.jsonl')
    writeFileSync(filePath, line('u1', 'user', 'Please fix the reconnect loop so this transcript is long enough to index.') + line('u2', 'assistant', 'Looking at the reconnect loop now.'))
    const tracked = () => db.prepare('SELECT last_offset FROM session_files WHERE path = ?').get(filePath) as { last_offset: number } | undefined

    await sweepUntil(() => indexer.sessionIndexComplete() && !!tracked())
    expect(indexer.getIndexedSession('claude-thread')?.firstMessage).toContain('fix the reconnect loop')
    expect(updates()).toBe(0)

    // The file is read again from the start (its offset row is gone), its facts unchanged.
    db.prepare('DELETE FROM session_files').run()
    await sweepUntil(() => !!tracked())
    expect(storedTexts('claude-thread')).toHaveLength(2)
    expect(updates()).toBe(0)

    // The file grew: its size changed, so the row is written, once.
    appendFileSync(filePath, line('u3', 'user', 'And the timer too.'))
    await sweepUntil(() => tracked()?.last_offset === Bun.file(filePath).size)
    expect(updates()).toBe(1)
    expect(storedTexts('claude-thread')).toHaveLength(3)
  }, 20_000)
})
