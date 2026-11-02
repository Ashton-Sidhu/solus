import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: the files a person uploaded to a conversation live in that conversation's
// folder. When the session record goes, nothing else reads them, so they must go
// with it, and no other conversation's files may (t3code #26074).

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let records: typeof import('@solus/server/data/sessions/session-records')
let attachments: typeof import('@solus/server/data/assets/attachment-store')

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-record-attachments-'))
  process.env.SOLUS_DATA_DIR = dataDir
  records = await import('@solus/server/data/sessions/session-records')
  attachments = await import('@solus/server/data/assets/attachment-store')
})

afterAll(async () => {
  const { resetTestDatabase } = await import('./helpers/test-db')
  await resetTestDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

async function upload(sessionId: string): Promise<string> {
  const path = await attachments.attachmentUploadPath(sessionId, 'shot.png', 'image/png')
  writeFileSync(path, 'png')
  return path
}

test('removing a session record removes the files uploaded to it, and only those', async () => {
  const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
  for (const sessionId of ['session-gone', 'session-kept']) {
    await records.upsertSessionRecord('local', { sessionId, provider: 'codex', projectPath: '-repo', lastActivityAt: 1 })
  }
  const gone = await upload('session-gone')
  const kept = await upload('session-kept')

  await records.deleteSessionRecord(ANY_ORGANIZATION, 'session-gone')

  expect(existsSync(dirname(gone))).toBe(false)
  expect(existsSync(kept)).toBe(true)
  expect(existsSync(attachments.attachmentsRoot())).toBe(true)
})

test('a delete that removes no record leaves the files alone', async () => {
  const kept = await upload('session-kept')
  // Another organization's scope does not reach this local record.
  await records.deleteSessionRecord('other-org', 'session-kept')
  expect(existsSync(kept)).toBe(true)
})
