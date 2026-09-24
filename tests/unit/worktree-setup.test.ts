import { afterEach, expect, test, spyOn, mock, beforeAll } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let createWorktree: typeof import('@solus/server/git/worktree-manager')['createWorktree']
beforeAll(async () => { ({ createWorktree } = await import('@solus/server/git/worktree-manager')) })
import { worktreePathFor } from '@solus/server/git/worktree-path'
import { git } from '@solus/server/git/exec'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function repository(commit = true): string {
  const directory = mkdtempSync(join(tmpdir(), 'solus-worktree-setup-'))
  directories.push(directory)
  git(['init', '-b', 'main'], directory)
  git(['config', 'user.name', 'Test'], directory)
  git(['config', 'user.email', 'test@example.invalid'], directory)
  if (commit) git(['commit', '--allow-empty', '-m', 'Initial'], directory)
  return directory
}

test('an empty repository fails before a setup branch is created', async () => {
  const directory = repository(false)
  await expect(createWorktree(directory, 'main')).rejects.toThrow('has no commit')
  expect(git(['branch', '--list'], directory)).toBe('')
})

test('failed file preparation removes only the worktree and branch owned by the attempt', async () => {
  const directory = repository()
  git(['checkout', '-b', 'newer-base'], directory)
  git(['commit', '--allow-empty', '-m', 'Newer base'], directory)
  git(['checkout', 'main'], directory)
  git(['branch', 'keep-me'], directory)
  writeFileSync(join(directory, '.gitignore'), 'broken\n')
  writeFileSync(join(directory, '.worktreeinclude'), 'broken\n')
  symlinkSync('does-not-exist', join(directory, 'broken'))
  await expect(createWorktree(directory, 'newer-base')).rejects.toThrow()
  expect(git(['branch', '--format=%(refname:short)'], directory).split('\n')).toEqual(['keep-me', 'main', 'newer-base'])
  expect(git(['worktree', 'list', '--porcelain'], directory).match(/^worktree /gm)).toHaveLength(1)
})

test('successful preparation retains its checkout and cancellation creates nothing', async () => {
  const directory = repository()
  const controller = new AbortController()
  controller.abort(new Error('Interrupted'))
  await expect(createWorktree(directory, 'main', { signal: controller.signal })).rejects.toThrow('Interrupted')
  const checkout = await createWorktree(directory, 'main')
  expect(git(['branch', '--show-current'], checkout.worktreePath!)).toBe(checkout.branch)
  expect(git(['worktree', 'list', '--porcelain'], directory).match(/^worktree /gm)).toHaveLength(2)
})


test('a destination collision preserves existing files and removes only the reserved branch', async () => {
  const directory = repository()
  const destination = worktreePathFor(directory, 'solus-collision')
  mkdirSync(destination, { recursive: true })
  writeFileSync(join(destination, 'keep'), 'owned elsewhere')
  await expect(createWorktree(directory, 'main', { generatedName: 'collision' })).rejects.toThrow()
  expect(readFileSync(join(destination, 'keep'), 'utf8')).toBe('owned elsewhere')
  expect(git(['branch', '--format=%(refname:short)'], directory)).toBe('main')
})

test('a generated name another branch holds gets a suffix and leaves that branch alone', async () => {
  // WHY: two sessions can ask for the same work. The second one must get its
  // own branch, and the first one's branch must keep its commit.
  const directory = repository()
  git(['branch', 'solus/collision'], directory)
  const held = git(['rev-parse', 'solus/collision'], directory)
  const checkout = await createWorktree(directory, 'main', { generatedName: 'collision' })
  expect(checkout.branch).toBe('solus/collision-2')
  expect(git(['rev-parse', 'solus/collision'], directory)).toBe(held)
})


test('cancellation during file preparation removes the owned checkout and branch', async () => {
  const directory = repository()
  writeFileSync(join(directory, '.gitignore'), 'local-config\n')
  writeFileSync(join(directory, '.worktreeinclude'), 'local-config\n')
  writeFileSync(join(directory, 'local-config'), 'fixture')
  const controller = new AbortController()
  const copyFile = filesystem.copyFile
  const copy = spyOn(filesystem, 'copyFile').mockImplementation(async (...args) => {
    await copyFile(...args)
    controller.abort(new Error('Interrupted'))
  })
  try {
    await expect(createWorktree(directory, 'main', { signal: controller.signal })).rejects.toThrow('Interrupted')
    expect(copy).toHaveBeenCalledTimes(1)
    expect(git(['branch', '--format=%(refname:short)'], directory)).toBe('main')
    expect(git(['worktree', 'list', '--porcelain'], directory).match(/^worktree /gm)).toHaveLength(1)
  } finally {
    copy.mockRestore()
  }
})
