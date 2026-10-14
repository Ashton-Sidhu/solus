import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// WHY: without `sqlite_stat1` the query planner guesses index selectivity and
// can choose a full scan over the transcript tables. Opening the database must
// collect the statistics, including for indexes a migration just added.

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let dataDir = ''
let previousDataDir: string | undefined
let dbModule: typeof import('@solus/server/db/index')

beforeAll(async () => {
  previousDataDir = process.env.SOLUS_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'solus-planner-stats-'))
  process.env.SOLUS_DATA_DIR = dataDir
  dbModule = await import('@solus/server/db/index')
  dbModule.closeDb()
})

afterAll(() => {
  dbModule.closeDb()
  process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe('database open', () => {
  test('collects planner statistics after migrations', () => {
    const statistics = dbModule.getDb().prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'").get()
    expect(statistics).toEqual({ name: 'sqlite_stat1' })
  })
})
