import { afterAll, expect, mock, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { closeDb, getDb } = await import('@solus/server/db')

// WHY (t3code #27904): the data dir holds the database, keys, and transcripts.
// Other local users must not list it or read the database.
const previous = process.env.SOLUS_DATA_DIR
const roots: string[] = []
afterAll(() => {
  closeDb()
  if (previous === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previous
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'solus-data-mode-'))
  roots.push(root)
  return root
}

test('a new data dir and its database are private to this user', () => {
  closeDb()
  const dir = join(freshRoot(), 'fresh')
  process.env.SOLUS_DATA_DIR = dir
  getDb()
  expect(statSync(dir).mode & 0o077).toBe(0)
  expect(statSync(join(dir, 'solus.db')).mode & 0o077).toBe(0)
})

test('an older data dir and database made with the default mode are tightened on start', () => {
  closeDb()
  const dir = join(freshRoot(), 'older')
  mkdirSync(dir, { mode: 0o755 })
  chmodSync(dir, 0o755)
  writeFileSync(join(dir, 'solus.db'), '', { mode: 0o644 })
  process.env.SOLUS_DATA_DIR = dir
  getDb()
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(statSync(join(dir, 'solus.db')).mode & 0o777).toBe(0o600)
})
