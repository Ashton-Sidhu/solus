import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertTestDatabase } from '@solus/server/db/test-safety'

const directories: string[] = []
const previousTestUrl = process.env.SOLUS_TEST_DATABASE_URL
afterEach(() => {
  if (previousTestUrl === undefined) delete process.env.SOLUS_TEST_DATABASE_URL
  else process.env.SOLUS_TEST_DATABASE_URL = previousTestUrl
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'solus-db-safety-'))
  directories.push(directory)
  return directory
}

test('tests refuse live SQLite paths before a file can open', () => {
  expect(() => assertTestDatabase({ kind: 'sqlite', path: join(homedir(), '.solus', 'solus.db') })).toThrow(/temporary directory/)
  expect(() => assertTestDatabase({ kind: 'sqlite', path: join(homedir(), 'Library', 'Application Support', 'Solus', 'solus.db') })).toThrow(/temporary directory/)
  expect(() => assertTestDatabase({ kind: 'sqlite', path: join(fixtureDirectory(), 'data', 'solus.db') })).not.toThrow()
})

test('a temporary symlink cannot redirect SQLite into live data', () => {
  const link = join(fixtureDirectory(), 'host')
  symlinkSync(homedir(), link, 'dir')
  expect(() => assertTestDatabase({ kind: 'sqlite', path: join(link, '.solus', 'solus.db') })).toThrow(/temporary directory/)
})

test('Postgres requires the exact database URL assigned by the test runner', () => {
  const url = 'postgres://fixture@localhost/solus_test_fixture_0'
  delete process.env.SOLUS_TEST_DATABASE_URL
  expect(() => assertTestDatabase({ kind: 'postgres', url })).toThrow(/created by/)
  process.env.SOLUS_TEST_DATABASE_URL = url
  expect(() => assertTestDatabase({ kind: 'postgres', url })).not.toThrow()
  expect(() => assertTestDatabase({ kind: 'postgres', url: url.replace('localhost', 'other-host') })).toThrow(/created by/)
  process.env.SOLUS_TEST_DATABASE_URL = 'postgres://fixture@localhost/production'
  expect(() => assertTestDatabase({ kind: 'postgres', url: process.env.SOLUS_TEST_DATABASE_URL })).toThrow(/created by/)
})

test('direct bun test isolates inherited data and Postgres settings before imports', () => {
  const directory = fixtureDirectory()
  const inheritedData = join(directory, 'host-data')
  const resultPath = join(directory, 'result.json')
  const root = resolve(import.meta.dir, '../..')
  const testFile = join(directory, 'isolation.test.ts')
  writeFileSync(testFile, `
import { expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { writeFileSync } from 'node:fs'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
test('write only to the isolated database', async () => {
  const { getDb, closeDb } = await import(${JSON.stringify(join(root, 'packages/server/src/db/index.ts'))})
  const { getDatabase, closeDatabase } = await import(${JSON.stringify(join(root, 'packages/server/src/db/database.ts'))})
  expect(getDatabase().engine).toBe('sqlite')
  getDb().exec("CREATE TABLE isolation_probe (value TEXT); INSERT INTO isolation_probe VALUES ('fixture')")
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ directory: process.env.SOLUS_DATA_DIR }))
  await closeDatabase()
  closeDb()
  process.env.SOLUS_DATA_DIR = ${JSON.stringify(join(homedir(), '.solus'))}
  expect(() => getDb()).toThrow(/temporary directory/)
  process.env.SOLUS_DB = 'postgres'
  process.env.DATABASE_URL = 'postgres://fixture@127.0.0.1:1/production'
  expect(() => getDatabase()).toThrow(/created by/)
})
`)
  const child = spawnSync(process.execPath, ['test', testFile], {
    cwd: root,
    env: { ...process.env, SOLUS_DATA_DIR: inheritedData, SOLUS_DB: 'postgres', DATABASE_URL: 'postgres://fixture@127.0.0.1:1/production', SOLUS_TEST_DATABASE_URL: '', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    encoding: 'utf8',
    timeout: 20_000,
  })
  if (child.status !== 0) throw new Error(child.stdout + child.stderr)
  expect(child.status).toBe(0)
  expect(existsSync(inheritedData)).toBe(false)
  const result: { directory: string } = JSON.parse(readFileSync(resultPath, 'utf8'))
  expect(result.directory).not.toBe(inheritedData)
  directories.push(result.directory)
})
