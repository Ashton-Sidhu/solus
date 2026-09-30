import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveHomePath } from '@solus/server/platform/paths'

// A bare `~` resolves to the owner chat folder, which lives in the data folder:
// point it at a sandbox, never at the live one.
const dataDir = mkdtempSync(join(tmpdir(), 'solus-home-path-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = dataDir

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

test('resolves the sentinel the renderer sends when no directory is known to the chat folder, not the home folder', () => {
  expect(resolveHomePath('~')).toBe(join(dataDir, 'my-workspace'))
})

test('expands a tilde-rooted path', () => {
  expect(resolveHomePath('~/projects/solus')).toBe(join(homedir(), 'projects/solus'))
  expect(resolveHomePath('~/')).toBe(homedir())
})

test('treats an empty directory as unknown rather than passing it to spawn', () => {
  expect(resolveHomePath('')).toBe(join(dataDir, 'my-workspace'))
})

test('leaves a real path alone', () => {
  expect(resolveHomePath('/Users/someone/code')).toBe('/Users/someone/code')
})

test('only expands a leading tilde — one inside a path is a real directory name', () => {
  expect(resolveHomePath('/tmp/~backup')).toBe('/tmp/~backup')
  expect(resolveHomePath('/tmp/~/nested')).toBe('/tmp/~/nested')
})
