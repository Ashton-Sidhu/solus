import { afterAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '@solus/server/git/exec'

// The Git helpers reach the server's database module, which Bun loads only
// through its own SQLite.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { computeGitState, parseStatus } = await import('@solus/server/git/git-helpers')

const directories: string[] = []
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function repository(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'solus-git-change-counts-')))
  directories.push(directory)
  git(['init', '-b', 'main'], directory)
  git(['config', 'user.email', 'test@example.com'], directory)
  git(['config', 'user.name', 'Test'], directory)
  writeFileSync(join(directory, 'base.ts'), 'one\ntwo\nthree\n')
  git(['add', '.'], directory)
  git(['commit', '-m', 'base'], directory)
  return directory
}

test('the file count covers every change, past the listed entries', () => {
  const raw = [
    '# branch.head main',
    ...Array.from({ length: 250 }, (_, i) => `? file-${i}.ts`),
  ].join('\n')
  const status = parseStatus(raw)
  // The list stays bounded for the UI; the count does not, so Discard names
  // what it will actually throw away.
  expect(status.files).toHaveLength(200)
  expect(status.hasMoreFiles).toBe(true)
  expect(status.fileCount).toBe(250)
})

test('on a branch, the change totals match the branch review, not only uncommitted work', async () => {
  const directory = repository()
  git(['checkout', '-b', 'feature'], directory)
  writeFileSync(join(directory, 'committed.ts'), 'a\nb\n')
  git(['add', '.'], directory)
  git(['commit', '-m', 'on the branch'], directory)
  writeFileSync(join(directory, 'base.ts'), 'one\nthree\n')
  writeFileSync(join(directory, 'untracked.ts'), 'x\ny\nz\n')

  const status = await computeGitState(directory, { includeDetails: true })

  expect(status?.uncommittedChanges.fileCount).toBe(2)
  // committed.ts (+2), base.ts (−1), untracked.ts (+3): what the diff shows.
  expect(status?.branchChanges).toEqual({ fileCount: 3, insertions: 5, deletions: 1 })
})

test('on the target branch, the change totals are the uncommitted work', async () => {
  const directory = repository()
  writeFileSync(join(directory, 'base.ts'), 'one\ntwo\nthree\nfour\n')
  writeFileSync(join(directory, 'untracked.ts'), 'x\n')

  const status = await computeGitState(directory, { includeDetails: true })

  expect(status?.branchChanges).toEqual({ fileCount: 2, insertions: 2, deletions: 0 })
})
