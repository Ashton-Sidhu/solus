import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: `git worktree add` runs the repository's post-checkout hook, and a large
// checkout or a slow hook (installing dependencies) takes minutes. The 60 s
// default deadline killed it and the new worktree was deleted (t3code #23802).
// The checkout has no deadline; Stop still ends it through its signal.
const childProcess = await import('node:child_process')
const realSpawn = childProcess.spawn
const realSpawnSync = childProcess.spawnSync
const checkoutTimeouts: Array<number | undefined> = []
const recordingChildProcess = () => ({
  ...childProcess,
  spawn: (...args: Parameters<typeof realSpawn>) => {
    const [, argv, options] = args as unknown as [string, string[], { timeout?: number } | undefined]
    if (argv?.includes('worktree') && argv.includes('add')) checkoutTimeouts.push(options?.timeout)
    return realSpawn(...args)
  },
})
mock.module('child_process', recordingChildProcess)
mock.module('node:child_process', recordingChildProcess)

let createWorktree: typeof import('@solus/server/git/worktree-manager')['createWorktree']
beforeAll(async () => {
  ;({ createWorktree } = await import('@solus/server/git/worktree-manager'))
})

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

actAsHostForTests()

function repository(hook?: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'solus-worktree-deadline-'))
  directories.push(directory)
  const git = (...args: string[]) => {
    const result = realSpawnSync('git', args, { cwd: directory, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  git('init', '-q', '-b', 'main')
  git('-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-q', '--allow-empty', '-m', 'Initial')
  if (hook) {
    const path = join(directory, '.git', 'hooks', 'post-checkout')
    writeFileSync(path, `#!/bin/sh\n${hook}\n`)
    chmodSync(path, 0o755)
  }
  return directory
}

test('the worktree checkout runs with no deadline', async () => {
  checkoutTimeouts.length = 0
  const created = await createWorktree(repository(), 'main')
  expect(existsSync(created.worktreePath!)).toBe(true)
  expect(checkoutTimeouts).toEqual([0])
})

test('Stop still ends a checkout whose hook is slow', async () => {
  const controller = new AbortController()
  const startedAt = Date.now()
  const creating = createWorktree(repository('sleep 30'), 'main', { signal: controller.signal })
  setTimeout(() => controller.abort(new Error('Interrupted')), 500)
  await expect(creating).rejects.toThrow()
  expect(Date.now() - startedAt).toBeLessThan(10_000)
}, 20_000)
