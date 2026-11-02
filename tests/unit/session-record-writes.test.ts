import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { SessionRecord } from '@solus/contracts/types'
import { DatabaseSync } from './helpers/bun-sqlite'
import { StatementLog } from './helpers/statement-log'

mock.module('node:sqlite', () => ({ DatabaseSync }))

/**
 * plans/028 B3, plans/029 §8: a status change is one statement. The row comes
 * back with the UPDATE, so the listeners hear the stored record without a
 * read; a report never moves `created_at`.
 */

let dataDir: string
let log: StatementLog
let records: typeof import('@solus/server/data/sessions/session-records')
let ANY_ORGANIZATION: typeof import('@solus/server/admission/principal')['ANY_ORGANIZATION']
let closeDb: () => void
let closeDatabase: () => Promise<void>
let run: (query: ReturnType<typeof sql>) => Promise<unknown>

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-record-writes-'))
  process.env.SOLUS_DATA_DIR = dataDir
  const hostDb = await import('@solus/server/db')
  closeDb = hostDb.closeDb
  log = new StatementLog(hostDb.getDb())
  const database = await import('@solus/server/db/database')
  closeDatabase = database.closeDatabase
  run = (query) => database.getDatabase().run(query)
  records = await import('@solus/server/data/sessions/session-records')
  ;({ ANY_ORGANIZATION } = await import('@solus/server/admission/principal'))
})

afterAll(async () => {
  await closeDatabase()
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

test('a status change is one UPDATE that returns the record the listeners hear', async () => {
  await records.upsertOwnSessionRecord({ sessionId: 's1', provider: 'codex', projectPath: '-repo', lastActivityAt: 1_000, createdAt: 1_000 })
  const heard: SessionRecord[] = []
  const stop = records.onSessionRecordChanged((record) => { heard.push(record) })
  log.clear()
  await records.setSessionRecordStatus(ANY_ORGANIZATION, 's1', 'running')
  stop()
  expect(log.statements.map(({ text }) => text.split(' ')[0])).toEqual(['UPDATE'])
  expect(log.statements[0]!.text).toContain('RETURNING')
  expect(heard.map((record) => [record.sessionId, record.status, record.provider])).toEqual([['s1', 'running', 'codex']])
  expect(heard[0]!.isLead).toBeUndefined()
})

test('a row admitted before its provider started takes the status and is not announced', async () => {
  await run(sql`INSERT INTO session_records(session_id, organization_id, created_by, created_at, status) VALUES ('admitted', 'local', 'owner', 5, 'idle')`)
  const heard: SessionRecord[] = []
  const stop = records.onSessionRecordChanged((record) => { heard.push(record) })
  await records.setSessionRecordStatus(ANY_ORGANIZATION, 'admitted', 'running')
  stop()
  expect(heard).toEqual([])
  const { getDatabase } = await import('@solus/server/db/database')
  expect(await getDatabase().get(sql`SELECT status FROM session_records WHERE session_id = 'admitted'`)).toEqual({ status: 'running' })
})

test('a later report keeps the first created_at', async () => {
  await records.upsertOwnSessionRecord({ sessionId: 's2', provider: 'codex', projectPath: '-repo', lastActivityAt: 1_000, createdAt: 1_000 })
  const later = await records.upsertOwnSessionRecord({ sessionId: 's2', provider: 'codex', projectPath: '-repo', lastActivityAt: 9_000, createdAt: 9_000 })
  expect(later.createdAt).toBe(1_000)
  expect((await records.getSessionRecord(ANY_ORGANIZATION, 's2'))?.createdAt).toBe(1_000)
})
