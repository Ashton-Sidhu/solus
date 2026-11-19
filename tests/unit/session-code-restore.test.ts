import { afterEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { beginTurnCheckpoint, endTurnCheckpoint } = await import('@solus/server/git/turn-checkpoints')
const { getDiff, getSessionBaseSha, listTurnSnapshots, snapshotLiveTree } = await import('@solus/server/git/session-snapshots')
const { writeTurnCodeBundle } = await import('@solus/server/git/session-code-bundle')
const { CodeRestoreError, restoreSessionCode } = await import('@solus/server/git/session-code-restore')
const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')

actAsHostForTests()
const dirs: string[] = []
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0 })
function dir(name: string): string { const path = mkdtempSync(join(tmpdir(), `solus-code-restore-${name}-`)); dirs.push(path); return path }
function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}
function project() {
  const origin = dir('origin'); git(origin, ['init', '--bare', '--initial-branch=main'])
  const hostA = dir('a'); git(hostA, ['clone', origin, '.'])
  git(hostA, ['config', 'user.name', 'Test']); git(hostA, ['config', 'user.email', 'test@example.com'])
  writeFileSync(join(hostA, 'base.txt'), 'base\n'); git(hostA, ['add', '.']); git(hostA, ['commit', '-m', 'base']); git(hostA, ['push', 'origin', 'HEAD:main'])
  const hostB = dir('b'); git(hostB, ['clone', origin, '.'])
  const workA = join(dir('work'), 'session'); git(hostA, ['worktree', 'add', '-b', 'session-branch', workA, 'HEAD'])
  return { origin, hostA, hostB, workA }
}
const sessionId = 'portable-test'
async function turn(hostA: string, workA: string, index: number, carried: string[] = []) {
  await beginTurnCheckpoint({ sessionId, workTree: workA })
  writeFileSync(join(workA, `turn-${index}.txt`), `turn ${index}\n`)
  await endTurnCheckpoint({ sessionId, workTree: workA }, { userMessagePreview: `turn ${index}` })
  const snapshots = await listTurnSnapshots(hostA, sessionId)
  const bundleFile = join(dir('bundle'), `${index}.bundle`)
  const bundle = await writeTurnCodeBundle(hostA, {
    sessionId, snapshots: [snapshots[index]], previousCommit: index ? snapshots[index - 1].sha : getSessionBaseSha(hostA, sessionId)!,
    headSha: git(workA, ['rev-parse', 'HEAD']), carried,
  }, bundleFile)
  expect(bundle.kind).toBe('written')
  return { snapshots, bundleFile }
}
function input(hostB: string, hostA: string, workA: string, snapshots: Awaited<ReturnType<typeof listTurnSnapshots>>, bundleFiles: string[]) {
  return { projectRoot: hostB, sessionId, bundleFiles, baseSha: getSessionBaseSha(hostA, sessionId)!, snapshots,
    branch: 'session-branch', headSha: git(workA, ['rev-parse', 'HEAD']), ownsWorktree: true, sessionPaths: snapshots.map(s => `turn-${s.index}.txt`) }
}

