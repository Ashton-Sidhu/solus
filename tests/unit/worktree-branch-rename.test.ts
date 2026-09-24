import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let createWorktree: typeof import('@solus/server/git/worktree-manager')['createWorktree']
let renameWorktreeBranch: typeof import('@solus/server/git/worktree-manager')['renameWorktreeBranch']
beforeAll(async () => { ({ createWorktree, renameWorktreeBranch } = await import('@solus/server/git/worktree-manager')) })
import { generatedWorktreeBranchName, isTemporaryWorktreeBranch } from '@solus/server/git/worktree-branch-name'
import { git } from '@solus/server/git/exec'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'solus-worktree-rename-'))
  directories.push(directory)
  git(['init', '-b', 'main'], directory)
  git(['config', 'user.name', 'Test'], directory)
  git(['config', 'user.email', 'test@example.invalid'], directory)
  git(['commit', '--allow-empty', '-m', 'Initial'], directory)
  return directory
}

test('a worktree starts on a temporary branch without asking a model', async () => {
  // WHY: the first prompt in a new worktree must not wait on a naming model.
  const checkout = await createWorktree(repository(), 'main')
  expect(isTemporaryWorktreeBranch(checkout.branch!)).toBe(true)
  expect(git(['branch', '--show-current'], checkout.worktreePath!)).toBe(checkout.branch)
})

test('the generated name replaces the temporary branch in the worktree', async () => {
  const checkout = await createWorktree(repository(), 'main')
  const branch = await renameWorktreeBranch(checkout.worktreePath!, checkout.branch!, 'Stable Session Reconnect')
  expect(branch).toBe('solus/stable-session-reconnect')
  expect(git(['branch', '--show-current'], checkout.worktreePath!)).toBe('solus/stable-session-reconnect')
  expect(git(['branch', '--list', checkout.branch!], checkout.worktreePath!)).toBe('')
})

test('a taken name gets a suffix instead of failing the rename', async () => {
  const directory = repository()
  git(['branch', 'solus/stable-session-reconnect'], directory)
  const checkout = await createWorktree(directory, 'main')
  expect(await renameWorktreeBranch(checkout.worktreePath!, checkout.branch!, 'Stable Session Reconnect'))
    .toBe('solus/stable-session-reconnect-2')
})

test('a branch the agent switched to is never renamed', async () => {
  // WHY: the rename runs beside the first turn. If the agent checked out its
  // own branch meanwhile, that choice wins.
  const checkout = await createWorktree(repository(), 'main')
  git(['checkout', '-b', 'agent/own-branch'], checkout.worktreePath!)
  expect(await renameWorktreeBranch(checkout.worktreePath!, checkout.branch!, 'Stable Session Reconnect')).toBeNull()
  expect(git(['branch', '--show-current'], checkout.worktreePath!)).toBe('agent/own-branch')
  expect(git(['branch', '--list', checkout.branch!], checkout.worktreePath!)).not.toBe('')
})

test('a pushed temporary branch keeps its name', async () => {
  // WHY: renaming a branch with an upstream leaves the remote branch behind
  // under the old name, and the next push would create a second one.
  const directory = repository()
  const checkout = await createWorktree(directory, 'main')
  git(['branch', `--set-upstream-to=main`], checkout.worktreePath!)
  expect(await renameWorktreeBranch(checkout.worktreePath!, checkout.branch!, 'Stable Session Reconnect')).toBeNull()
  expect(git(['branch', '--show-current'], checkout.worktreePath!)).toBe(checkout.branch)
})

test('only a temporary branch or a name with words is used', () => {
  expect(isTemporaryWorktreeBranch('solus/0a1b2c3d')).toBe(true)
  expect(isTemporaryWorktreeBranch('solus/stable-session-reconnect')).toBe(false)
  expect(isTemporaryWorktreeBranch('main')).toBe(false)
  expect(generatedWorktreeBranchName('???')).toBeNull()
})
