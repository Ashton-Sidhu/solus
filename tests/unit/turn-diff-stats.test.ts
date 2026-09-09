import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getDiffStats,
  initSessionBase,
  prepareTurnSnapshot,
  snapshotTurn,
} from '@solus/server/git/session-snapshots'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function createRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'solus-turn-diff-'))
  dirs.push(cwd)
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test'])
  writeFileSync(join(cwd, 'tracked.txt'), 'first\n')
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', 'base'])
  return { cwd, baseSha: git(cwd, ['rev-parse', 'HEAD']) }
}

function addWorkTree(repoRoot: string) {
  const workTree = join(mkdtempSync(join(tmpdir(), 'solus-turn-wt-')), 'checkout')
  dirs.push(workTree)
  git(repoRoot, ['worktree', 'add', '-b', 'feature', workTree])
  return workTree
}

describe('turn diff stats', () => {
  test('exclude edits that were already present when the turn started', async () => {
    const { cwd, baseSha } = createRepo()
    await initSessionBase(cwd, 'session-1', baseSha)
    writeFileSync(join(cwd, 'tracked.txt'), 'first\npre-existing\n')
    await prepareTurnSnapshot(cwd, cwd, 'session-1')

    writeFileSync(join(cwd, 'tracked.txt'), 'first\npre-existing\nthis turn\n')
    const result = await snapshotTurn(cwd, cwd, 'session-1', {
      sessionChangedFiles: ['tracked.txt'],
    })

    expect(result?.snapshot).toMatchObject({ filesChanged: 1, additions: 1, deletions: 0 })
    expect(await getDiffStats(cwd, cwd, { kind: 'turn', index: 0 }, 'session-1', [])).toEqual([
      { path: 'tracked.txt', additions: 1, deletions: 0, status: 'M' },
    ])
  })

  // WHY: several sessions and the developer can run against the same checkout at
  // once. A whole-worktree end snapshot reported whatever they wrote while this
  // turn ran as this turn's own work, which made the card useless on a shared
  // branch. The turn range is the session's paths, exactly like the session scope.
  test('a shared checkout excludes another author’s edit made during the turn', async () => {
    const { cwd, baseSha } = createRepo()
    await initSessionBase(cwd, 'session-1', baseSha)
    await prepareTurnSnapshot(cwd, cwd, 'session-1')

    writeFileSync(join(cwd, 'tracked.txt'), 'first\nfrom this session\n')
    writeFileSync(join(cwd, 'someone-else.txt'), 'another session was here\n')
    const result = await snapshotTurn(cwd, cwd, 'session-1', {
      sessionChangedFiles: ['tracked.txt'],
    })

    expect(result?.snapshot).toMatchObject({ filesChanged: 1 })
    expect(await getDiffStats(cwd, cwd, { kind: 'turn', index: 0 }, 'session-1', [])).toEqual([
      { path: 'tracked.txt', additions: 1, deletions: 0, status: 'M' },
    ])
  })

  // WHY: in its own worktree the session owns every change, so scoping to
  // harvested tool paths can only hide the session's own work — a shell `rm`, a
  // subagent, a write that never produced an Edit/Write message. Both ends stay
  // whole-worktree snapshots there.
  test('report a deletion no tool call announced in the session’s own worktree', async () => {
    const { cwd, baseSha } = createRepo()
    await initSessionBase(cwd, 'session-1', baseSha)
    const workTree = addWorkTree(cwd)
    await prepareTurnSnapshot(workTree, cwd, 'session-1')

    rmSync(join(workTree, 'tracked.txt'))
    const result = await snapshotTurn(workTree, cwd, 'session-1', { sessionChangedFiles: [] })

    expect(result?.snapshot).toMatchObject({ filesChanged: 1, additions: 0, deletions: 1 })
    expect(await getDiffStats(workTree, cwd, { kind: 'turn', index: 0 }, 'session-1', [])).toEqual([
      { path: 'tracked.txt', additions: 0, deletions: 1, status: 'D' },
    ])
  })

  // WHY: a snapshot built on the turn-start tree keeps the pre-turn blob for any
  // path it does not restage, so undoing an edit within the turn diffed to
  // nothing. Basing the end snapshot on HEAD is what makes the revert visible.
  test('report an edit reverted during the turn in the session’s own worktree', async () => {
    const { cwd, baseSha } = createRepo()
    await initSessionBase(cwd, 'session-1', baseSha)
    const workTree = addWorkTree(cwd)
    writeFileSync(join(workTree, 'tracked.txt'), 'first\npre-existing\n')
    await prepareTurnSnapshot(workTree, cwd, 'session-1')

    writeFileSync(join(workTree, 'tracked.txt'), 'first\n')
    await snapshotTurn(workTree, cwd, 'session-1', { sessionChangedFiles: [] })

    expect(await getDiffStats(workTree, cwd, { kind: 'turn', index: 0 }, 'session-1', [])).toEqual([
      { path: 'tracked.txt', additions: 0, deletions: 1, status: 'M' },
    ])
  })

  // WHY: the shared-checkout scope is a filter on paths, not on content. A path
  // the session named stays fully reported, including a deletion the transcript
  // never announced.
  test('a shared checkout still reports a deletion of a path the session touched', async () => {
    const { cwd, baseSha } = createRepo()
    await initSessionBase(cwd, 'session-1', baseSha)
    await prepareTurnSnapshot(cwd, cwd, 'session-1')

    rmSync(join(cwd, 'tracked.txt'))
    const result = await snapshotTurn(cwd, cwd, 'session-1', {
      sessionChangedFiles: ['tracked.txt'],
    })

    expect(result?.snapshot).toMatchObject({ filesChanged: 1, additions: 0, deletions: 1 })
    expect(await getDiffStats(cwd, cwd, { kind: 'turn', index: 0 }, 'session-1', [])).toEqual([
      { path: 'tracked.txt', additions: 0, deletions: 1, status: 'D' },
    ])
  })
})
