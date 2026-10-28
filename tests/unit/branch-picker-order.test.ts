import { afterEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BranchRef } from '@solus/contracts/types'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import { BRANCH_ROWS_SHOWN, branchesMatching, newBranchFromSearch, pickerBranches } from '@solus/workspace-ui/lib/git-context'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { listBranchRefs } = await import('@solus/server/git/worktree-manager')

const temporaryDirectories: string[] = []

/** Run git as if on `day` of January 2025, so commits and reflog entries carry that time. */
function gitOn(day: number, cwd: string, args: string[]): string {
  const date = `2025-01-${String(day).padStart(2, '0')}T00:00:00Z`
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim()
}

function commitOn(day: number, cwd: string, message: string): void {
  writeFileSync(join(cwd, 'file.txt'), `${message}\n`)
  gitOn(day, cwd, ['add', 'file.txt'])
  gitOn(day, cwd, ['commit', '-m', message])
}

const dayMs = (day: number) => Date.UTC(2025, 0, day)

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

actAsHostForTests()

describe('branch picker order', () => {
  test('lists the most recently active branch first, a checkout counting as activity', async () => {
    // WHY: alphabetical order put backup and chore branches first in a repo
    // with a hundred branches. The branch a person works on, or just looked
    // at, must be near the top.
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'solus-branch-order-')))
    temporaryDirectories.push(fixture)
    const repo = join(fixture, 'repo')
    const remote = join(fixture, 'remote.git')
    gitOn(1, fixture, ['init', '--initial-branch=main', repo])
    gitOn(1, fixture, ['init', '--bare', '--initial-branch=main', remote])
    gitOn(1, repo, ['config', 'user.name', 'Solus Test'])
    gitOn(1, repo, ['config', 'user.email', 'solus@example.com'])
    gitOn(1, repo, ['remote', 'add', 'origin', remote])
    commitOn(1, repo, 'base')

    gitOn(2, repo, ['checkout', '-b', 'old-feature'])
    commitOn(2, repo, 'old feature')
    gitOn(2, repo, ['checkout', 'main'])

    gitOn(3, repo, ['checkout', '-b', 'remote-only'])
    commitOn(3, repo, 'remote only')
    gitOn(3, repo, ['push', 'origin', 'remote-only'])
    gitOn(3, repo, ['checkout', 'main'])
    gitOn(3, repo, ['branch', '-D', 'remote-only'])

    gitOn(4, repo, ['checkout', '-b', 'visited'])
    commitOn(4, repo, 'visited')
    gitOn(4, repo, ['checkout', 'main'])

    commitOn(5, repo, 'main moves on')
    gitOn(5, repo, ['push', 'origin', 'main', 'old-feature'])
    gitOn(5, repo, ['remote', 'set-head', 'origin', 'main'])

    // Its last commit is older than main's, but the checkout is newer.
    gitOn(6, repo, ['checkout', 'visited'])

    expect(await listBranchRefs(repo)).toEqual([
      { name: 'visited', activeAt: dayMs(6), remoteOnly: false, isDefault: false },
      { name: 'main', activeAt: dayMs(5), remoteOnly: false, isDefault: true },
      { name: 'remote-only', activeAt: dayMs(3), remoteOnly: true, isDefault: false },
      { name: 'old-feature', activeAt: dayMs(2), remoteOnly: false, isDefault: false },
    ])
    expect((await listBranchRefs(repo, { remoteOnly: true })).map((ref) => ref.name))
      .toEqual(['main', 'remote-only', 'old-feature'])
  })

  test('lists the default branch first among the rest', () => {
    // WHY: the default branch is the usual place to start, however long ago
    // it last moved.
    const ref = (name: string, activeAt: number, isDefault = false): BranchRef =>
      ({ name, activeAt, remoteOnly: false, isDefault })
    const branches = [ref('current', 4), ref('recent', 3), ref('older', 2), ref('main', 1, true)]

    expect(pickerBranches(branches, new Set(['current'])).map((branch) => branch.name))
      .toEqual(['main', 'recent', 'older'])
  })

  test('mounts a bounded number of rows and still finds an old branch by search', () => {
    // WHY: a large repository has tens of thousands of branches. Mounting a
    // row for each one stalled the menu, but the oldest branch must still be
    // one search away.
    const branches: BranchRef[] = Array.from({ length: 50_000 }, (_, index) =>
      ({ name: `team/feature-${index}`, activeAt: 50_000 - index, remoteOnly: true, isDefault: false }))

    const shown = branchesMatching(branches, '', BRANCH_ROWS_SHOWN)
    expect(shown).toHaveLength(BRANCH_ROWS_SHOWN)
    expect(shown[0].name).toBe('team/feature-0')
    expect(branchesMatching(branches, 'Feature-49999', BRANCH_ROWS_SHOWN).map((branch) => branch.name))
      .toEqual(['team/feature-49999'])
    expect(branchesMatching(branches, 'team 4999', BRANCH_ROWS_SHOWN)[0].name).toBe('team/feature-4999')
  })

  test('offers to create a branch only for a search that could be one and is not one', () => {
    // WHY: a create row for an existing branch would fail, and a search with
    // spaces is a search, not a branch name.
    const existing = ['main', 'feature/login']
    expect(newBranchFromSearch('  feature/signup ', existing)).toBe('feature/signup')
    expect(newBranchFromSearch('feature/login', existing)).toBeNull()
    expect(newBranchFromSearch('fix login', existing)).toBeNull()
    expect(newBranchFromSearch('   ', existing)).toBeNull()
  })
})
