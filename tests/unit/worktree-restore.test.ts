import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// A restored workspace restores one worktree per tab, on the boot path the
// first transcript page shares. Count synchronous spawns at the module
// boundary: one here is one event-loop stall per restored tab.
const childProcess = await import('node:child_process')
const realExecFileSync = childProcess.execFileSync
const realSpawnSync = childProcess.spawnSync
let syncSpawns = 0
const countedChildProcess = () => ({
  ...childProcess,
  execFileSync: (...args: Parameters<typeof realExecFileSync>) => { syncSpawns += 1; return realExecFileSync(...args) },
  spawnSync: (...args: Parameters<typeof realSpawnSync>) => { syncSpawns += 1; return realSpawnSync(...args) },
})
mock.module('child_process', countedChildProcess)
mock.module('node:child_process', countedChildProcess)

type WorktreeManager = typeof import('@solus/server/git/worktree-manager')
let createWorktree: WorktreeManager['createWorktree']
let restoreWorktree: WorktreeManager['restoreWorktree']
beforeAll(async () => {
  ;({ createWorktree, restoreWorktree } = await import('@solus/server/git/worktree-manager'))
})

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function git(cwd: string, args: string[]): string {
  const result = realSpawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

test('restoring a worktree answers its checkout without a synchronous spawn', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'solus-worktree-restore-'))
  directories.push(directory)
  git(directory, ['init', '-b', 'main'])
  git(directory, ['config', 'user.name', 'Test'])
  git(directory, ['config', 'user.email', 'test@example.invalid'])
  git(directory, ['commit', '--allow-empty', '-m', 'Initial'])
  const created = await createWorktree(directory, 'main')

  syncSpawns = 0
  const restored = await restoreWorktree(created.worktreePath!)

  expect(restored).toEqual({
    branch: created.branch,
    targetBranch: 'main',
    worktreePath: created.worktreePath,
    repoRoot: directory,
  })
  expect(syncSpawns).toBe(0)
})
