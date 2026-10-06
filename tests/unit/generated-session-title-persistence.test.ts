import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''
let indexer: typeof import('@solus/server/db/session-indexer')
let closeDb: typeof import('@solus/server/db')['closeDb']

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-title-'))
  process.env.SOLUS_DATA_DIR = dataDir
  indexer = await import('@solus/server/db/session-indexer')
  ;({ closeDb } = await import('@solus/server/db'))
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

test('a generated title fills an empty name once and keeps a later manual name', async () => {
  // WHY: a person can rename the worker during a slow metadata run. The
  // generated write must lose that race in the database, not only in the UI.
  indexer.persistIndexedSessionStart('worker-1', 'codex', '/repo', '/repo', 'gpt-test', 'low', 'long opening prompt', null, {
    parentSessionId: 'lead-1', messageId: 'exchange-1', intent: 'delegate', createdAt: 1,
  })
  expect(indexer.getIndexedSession('worker-1')?.delegation?.parentSessionId).toBe('lead-1')
  expect(await indexer.setSessionGeneratedTitle('worker-1', 'Short title')).toBe(true)
  expect(await indexer.setSessionGeneratedTitle('worker-1', 'Other title')).toBe(false)
  expect(indexer.getIndexedSession('worker-1')?.customTitle).toBe('Short title')

  await indexer.setSessionCustomTitle('worker-1', 'My title')
  expect(await indexer.setSessionGeneratedTitle('worker-1', 'Late title')).toBe(false)
  expect(indexer.getIndexedSession('worker-1')?.customTitle).toBe('My title')
})