describe('portable session code restore', () => {
  // WHY: a turn must show the same changed files and turn diff on either host.
  test('restores the exact tree and snapshot readers', async () => {
    const { hostA, hostB, workA } = project()
    const { snapshots, bundleFile } = await turn(hostA, workA, 0)
    const restored = await restoreSessionCode(input(hostB, hostA, workA, snapshots, [bundleFile]))
    expect(restored.treeSha).toBe(snapshots[0].toTreeSha)
    expect(await snapshotLiveTree(restored.worktreePath, hostB)).toBe(snapshots[0].toTreeSha)
    expect(git(restored.worktreePath, ['status', '--short'])).toBe(git(workA, ['status', '--short']))
    expect(await listTurnSnapshots(hostB, sessionId)).toEqual(snapshots)
    const scope = { kind: 'turn' as const, index: 0 }
    const sourceDiff = await getDiff(workA, hostA, scope, sessionId)
    expect(sourceDiff?.patch).toContain('turn 0')
    expect(await getDiff(restored.worktreePath, hostB, scope, sessionId)).toEqual(sourceDiff)
  })

  // WHY: a local commit must travel with the turn even when origin has not seen it.
  test('fetches an unpushed branch commit', async () => {
    const { hostA, hostB, workA } = project()
    writeFileSync(join(workA, 'base.txt'), 'committed on A\n'); git(workA, ['commit', '-am', 'local'])
    const { snapshots, bundleFile } = await turn(hostA, workA, 0)
    const restored = await restoreSessionCode(input(hostB, hostA, workA, snapshots, [bundleFile]))
    expect(git(restored.worktreePath, ['rev-parse', 'HEAD'])).toBe(git(workA, ['rev-parse', 'HEAD']))
    expect(readFileSync(join(restored.worktreePath, 'base.txt'), 'utf8')).toBe('committed on A\n')
  })

  // WHY: the next sync must keep the safe checkout and transfer only new objects.
  test('reuses a checked worktree and skips bundles already present', async () => {
    const { hostA, hostB, workA } = project()
    const first = await turn(hostA, workA, 0)
    const original = await restoreSessionCode(input(hostB, hostA, workA, first.snapshots, [first.bundleFile]))
    const second = await turn(hostA, workA, 1, [first.snapshots[0].sha])
    const restored = await restoreSessionCode({ ...input(hostB, hostA, workA, second.snapshots, [first.bundleFile, second.bundleFile]),
      previousWorktree: { path: original.worktreePath, treeSha: original.treeSha } })
    expect(restored.worktreePath).toBe(original.worktreePath)
    expect(restored.reusedWorktree).toBe(true)
    expect(restored.fetchedBundles).toBe(1)
    expect(restored.treeSha).toBe(second.snapshots[1].toTreeSha)
  })

  // WHY: a person's edits in the old checkout must stay intact.
  test('keeps a changed checkout and makes another worktree', async () => {
    const { hostA, hostB, workA } = project()
    const first = await turn(hostA, workA, 0)
    const original = await restoreSessionCode(input(hostB, hostA, workA, first.snapshots, [first.bundleFile]))
    writeFileSync(join(original.worktreePath, 'person.txt'), 'keep me\n')
    const second = await turn(hostA, workA, 1, [first.snapshots[0].sha])
    const restored = await restoreSessionCode({ ...input(hostB, hostA, workA, second.snapshots, [first.bundleFile, second.bundleFile]),
      previousWorktree: { path: original.worktreePath, treeSha: original.treeSha } })
    expect(restored.worktreePath).not.toBe(original.worktreePath)
    expect(readFileSync(join(original.worktreePath, 'person.txt'), 'utf8')).toBe('keep me\n')
    expect(restored.treeSha).toBe(second.snapshots[1].toTreeSha)
  })

  // WHY: another author's file in a shared checkout must not travel with the session.
  test('restores only the session paths from a shared checkout', async () => {
    const { hostA, hostB } = project()
    await beginTurnCheckpoint({ sessionId, workTree: hostA })
    writeFileSync(join(hostA, 'mine.txt'), 'mine\n')
    writeFileSync(join(hostA, 'other.txt'), 'other\n')
    await endTurnCheckpoint({ sessionId, workTree: hostA }, { userMessagePreview: 'shared' })
    const snapshots = await listTurnSnapshots(hostA, sessionId)
    const bundleFile = join(dir('bundle'), 'shared.bundle')
    await writeTurnCodeBundle(hostA, { sessionId, snapshots, previousCommit: getSessionBaseSha(hostA, sessionId)!, headSha: git(hostA, ['rev-parse', 'HEAD']), carried: [] }, bundleFile)
    const restored = await restoreSessionCode({ projectRoot: hostB, sessionId, bundleFiles: [bundleFile], baseSha: getSessionBaseSha(hostA, sessionId)!, snapshots,
      branch: 'main', headSha: git(hostA, ['rev-parse', 'HEAD']), ownsWorktree: false, sessionPaths: ['mine.txt'] })
    expect(existsSync(join(restored.worktreePath, 'mine.txt'))).toBe(true)
    expect(existsSync(join(restored.worktreePath, 'other.txt'))).toBe(false)
    expect(existsSync(join(hostB, 'mine.txt'))).toBe(false)
    expect(restored.checkout.branch).toBe(`solus/session-${sessionId}`)
  })

  // WHY: a missing base must stop setup before any worktree is made.
  test('reports a missing bundle prerequisite without a worktree', async () => {
    const { hostA, hostB, workA } = project()
    writeFileSync(join(workA, 'base.txt'), 'local\n'); git(workA, ['commit', '-am', 'local'])
    const { snapshots, bundleFile } = await turn(hostA, workA, 0)
    const empty = dir('empty'); git(empty, ['init'])
    await expect(restoreSessionCode(input(empty, hostA, workA, snapshots, [bundleFile]))).rejects.toMatchObject({ code: 'missing-prerequisite' })
    expect(git(empty, ['worktree', 'list', '--porcelain']).split('worktree ').length).toBe(2)
    expect(existsSync(hostB)).toBe(true)
  })

  // WHY: a stopped setup must not make a worktree.
  test('honors an aborted signal', async () => {
    const { hostA, hostB, workA } = project()
    const { snapshots, bundleFile } = await turn(hostA, workA, 0)
    const controller = new AbortController(); controller.abort()
    await expect(restoreSessionCode({ ...input(hostB, hostA, workA, snapshots, [bundleFile]), signal: controller.signal })).rejects.toThrow()
    expect(git(hostB, ['worktree', 'list', '--porcelain']).split('worktree ').length).toBe(2)
    expect(CodeRestoreError).toBeDefined()
  })

  // WHY: a changed tree after apply must not become a runnable session checkout.
  test('removes a new worktree when the tree check fails', async () => {
    const { hostA, hostB, workA } = project()
    const { snapshots, bundleFile } = await turn(hostA, workA, 0)
    await expect(restoreSessionCode({ ...input(hostB, hostA, workA, snapshots, [bundleFile]),
      onProgress: (step) => {
        if (step !== 'check') return
        const worktree = git(hostB, ['worktree', 'list', '--porcelain']).split('\n').find(line => line.includes('session-portable-test-'))?.slice(9)
        if (worktree) writeFileSync(join(worktree, 'interference.txt'), 'changed during check\n')
      },
    })).rejects.toMatchObject({ code: 'tree-mismatch' })
    expect(git(hostB, ['worktree', 'list', '--porcelain']).split('worktree ').length).toBe(2)
  })

  // WHY: an abort after checkout creation must remove that incomplete checkout.
  test('cleans up when stopped during restore', async () => {
    const { hostA, hostB, workA } = project()
    const { snapshots, bundleFile } = await turn(hostA, workA, 0)
    const controller = new AbortController()
    await expect(restoreSessionCode({ ...input(hostB, hostA, workA, snapshots, [bundleFile]), signal: controller.signal,
      onProgress: (step) => { if (step === 'restore') controller.abort() },
    })).rejects.toThrow()
    expect(git(hostB, ['worktree', 'list', '--porcelain']).split('worktree ').length).toBe(2)
  })
})
