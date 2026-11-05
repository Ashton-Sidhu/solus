import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import { SOLUS_WORKTREE_DIR, type GitCheckout } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync }))

type WorktreeManager = typeof import('@solus/server/git/worktree-manager')
let recreateMissingWorktree: WorktreeManager['recreateMissingWorktree']
beforeAll(async () => {
  ;({ recreateMissingWorktree } = await import('@solus/server/git/worktree-manager'))
})

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

actAsHostForTests()

async function projectWithWorktree() {
  const directory = mkdtempSync(join(tmpdir(), 'solus-worktree-recreate-'))
  directories.push(directory)
  git(directory, ['init', '-b', 'main'])
  git(directory, ['config', 'user.name', 'Test'])
  git(directory, ['config', 'user.email', 'test@example.invalid'])
  git(directory, ['commit', '--allow-empty', '-m', 'Initial'])
  const branch = 'solus/test-branch'
  const worktreePath = join(directory, SOLUS_WORKTREE_DIR, 'test')
  git(directory, ['worktree', 'add', '-b', branch, worktreePath, 'main'])
  const checkout: GitCheckout = { repoRoot: directory, branch, targetBranch: 'main', worktreePath }
  return { directory, checkout, worktreePath, branch }
}

// A person who deletes a session's worktree folder must not lose the session:
// its next turn needs the folder back, with the work the branch still holds.
test('a deleted worktree comes back on its branch, with the branch commits', async () => {
  const { directory, checkout, worktreePath, branch } = await projectWithWorktree()
  git(worktreePath, ['commit', '--allow-empty', '-m', 'Agent work'])
  const agentCommit = git(worktreePath, ['rev-parse', 'HEAD'])
  rmSync(worktreePath, { recursive: true, force: true })

  await recreateMissingWorktree(checkout)

  expect(existsSync(worktreePath)).toBe(true)
  expect(git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branch)
  expect(git(worktreePath, ['rev-parse', 'HEAD'])).toBe(agentCommit)
  expect(git(directory, ['worktree', 'list'])).toContain(worktreePath)
})

test('a deleted worktree and branch come back from the project folder branch', async () => {
  const { directory, checkout, worktreePath, branch } = await projectWithWorktree()
  rmSync(worktreePath, { recursive: true, force: true })
  git(directory, ['worktree', 'prune'])
  git(directory, ['branch', '-D', branch])
  git(directory, ['commit', '--allow-empty', '-m', 'Newer main'])

  await recreateMissingWorktree(checkout)

  expect(git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branch)
  expect(git(worktreePath, ['rev-parse', 'HEAD'])).toBe(git(directory, ['rev-parse', 'main']))
})

function addOrigin(directory: string): string {
  const origin = mkdtempSync(join(tmpdir(), 'solus-worktree-recreate-origin-'))
  directories.push(origin)
  git(origin, ['init', '--bare', '-b', 'main'])
  git(directory, ['remote', 'add', 'origin', origin])
  git(directory, ['push', 'origin', 'main'])
  git(directory, ['remote', 'set-head', 'origin', 'main'])
  return origin
}

// A branch the agent pushed holds the session's work even after the local
// branch is deleted; rebuilding from the project branch would lose it.
test('a deleted branch that was pushed comes back from its origin tip and tracks it', async () => {
  const { directory, checkout, worktreePath, branch } = await projectWithWorktree()
  addOrigin(directory)
  git(worktreePath, ['commit', '--allow-empty', '-m', 'Pushed agent work'])
  const pushedCommit = git(worktreePath, ['rev-parse', 'HEAD'])
  git(worktreePath, ['push', 'origin', branch])
  rmSync(worktreePath, { recursive: true, force: true })
  git(directory, ['worktree', 'prune'])
  git(directory, ['branch', '-D', branch])
  git(directory, ['commit', '--allow-empty', '-m', 'Newer main'])
  // A tag with the remote ref's short name must not be chosen instead.
  git(directory, ['tag', `origin/${branch}`, 'main'])

  await recreateMissingWorktree(checkout)

  expect(git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branch)
  expect(git(worktreePath, ['rev-parse', 'HEAD'])).toBe(pushedCommit)
  expect(git(worktreePath, ['rev-parse', '--symbolic-full-name', '@{upstream}'])).toBe(`refs/remotes/origin/${branch}`)
})

test('on a detached project folder, a deleted branch comes back from the remote default branch', async () => {
  const { directory, checkout, worktreePath, branch } = await projectWithWorktree()
  addOrigin(directory)
  const remoteDefault = git(directory, ['rev-parse', 'origin/main'])
  rmSync(worktreePath, { recursive: true, force: true })
  git(directory, ['worktree', 'prune'])
  git(directory, ['branch', '-D', branch])
  git(directory, ['commit', '--allow-empty', '-m', 'Unpushed main'])
  git(directory, ['checkout', '--detach'])

  await recreateMissingWorktree(checkout)

  expect(git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branch)
  expect(git(worktreePath, ['rev-parse', 'HEAD'])).toBe(remoteDefault)
  expect(spawnSync('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd: worktreePath }).status).not.toBe(0)
})

test('on a detached project folder with no remote, a deleted branch comes back from HEAD', async () => {
  const { directory, checkout, worktreePath, branch } = await projectWithWorktree()
  rmSync(worktreePath, { recursive: true, force: true })
  git(directory, ['worktree', 'prune'])
  git(directory, ['branch', '-D', branch])
  git(directory, ['commit', '--allow-empty', '-m', 'Newer main'])
  git(directory, ['checkout', '--detach'])

  await recreateMissingWorktree(checkout)

  expect(git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branch)
  expect(git(worktreePath, ['rev-parse', 'HEAD'])).toBe(git(directory, ['rev-parse', 'HEAD']))
})

test('a folder outside Solus worktrees is never made again', async () => {
  const { directory, branch } = await projectWithWorktree()
  const elsewhere = join(directory, 'not-a-solus-worktree')

  await expect(recreateMissingWorktree({ repoRoot: directory, branch, targetBranch: 'main', worktreePath: elsewhere }))
    .rejects.toThrow('start a new session')
  expect(existsSync(elsewhere)).toBe(false)
})
