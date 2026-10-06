import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

/**
 * One session id (docs/plans/session-identity.md): a session that changes
 * provider keeps its id, its record and the facts that are the session's.
 */

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''
let indexer: typeof import('@solus/server/db/session-indexer')
let lineage: typeof import('@solus/server/data/sessions/session-lineage')
let records: typeof import('@solus/server/data/sessions/session-records')
let closeDb: typeof import('@solus/server/db')['closeDb']

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-identity-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ closeDb } = await import('@solus/server/db'))
  closeDb()
  indexer = await import('@solus/server/db/session-indexer')
  lineage = await import('@solus/server/data/sessions/session-lineage')
  records = await import('@solus/server/data/sessions/session-records')
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200 && !await condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await condition()).toBe(true)
}

describe('a session that switches provider', () => {
  test('is one record under its session id, and its name follows it to the new thread', async () => {
    lineage.registerSessionLineage({ sessionId: 'session-a', provider: 'claude-code', providerSessionId: 'thread-claude', cwd: '/repo' })
    indexer.persistIndexedSessionStart('thread-claude', 'claude-code', '/repo', '-repo', 'opus', 'high', 'fix the parser')
    await until(async () => !!await records.getSessionRecord('local', 'session-a'))
    await indexer.setSessionCustomTitle('session-a', 'Parser fix')

    lineage.beginSessionHandoff({ sessionId: 'session-a', sourceProvider: 'claude-code', sourceProviderSessionId: 'thread-claude', targetProvider: 'codex', cwd: '/repo' })
    lineage.completeSessionHandoff('session-a', 'codex', 'thread-codex', '/repo')
    indexer.persistIndexedSessionStart('thread-codex', 'codex', '/repo', '-repo', 'gpt-test', 'medium', 'continue')

    await until(() => indexer.getIndexedSession('session-a')?.customTitle === 'Parser fix')
    const record = await records.getSessionRecord('local', 'session-a')
    expect(record).toMatchObject({ sessionId: 'session-a', provider: 'codex', customTitle: 'Parser fix' })
    // Neither thread has a record of its own.
    expect(await records.getSessionRecord('local', 'thread-claude')).toBeNull()
    expect(await records.getSessionRecord('local', 'thread-codex')).toBeNull()
  })
})
