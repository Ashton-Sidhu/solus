import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { sessionStates } from '@solus/server/data/sessions/schema'
import { resetTestDatabase } from './helpers/test-db'

// WHY: a failed query's message is what a failed turn shows a person. Drizzle's
// own message is the statement plus every bound value, which names neither the
// reason nor anything the reader can act on — and prints the payload of the
// write back at them. A managed host whose migrations were older than its server
// reported a whole execution-preferences document instead of `no such column`.

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let database: typeof import('@solus/server/db/database')
let dataDir: string
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-query-errors-'))
  process.env.SOLUS_DATA_DIR = dataDir
  database = await import('@solus/server/db/database')
})

afterAll(async () => {
  await resetTestDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

test('a failed write reports the driver reason, not the statement and its values', async () => {
  const write = database.getDatabase().run(sql`
    UPDATE ${sessionStates} SET no_such_preference = ${'{"leadInstructions":"a private document"}'}
    WHERE session_id = ${'session-1'}
  `)

  await expect(write).rejects.toThrow(/no such column/i)
  let message = 'the write was accepted'
  await write.catch((reason: Error) => { message = reason.message })
  expect(message).not.toContain('private document')
  expect(message).not.toContain('Failed query')
})
