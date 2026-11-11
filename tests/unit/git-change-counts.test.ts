import { afterAll, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '@solus/server/git/exec'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

// The Git helpers reach the server's database module, which Bun loads only
// through its own SQLite.
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { computeGitState, parseStatus } = await import('@solus/server/git/git-helpers')

const { getDiff, getDiffStats, getEpisodeDiff } = await import('@solus/server/git/session-snapshots')

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

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

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
  // The uncommitted part leaves out committed.ts: what the next commit takes.
  expect(status?.uncommittedTotals).toEqual({ fileCount: 2, insertions: 3, deletions: 1 })
})

test('on a branch, a commit clears the uncommitted totals and keeps the branch totals', async () => {
  // WHY: the Changes row reported only the branch total, so a commit left the
  // same diff in place and read as if the commit had not happened.
  const directory = repository()
  git(['checkout', '-b', 'feature'], directory)
  writeFileSync(join(directory, 'base.ts'), 'one\ntwo\nthree\nfour\n')
  git(['commit', '-am', 'on the branch'], directory)

  const status = await computeGitState(directory, { includeDetails: true })

  expect(status?.uncommittedTotals).toEqual({ fileCount: 0, insertions: 0, deletions: 0 })
  expect(status?.branchChanges).toEqual({ fileCount: 1, insertions: 1, deletions: 0 })
})

test('on the target branch, the change totals are the uncommitted work', async () => {
  const directory = repository()
  writeFileSync(join(directory, 'base.ts'), 'one\ntwo\nthree\nfour\n')
  writeFileSync(join(directory, 'untracked.ts'), 'x\n')

  const status = await computeGitState(directory, { includeDetails: true })

  expect(status?.branchChanges).toEqual({ fileCount: 2, insertions: 2, deletions: 0 })
  expect(status?.uncommittedTotals).toEqual(status?.branchChanges)
})

test('the status scan reports whitespace in file names exactly', async () => {
  // WHY: trimming git's output dropped the trailing space of the last path, so
  // the list named a file that does not exist (t3code #12464).
  const directory = repository()
  writeFileSync(join(directory, ' leading.txt'), 'a\n')
  writeFileSync(join(directory, 'trailing.txt '), 'b\n')

  const status = await computeGitState(directory)

  expect(status?.uncommittedChanges.files.map((file) => file.path).sort()).toEqual([' leading.txt', 'trailing.txt '])
})

for (const objectFormat of ['sha1', 'sha256']) test(`a repository with no commit yet shows changes (${objectFormat})`, async () => {
  // A new project is `git init` alone. The composer's branch chip and the Git
  // rows read this status, so a null answer here hides them until a commit.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'solus-git-unborn-')))
  directories.push(directory)
  git(['init', '-b', 'trunk', `--object-format=${objectFormat}`], directory)
  const emptyStatus = await computeGitState(directory, { includeDetails: true })
  expect(emptyStatus?.branchChanges).toEqual({ fileCount: 0, insertions: 0, deletions: 0 })
  writeFileSync(join(directory, 'draft.ts'), 'x\n')

  const status = await computeGitState(directory, { includeDetails: true })

  expect(status?.repoRoot).toBe(directory)
  expect(status?.branch).toBe('trunk')
  expect(status?.headSha).toBeNull()
  // The default-branch probe needs a commit, so the unborn branch is its own target.
  expect(status?.targetBranch).toBe('trunk')
  expect(status?.uncommittedChanges.fileCount).toBe(1)
  expect(status?.branchChanges).toEqual({ fileCount: 1, insertions: 1, deletions: 0 })

  // The count and the opened review must agree before the first commit.
  const scope = { kind: 'working-tree' } as const
  const patch = await getDiff(directory, directory, scope, null)
  expect(patch?.patch).toContain('+x')
  expect(await getEpisodeDiff(directory, directory, 'HEAD')).toEqual(patch)
  expect(await getDiffStats(directory, directory, scope, null)).toEqual([
    { path: 'draft.ts', additions: 1, deletions: 0, status: 'A' },
  ])

  // Staged content can differ from disk. Reading changes must preserve it.
  git(['add', 'draft.ts'], directory)
  const index = readFileSync(join(directory, '.git', 'index'))
  writeFileSync(join(directory, 'draft.ts'), 'x\ny\n')
  const stagedStatus = await computeGitState(directory, { includeDetails: true })
  expect(stagedStatus?.branchChanges).toEqual({ fileCount: 1, insertions: 2, deletions: 0 })
  expect(readFileSync(join(directory, '.git', 'index'))).toEqual(index)
})
