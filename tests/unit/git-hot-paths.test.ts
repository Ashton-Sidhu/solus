import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeGitProjectStatus } from '../../src/main/git/git-helpers'
import { getDiffStats, initSessionBase, parseChangedFileStats, snapshotTurn } from '../../src/main/git/session-snapshots'
import type { GitProjectStatus } from '../../src/shared/types'

let repos: string[] = []

afterEach(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true })
  repos = []
})

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function createRepo(): { cwd: string; baseSha: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'solus-git-hot-path-'))
  repos.push(cwd)
  git(cwd, ['init', '-b', 'main'])
  git(cwd, ['config', 'user.email', 'test@solus.local'])
  git(cwd, ['config', 'user.name', 'Solus Test'])
  writeFileSync(join(cwd, 'tracked.txt'), 'first\n')
  git(cwd, ['add', 'tracked.txt'])
  git(cwd, ['commit', '-m', 'base'])
  return { cwd, baseSha: git(cwd, ['rev-parse', 'HEAD']) }
}

describe('git status hot path', () => {
  test('routine status omits worktree statistics until details are requested', async () => {
    const { cwd } = createRepo()
    writeFileSync(join(cwd, 'tracked.txt'), 'first\nsecond\n')
    writeFileSync(join(cwd, 'new.txt'), 'new\n')

    const summaryRequest = computeGitProjectStatus(cwd)
    expect(computeGitProjectStatus(cwd)).toBe(summaryRequest)
    const summary = await summaryRequest
    expect(summary?.files.map((file) => file.path).sort()).toEqual(['new.txt', 'tracked.txt'])
    expect(summary?.insertions).toBe(0)
    expect(summary?.deletions).toBe(0)

    const detailed = await computeGitProjectStatus(cwd, { includeDetails: true })
    expect(detailed?.insertions).toBe(2)
    expect(detailed?.deletions).toBe(0)
  })

  test('a slow detail response cannot overwrite a newer summary', async () => {
    const previousWindow = globalThis.window
    const previousState = (globalThis as unknown as { $state?: unknown }).$state
    const summary = deferred<GitProjectStatus | null>()
    const details = deferred<GitProjectStatus | null>()
    const status = (file: string, insertions = 0): GitProjectStatus => ({
      repoRoot: '/repo',
      branch: 'feature',
      targetBranch: 'main',
      files: [{ path: file, conflicted: false }],
      insertions,
      deletions: 0,
      mergeInProgress: false,
    })

    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          gitProjectStatus: (_cwd: string, options?: { includeDetails?: boolean }) =>
            options?.includeDetails ? details.promise : summary.promise,
        },
      },
    })

    try {
      const { GitStatusStore } = await import('../../src/renderer/contexts/git-status.store.svelte')
      const store = new GitStatusStore()
      const detailsRequest = store.refresh('/repo', { force: true, details: true })
      const summaryRequest = store.refresh('/repo', { force: true })

      summary.resolve(status('newer.ts'))
      await summaryRequest
      details.resolve({ ...status('older.ts', 7), prUrl: 'https://example.test/pr/1' })
      await detailsRequest

      expect(store.statusFor('/repo')).toEqual({
        ...status('newer.ts', 7),
        prUrl: 'https://example.test/pr/1',
      })
    } finally {
      if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
      else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
      if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
      else (globalThis as unknown as { $state: unknown }).$state = previousState
    }
  })

  test('a failed summary refresh preserves the last known repository status', async () => {
    const previousWindow = globalThis.window
    const previousState = (globalThis as unknown as { $state?: unknown }).$state
    const status: GitProjectStatus = {
      repoRoot: '/repo',
      branch: 'feature',
      targetBranch: 'main',
      files: [{ path: 'changed.ts', conflicted: false }],
      insertions: 1,
      deletions: 0,
      mergeInProgress: false,
    }
    let shouldFail = false

    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          gitProjectStatus: async () => {
            if (shouldFail) throw new Error('temporary probe failure')
            return status
          },
        },
      },
    })

    try {
      const { GitStatusStore } = await import('../../src/renderer/contexts/git-status.store.svelte')
      const store = new GitStatusStore()
      expect(await store.refresh('/repo', { force: true })).toBe(true)
      shouldFail = true
      expect(await store.refresh('/repo', { force: true })).toBe(false)
      expect(store.statusFor('/repo')).toBe(status)
    } finally {
      if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
      else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
      if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
      else (globalThis as unknown as { $state: unknown }).$state = previousState
    }
  })
})

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('diff statistics hot path', () => {
  test('snapshot completion reports only paths with a net session change', async () => {
    const { cwd, baseSha } = createRepo()
    await initSessionBase(cwd, 'session-1', baseSha)
    writeFileSync(join(cwd, 'tracked.txt'), 'first\nsecond\n')
    writeFileSync(join(cwd, 'temporary.txt'), 'temporary\n')

    const first = await snapshotTurn(cwd, cwd, 'session-1', {
      changedFiles: ['tracked.txt', 'temporary.txt'],
    })
    expect(first?.changedFiles?.sort()).toEqual(['temporary.txt', 'tracked.txt'])

    writeFileSync(join(cwd, 'tracked.txt'), 'first\n')
    unlinkSync(join(cwd, 'temporary.txt'))
    const second = await snapshotTurn(cwd, cwd, 'session-1', {
      changedFiles: ['tracked.txt', 'temporary.txt'],
    })

    expect(second?.changedFiles).toEqual([])
  })

  test('returns session-scoped live stats without materializing a patch', async () => {
    const { cwd, baseSha } = createRepo()
    await initSessionBase(cwd, 'session-1', baseSha)
    writeFileSync(join(cwd, 'tracked.txt'), 'first\nsecond\n')
    writeFileSync(join(cwd, 'new.txt'), 'alpha\nbeta\n')
    writeFileSync(join(cwd, 'not-this-session.txt'), 'excluded\n')

    const stats = await getDiffStats(
      cwd,
      cwd,
      { kind: 'session' },
      'session-1',
      ['tracked.txt', 'new.txt'],
    )

    expect(stats.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'new.txt', additions: 2, deletions: 0 },
      { path: 'tracked.txt', additions: 1, deletions: 0 },
    ])
  })

  test('normalizes rename and binary numstat rows', () => {
    expect(parseChangedFileStats('3\t1\tsrc/{old => new}.ts\n-\t-\timage.png')).toEqual([
      { path: 'src/new.ts', additions: 3, deletions: 1 },
      { path: 'image.png', additions: 0, deletions: 0 },
    ])
  })
})
