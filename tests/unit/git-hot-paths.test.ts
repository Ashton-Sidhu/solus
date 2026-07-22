import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeGitState, parseStatus } from '../../src/main/git/git-helpers'
import { getDiffStats, initSessionBase, parseChangedFileStats, snapshotTurn } from '../../src/main/git/session-snapshots'
import type { GitState } from '../../src/shared/types'

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
  test('resolves checkout and worktree intent as one session start target', async () => {
    const previousWindow = globalThis.window
    const previousState = (globalThis as unknown as { $state?: unknown }).$state
    const status: GitState = {
      repoRoot: '/repo',
      headSha: 'abc123',
      branch: 'main',
      targetBranch: 'main',
      uncommittedChanges: { files: [], hasMoreFiles: false, insertions: 0, deletions: 0, mergeInProgress: false },
    }

    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: { gitRefreshState: async () => status } },
    })

    try {
      const { SessionEnvironmentStore } = await import('../../src/renderer/contexts/session-environment.store.svelte')
      const store = new SessionEnvironmentStore()
      expect(await store.resolveSessionStartTarget('/repo', { worktreeRequested: true })).toEqual({
        workingDirectory: '/repo',
        gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' },
        worktreeBaseBranch: 'main',
      })
    } finally {
      if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
      else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
      if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
      else (globalThis as unknown as { $state: unknown }).$state = previousState
    }
  })

  test('routine status omits worktree statistics until details are requested', async () => {
    const { cwd } = createRepo()
    writeFileSync(join(cwd, 'tracked.txt'), 'first\nsecond\n')
    writeFileSync(join(cwd, 'new.txt'), 'new\n')

    const summaryRequest = computeGitState(cwd)
    expect(computeGitState(cwd)).toBe(summaryRequest)
    const summary = await summaryRequest
    expect(summary?.uncommittedChanges.files.map((file) => file.path).sort()).toEqual(['new.txt', 'tracked.txt'])
    expect(summary?.uncommittedChanges.insertions).toBe(0)
    expect(summary?.uncommittedChanges.deletions).toBe(0)

    const detailed = await computeGitState(cwd, { includeDetails: true })
    expect(detailed?.uncommittedChanges.insertions).toBe(2)
    expect(detailed?.uncommittedChanges.deletions).toBe(0)
  })

  test('reports when the changed-file list omits entries beyond its limit', () => {
    const statusLines = Array.from({ length: 201 }, (_, index) => `? file-${index}.txt`)

    expect(parseStatus(statusLines.slice(0, 200).join('\n')).hasMoreFiles).toBe(false)
    const truncated = parseStatus(statusLines.join('\n'))
    expect(truncated.files).toHaveLength(200)
    expect(truncated.hasMoreFiles).toBe(true)
  })

  test('a slow detail response cannot overwrite a newer summary', async () => {
    const previousWindow = globalThis.window
    const previousState = (globalThis as unknown as { $state?: unknown }).$state
    const summary = deferred<GitState | null>()
    const details = deferred<GitState | null>()
    const status = (file: string, insertions = 0): GitState => ({
      repoRoot: '/repo',
      headSha: 'abc123',
      branch: 'feature',
      targetBranch: 'main',
      uncommittedChanges: { files: [{ path: file, conflicted: false }], hasMoreFiles: false, insertions, deletions: 0, mergeInProgress: false },
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
          gitRefreshState: (_cwd: string, options?: { includeDetails?: boolean }) =>
            options?.includeDetails ? details.promise : summary.promise,
        },
      },
    })

    try {
    const { SessionEnvironmentStore } = await import('../../src/renderer/contexts/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
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
    const status: GitState = {
      repoRoot: '/repo',
      headSha: 'abc123',
      branch: 'feature',
      targetBranch: 'main',
      uncommittedChanges: { files: [{ path: 'changed.ts', conflicted: false }], hasMoreFiles: false, insertions: 1, deletions: 0, mergeInProgress: false },
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
          gitRefreshState: async () => {
            if (shouldFail) throw new Error('temporary probe failure')
            return status
          },
        },
      },
    })

    try {
    const { SessionEnvironmentStore } = await import('../../src/renderer/contexts/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
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
      sessionChangedFiles: ['tracked.txt', 'temporary.txt'],
    })
    expect(first?.sessionChangedFiles?.sort()).toEqual(['temporary.txt', 'tracked.txt'])

    writeFileSync(join(cwd, 'tracked.txt'), 'first\n')
    unlinkSync(join(cwd, 'temporary.txt'))
    const second = await snapshotTurn(cwd, cwd, 'session-1', {
      sessionChangedFiles: ['tracked.txt', 'temporary.txt'],
    })

    expect(second?.sessionChangedFiles).toEqual([])
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
