import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, runAsync } from '@solus/server/git/exec'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** A repository whose index is stale for one file: same content, newer mtime. */
function staleIndexRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'solus-optional-locks-'))
  directories.push(directory)
  git(['init', '-b', 'main'], directory)
  git(['config', 'user.name', 'Test'], directory)
  git(['config', 'user.email', 'test@example.invalid'], directory)
  writeFileSync(join(directory, 'file.txt'), 'content\n')
  git(['add', 'file.txt'], directory)
  git(['commit', '-m', 'Initial'], directory)
  const later = new Date(Date.now() + 60_000)
  utimesSync(join(directory, 'file.txt'), later, later)
  return directory
}

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

test('background git status does not rewrite the index', async () => {
  // WHY: the status refresh runs beside the user's own git commands. If it
  // takes .git/index.lock to save a refreshed index, the user's `git checkout`
  // or `git commit` fails with "index.lock: File exists".
  const directory = staleIndexRepository()
  const before = readFileSync(join(directory, '.git', 'index'))
  await runAsync('git', ['status', '--porcelain=v2'], directory)
  git(['status', '--porcelain=v2'], directory)
  expect(readFileSync(join(directory, '.git', 'index')).equals(before)).toBe(true)
})

test('a caller can still opt back in to optional locks', async () => {
  const directory = staleIndexRepository()
  const before = readFileSync(join(directory, '.git', 'index'))
  await runAsync('git', ['status', '--porcelain=v2'], directory, { env: { GIT_OPTIONAL_LOCKS: '1' } })
  expect(readFileSync(join(directory, '.git', 'index')).equals(before)).toBe(false)
})
