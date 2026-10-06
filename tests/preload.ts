import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A test run is a development runtime started from the repo root, so its logger
// would truncate the running dev server's `dev.log` and write fixture entries
// into it. Every test process, and every child it spawns, logs here instead.
process.env.SOLUS_DEV_LOG ??= join(mkdtempSync(join(tmpdir(), 'solus-test-log-')), 'dev.log')

// Bun loads .env before tests. Never inherit a host's data directory or cloud
// database. Only the unit runner may supply a database that it created itself.
const dataDirectory = mkdtempSync(join(tmpdir(), 'solus-test-data-'))
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
process.on('exit', () => rmSync(dataDirectory, { recursive: true, force: true }))
