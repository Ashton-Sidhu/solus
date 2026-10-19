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
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

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

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

describe('turn diff stats', () => {
  test('exclude edits that were already present when the turn started', async () => {
    const { cwd, baseSha } = createRepo()
    await initSessionBase(cwd, 'session-1', baseSha)
    writeFileSync(join(cwd, 'tracked.txt'), 'first\npre-existing\n')
    await prepareTurnSnapshot(cwd, cwd, 'session-1')

    writeFileSync(join(cwd, 'tracked.txt'), 'first\npre-existing\nthis turn\n')
    const result = await snapshotTurn(cwd, cwd, 'session-1')

    expect(result?.snapshot).toMatchObject({ filesChanged: 1, additions: 1, deletions: 0 })
    expect(await getDiffStats(cwd, cwd, { kind: 'turn', index: 0 }, 'session-1')).toEqual([
      { path: 'tracked.txt', additions: 1, deletions: 0, status: 'M' },
    ])
  })

  // WHY: the card after a turn reads this range. When the main checkout's end
  // snapshot restaged only the paths a tool call named, an agent that edited
  // through the shell got an empty range and no card. Both ends are the whole
  // checkout, so an edit by another author during the turn shows as well.
  test('a shared checkout reports an edit no tool call announced', async () => {
    const { cwd, baseSha } = createRepo()
    await initSessionBase(cwd, 'session-1', baseSha)
    await prepareTurnSnapshot(cwd, cwd, 'session-1')

    writeFileSync(join(cwd, 'tracked.txt'), 'first\nfrom a sed -i\n')
    writeFileSync(join(cwd, 'from-shell.txt'), 'written by a Bash heredoc\n')
    const result = await snapshotTurn(cwd, cwd, 'session-1')

    expect(result?.snapshot).toMatchObject({ filesChanged: 2 })
    expect(result?.sessionChangedFiles?.sort()).toEqual(['from-shell.txt', 'tracked.txt'])
    expect(await getDiffStats(cwd, cwd, { kind: 'turn', index: 0 }, 'session-1')).toEqual([
      { path: 'from-shell.txt', additions: 1, deletions: 0, status: 'A' },
      { path: 'tracked.txt', additions: 1, deletions: 0, status: 'M' },
    ])
  })

  // WHY: a shell `rm`, a subagent, or a script never produces an Edit/Write
  // message, and its deletion is still the turn's change.
  test('report a deletion no tool call announced in the session’s own worktree', async () => {
    const { cwd, baseSha } = createRepo()
    await initSessionBase(cwd, 'session-1', baseSha)
    const workTree = addWorkTree(cwd)
    await prepareTurnSnapshot(workTree, cwd, 'session-1')

    rmSync(join(workTree, 'tracked.txt'))
    const result = await snapshotTurn(workTree, cwd, 'session-1')

    expect(result?.snapshot).toMatchObject({ filesChanged: 1, additions: 0, deletions: 1 })
    expect(await getDiffStats(workTree, cwd, { kind: 'turn', index: 0 }, 'session-1')).toEqual([
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
    await snapshotTurn(workTree, cwd, 'session-1')

    expect(await getDiffStats(workTree, cwd, { kind: 'turn', index: 0 }, 'session-1')).toEqual([
      { path: 'tracked.txt', additions: 0, deletions: 1, status: 'M' },
    ])
  })
})
