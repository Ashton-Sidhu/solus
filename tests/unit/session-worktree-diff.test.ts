import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDiff, getDiffStats, getSessionSnapshotRange, initSessionBase, prepareTurnSnapshot, snapshotTurn } from '@solus/server/git/session-snapshots'

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
  const repoRoot = mkdtempSync(join(tmpdir(), 'solus-session-worktree-'))
  dirs.push(repoRoot)
  git(repoRoot, ['init'])
  git(repoRoot, ['config', 'user.email', 'test@example.com'])
  git(repoRoot, ['config', 'user.name', 'Test'])
  writeFileSync(join(repoRoot, 'tracked.txt'), 'first\n')
  git(repoRoot, ['add', '.'])
  git(repoRoot, ['commit', '-m', 'base'])
  return { repoRoot, baseSha: git(repoRoot, ['rev-parse', 'HEAD']) }
}

function addWorkTree(repoRoot: string) {
  const workTree = join(mkdtempSync(join(tmpdir(), 'solus-session-wt-')), 'checkout')
  dirs.push(workTree)
  git(repoRoot, ['worktree', 'add', '-b', 'feature', workTree])
  return workTree
}

/**
 * `livePaths` is harvested from the session's Write/Edit tool messages, so a
 * file the session wrote through the shell or a subagent never appears in it.
 * In the session's own worktree that filter can only hide the session's own
 * work, which is why the scope must ignore it there.
 */
describe('session-scoped diff in the session’s own worktree', () => {
  test('saved snapshots retain unreported shell changes and their later removal', async () => {
    const { repoRoot, baseSha } = createRepo()
    const workTree = addWorkTree(repoRoot)
    await initSessionBase(repoRoot, 'session-shell', baseSha)
    await prepareTurnSnapshot(workTree, repoRoot, 'session-shell')
    writeFileSync(join(workTree, 'tracked.txt'), 'changed through the shell\n')
    writeFileSync(join(workTree, 'shell.txt'), 'new through the shell\n')
    git(workTree, ['add', 'tracked.txt'])
    const stagedTree = git(workTree, ['write-tree'])

    const first = await snapshotTurn(workTree, repoRoot, 'session-shell', { sessionChangedFiles: [] })
    expect(first?.sessionChangedFiles?.sort()).toEqual(['shell.txt', 'tracked.txt'])
    const range = getSessionSnapshotRange(repoRoot, 'session-shell')!
    expect(git(repoRoot, ['show', `${range.headSha}:shell.txt`])).toBe('new through the shell')
    expect(git(repoRoot, ['rev-parse', `${range.headSha}^{tree}`])).toBe(first?.snapshot.toTreeSha)
    expect(git(workTree, ['write-tree'])).toBe(stagedTree)
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).toBe(baseSha)

    await prepareTurnSnapshot(workTree, repoRoot, 'session-shell')
    rmSync(join(workTree, 'shell.txt'))
    writeFileSync(join(workTree, 'tracked.txt'), 'first\n')
    const second = await snapshotTurn(workTree, repoRoot, 'session-shell', { sessionChangedFiles: [] })
    expect(second?.sessionChangedFiles).toEqual([])
    const saved = await getDiff(null, repoRoot, { kind: 'session' }, 'session-shell', [])
    expect(saved?.patch).toBe('')
    expect(git(workTree, ['write-tree'])).toBe(stagedTree)
  })

  test('includes a file the session changed without a Write/Edit tool call', async () => {
    const { repoRoot, baseSha } = createRepo()
    await initSessionBase(repoRoot, 'session-1', baseSha)
    const workTree = addWorkTree(repoRoot)

    writeFileSync(join(workTree, 'tracked.txt'), 'first\nfrom an Edit call\n')
    writeFileSync(join(workTree, 'from-shell.txt'), 'written by a Bash heredoc\n')

    const stats = await getDiffStats(workTree, repoRoot, { kind: 'session' }, 'session-1', ['tracked.txt'])

    expect(stats.map((stat) => stat.path).sort()).toEqual(['from-shell.txt', 'tracked.txt'])
    const diff = await getDiff(workTree, repoRoot, { kind: 'session' }, 'session-1', ['tracked.txt'])
    expect(diff?.patch).toContain('from-shell.txt')
  })

  test('a shared checkout still scopes to the paths this session touched', async () => {
    const { repoRoot, baseSha } = createRepo()
    await initSessionBase(repoRoot, 'session-1', baseSha)

    writeFileSync(join(repoRoot, 'tracked.txt'), 'first\nfrom an Edit call\n')
    writeFileSync(join(repoRoot, 'someone-else.txt'), 'another session was here\n')

    const stats = await getDiffStats(repoRoot, repoRoot, { kind: 'session' }, 'session-1', ['tracked.txt'])

    expect(stats.map((stat) => stat.path)).toEqual(['tracked.txt'])
  })
})
