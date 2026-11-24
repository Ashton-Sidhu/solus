import { mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './unit/helpers/bun-sqlite'

// Production runs on Node. Bun tests use the same SQLite boundary through
// this adapter, including tests whose dependencies open the database indirectly.
mock.module('node:sqlite', () => ({ DatabaseSync }))

// Bun loads .env before tests. Never inherit a host's data directory or cloud
// database, or let a test write to the running developer server's log.
const testDirectory = mkdtempSync(join(tmpdir(), 'solus-test-'))
const dataDirectory = join(testDirectory, 'data')
mkdirSync(dataDirectory)
process.env.SOLUS_DEV_LOG = join(testDirectory, 'dev.log')
process.env.SOLUS_DATA_DIR = dataDirectory
process.env.SOLUS_TEST_DATABASES = '1'
const testDatabaseUrl = process.env.SOLUS_TEST_DATABASE_URL
if (testDatabaseUrl && process.env.DATABASE_URL === testDatabaseUrl) {
  process.env.SOLUS_DB = 'postgres'
} else {
  process.env.SOLUS_DB = 'sqlite'
  delete process.env.DATABASE_URL
  delete process.env.SOLUS_TEST_DATABASE_URL
}
process.on('exit', () => rmSync(testDirectory, { recursive: true, force: true }))
