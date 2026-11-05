import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// WHY: a provider event that lands after the host shut down must not reopen the
// database it closed, which recreates solus.db-wal and -shm after the exit
// (t3code #27831). The close is for good, so the check runs in its own process.
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('after the shutdown close, a late writer fails instead of reopening the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'solus-db-shutdown-'))
  directories.push(directory)
  const root = resolve(import.meta.dir, '../..')
  const testFile = join(directory, 'shutdown.test.ts')
  writeFileSync(testFile, `
import { expect, mock, test } from 'bun:test'
import { DatabaseSync } from ${JSON.stringify(join(root, 'tests/unit/helpers/bun-sqlite.ts'))}
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
mock.module('node:sqlite', () => ({ DatabaseSync }))
test('late writer', async () => {
  const { getDb } = await import(${JSON.stringify(join(root, 'packages/server/src/db/index.ts'))})
  const { closeDatabaseForShutdown, getDatabase } = await import(${JSON.stringify(join(root, 'packages/server/src/db/database.ts'))})
  getDatabase()
  getDb().exec('CREATE TABLE probe (value TEXT)')
  await closeDatabaseForShutdown()
  const dataDir = process.env.SOLUS_DATA_DIR!
  rmSync(join(dataDir, 'solus.db-wal'), { force: true })
  rmSync(join(dataDir, 'solus.db-shm'), { force: true })
  expect(() => getDb()).toThrow(/shut down/)
  expect(() => getDatabase()).toThrow(/shut down/)
  expect(existsSync(join(dataDir, 'solus.db-wal'))).toBe(false)
})
`)
  const child = spawnSync(process.execPath, ['test', testFile], {
    cwd: root,
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    encoding: 'utf8',
    timeout: 20_000,
  })
  if (child.status !== 0) throw new Error(child.stdout + child.stderr)
  expect(child.status).toBe(0)
})
