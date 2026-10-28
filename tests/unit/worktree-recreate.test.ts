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

test('with no branch to start from, the error names the cause, not git output', async () => {
  const { directory, checkout, worktreePath, branch } = await projectWithWorktree()
  rmSync(worktreePath, { recursive: true, force: true })
  git(directory, ['worktree', 'prune'])
  git(directory, ['branch', '-D', branch])
  git(directory, ['checkout', '--detach'])

  await expect(recreateMissingWorktree(checkout)).rejects.toThrow(`Could not recreate branch '${branch}'`)
  expect(existsSync(worktreePath)).toBe(false)
})

test('a folder outside Solus worktrees is never made again', async () => {
  const { directory, branch } = await projectWithWorktree()
  const elsewhere = join(directory, 'not-a-solus-worktree')

  await expect(recreateMissingWorktree({ repoRoot: directory, branch, targetBranch: 'main', worktreePath: elsewhere }))
    .rejects.toThrow('start a new session')
  expect(existsSync(elsewhere)).toBe(false)
})
