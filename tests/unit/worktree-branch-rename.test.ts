import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let createWorktree: typeof import('@solus/server/git/worktree-manager')['createWorktree']
let renameWorktreeBranch: typeof import('@solus/server/git/worktree-manager')['renameWorktreeBranch']
beforeAll(async () => {
  // Branch naming reads host config. A disposable data dir keeps the live
  // ~/.solus settings out of this test.
  process.env.SOLUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'solus-worktree-rename-data-'))
  ;({ createWorktree, renameWorktreeBranch } = await import('@solus/server/git/worktree-manager'))
})
import { DEFAULT_WORKTREE_BRANCH_NAMING, generatedWorktreeBranchName, temporaryWorktreeBranchId } from '@solus/contracts/worktree-branch-naming'

const defaultNamer = { naming: DEFAULT_WORKTREE_BRANCH_NAMING, user: null }
const isTemporaryWorktreeBranch = (branch: string) => temporaryWorktreeBranchId(branch, defaultNamer) !== null
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
  expect(generatedWorktreeBranchName('???', defaultNamer, '0a1b2c3d')).toBeNull()
})

test('a project template without an id gets a suffix when its name is taken', async () => {
  // WHY: a custom or static name is not always unique. A taken name must not
  // fail worktree creation.
  const directory = repository()
  mkdirSync(join(directory, '.solus'))
  writeFileSync(join(directory, '.solus', 'config.json'), JSON.stringify({
    worktreeBranchNaming: { mode: 'custom', prefix: 'solus', template: '{prefix}/work' },
  }))
  git(['branch', 'solus/work'], directory)
  const checkout = await createWorktree(directory, 'main')
  expect(checkout.branch).toBe('solus/work-2')
})

test('a branch named like the prefix does not block worktree creation', async () => {
  // WHY: a ref is a file, so a local branch `solus` makes every `solus/<x>`
  // impossible. Creation must fall back to a flat name, and the rename from
  // the title must still treat that name as temporary.
  const directory = repository()
  git(['branch', 'solus'], directory)
  const checkout = await createWorktree(directory, 'main')
  expect(checkout.branch).toMatch(/^solus-[0-9a-f]{8}$/)
  expect(isTemporaryWorktreeBranch(checkout.branch!)).toBe(true)
  expect(await renameWorktreeBranch(checkout.worktreePath!, checkout.branch!, 'Stable Session Reconnect'))
    .toBe('solus-stable-session-reconnect')
})

test('a name that is a directory of other branches gets a suffix', async () => {
  // WHY: a branch `solus/work/old` makes `solus/work` a ref directory, and git
  // cannot create a branch there.
  const directory = repository()
  mkdirSync(join(directory, '.solus'))
  writeFileSync(join(directory, '.solus', 'config.json'), JSON.stringify({
    worktreeBranchNaming: { mode: 'custom', prefix: 'solus', template: '{prefix}/work' },
  }))
  git(['branch', 'solus/work/old'], directory)
  const checkout = await createWorktree(directory, 'main')
  expect(checkout.branch).toBe('solus/work-2')
})
