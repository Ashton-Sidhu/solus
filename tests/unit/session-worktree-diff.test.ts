import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDiff, getDiffStats, getSessionSnapshotRange, initSessionBase, prepareTurnSnapshot, snapshotTurn } from '@solus/server/git/session-snapshots'
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
 * An agent changes files through the shell, a subagent, or a script as often as
 * through a Write/Edit tool. The session diff reads the checkout itself, so no
 * route an edit takes can hide it.
 */
// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

describe('session-scoped diff', () => {
  test('saved snapshots retain unreported shell changes and their later removal', async () => {
    const { repoRoot, baseSha } = createRepo()
    const workTree = addWorkTree(repoRoot)
    await initSessionBase(repoRoot, 'session-shell', baseSha)
    await prepareTurnSnapshot(workTree, repoRoot, 'session-shell')
    writeFileSync(join(workTree, 'tracked.txt'), 'changed through the shell\n')
    writeFileSync(join(workTree, 'shell.txt'), 'new through the shell\n')
    git(workTree, ['add', 'tracked.txt'])
    const stagedTree = git(workTree, ['write-tree'])

    const first = await snapshotTurn(workTree, repoRoot, 'session-shell', {})
    expect(first?.sessionChangedFiles?.sort()).toEqual(['shell.txt', 'tracked.txt'])
    const range = getSessionSnapshotRange(repoRoot, 'session-shell')!
    expect(git(repoRoot, ['show', `${range.headSha}:shell.txt`])).toBe('new through the shell')
    expect(git(repoRoot, ['rev-parse', `${range.headSha}^{tree}`])).toBe(first?.snapshot.toTreeSha)
    expect(git(workTree, ['write-tree'])).toBe(stagedTree)
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).toBe(baseSha)

    await prepareTurnSnapshot(workTree, repoRoot, 'session-shell')
    rmSync(join(workTree, 'shell.txt'))
    writeFileSync(join(workTree, 'tracked.txt'), 'first\n')
    const second = await snapshotTurn(workTree, repoRoot, 'session-shell', {})
    expect(second?.sessionChangedFiles).toEqual([])
    const saved = await getDiff(null, repoRoot, { kind: 'session' }, 'session-shell')
    expect(saved?.patch).toBe('')
    expect(git(workTree, ['write-tree'])).toBe(stagedTree)
  })

  test('includes a file the session changed without a Write/Edit tool call', async () => {
    const { repoRoot, baseSha } = createRepo()
    await initSessionBase(repoRoot, 'session-1', baseSha)
    const workTree = addWorkTree(repoRoot)

    writeFileSync(join(workTree, 'tracked.txt'), 'first\nfrom an Edit call\n')
    writeFileSync(join(workTree, 'from-shell.txt'), 'written by a Bash heredoc\n')

    const stats = await getDiffStats(workTree, repoRoot, { kind: 'session' }, 'session-1')

    expect(stats.map((stat) => stat.path).sort()).toEqual(['from-shell.txt', 'tracked.txt'])
    const diff = await getDiff(workTree, repoRoot, { kind: 'session' }, 'session-1')
    expect(diff?.patch).toContain('from-shell.txt')
  })

  // WHY: many sessions and the developer share the main checkout. A session's
  // diff must show what its own turns changed, shell edits included, and not
  // the work other authors did between its turns.
  test('a shared checkout shows only the paths changed during the session\'s turns', async () => {
    const { repoRoot, baseSha } = createRepo()
    await initSessionBase(repoRoot, 'session-1', baseSha)

    writeFileSync(join(repoRoot, 'other-session.txt'), 'written before the turn\n')
    await prepareTurnSnapshot(repoRoot, repoRoot, 'session-1')
    writeFileSync(join(repoRoot, 'from-shell.txt'), 'written by a Bash heredoc\n')

    const live = await getDiffStats(repoRoot, repoRoot, { kind: 'session' }, 'session-1')
    expect(live.map((stat) => stat.path)).toEqual(['from-shell.txt'])

    const ended = await snapshotTurn(repoRoot, repoRoot, 'session-1', {})
    expect(ended?.sessionChangedFiles).toEqual(['from-shell.txt'])
    writeFileSync(join(repoRoot, 'tracked.txt'), 'first\nedited between turns\n')

    const stats = await getDiffStats(repoRoot, repoRoot, { kind: 'session' }, 'session-1')
    expect(stats.map((stat) => stat.path)).toEqual(['from-shell.txt'])
    const diff = await getDiff(repoRoot, repoRoot, { kind: 'session' }, 'session-1')
    expect(diff?.patch).toContain('from-shell.txt')
    expect(diff?.patch).not.toContain('other-session.txt')
    expect(diff?.patch).not.toContain('tracked.txt')
  })

  // WHY: one file an agent writes outside the sparse cone made git refuse the
  // add, so the whole working-tree diff and its totals failed.
  test('an untracked file outside the sparse cone keeps the diff, totals, and turn snapshot', async () => {
    const { repoRoot } = createRepo()
    mkdirSync(join(repoRoot, 'included'))
    mkdirSync(join(repoRoot, 'excluded'))
    writeFileSync(join(repoRoot, 'included', 'in.txt'), 'in\n')
    writeFileSync(join(repoRoot, 'excluded', 'out.txt'), 'out\n')
    git(repoRoot, ['add', '.'])
    git(repoRoot, ['commit', '-m', 'folders'])
    git(repoRoot, ['sparse-checkout', 'set', '--cone', 'included'])
    await initSessionBase(repoRoot, 'session-sparse', git(repoRoot, ['rev-parse', 'HEAD']))
    await prepareTurnSnapshot(repoRoot, repoRoot, 'session-sparse')
    mkdirSync(join(repoRoot, 'excluded'), { recursive: true })
    writeFileSync(join(repoRoot, 'excluded', 'new.txt'), 'outside the cone\n')

    const diff = await getDiff(repoRoot, repoRoot, { kind: 'working-tree' }, null)
    expect(diff?.patch).toContain('+outside the cone')
    const stats = await getDiffStats(repoRoot, repoRoot, { kind: 'working-tree' }, null)
    expect(stats.map((file) => file.path)).toContain('excluded/new.txt')

    await snapshotTurn(repoRoot, repoRoot, 'session-sparse', {})
    const range = getSessionSnapshotRange(repoRoot, 'session-sparse')!
    expect(git(repoRoot, ['show', `${range.headSha}:excluded/new.txt`])).toBe('outside the cone')
  })

  // WHY: core.safecrlf=true refuses an LF file that CRLF conversion applies to.
  // The fallback then took the path out of the index, so a new file vanished
  // from the turn and a tracked one read as deleted.
  test('a turn snapshot keeps LF files that core.safecrlf would refuse', async () => {
    const { repoRoot } = createRepo()
    writeFileSync(join(repoRoot, '.gitattributes'), '*.txt text eol=crlf\n')
    git(repoRoot, ['add', '.'])
    git(repoRoot, ['commit', '-m', 'line endings'])
    git(repoRoot, ['config', 'core.safecrlf', 'true'])
    await initSessionBase(repoRoot, 'session-crlf', git(repoRoot, ['rev-parse', 'HEAD']))
    await prepareTurnSnapshot(repoRoot, repoRoot, 'session-crlf')
    writeFileSync(join(repoRoot, 'tracked.txt'), 'changed\n')
    writeFileSync(join(repoRoot, 'new.txt'), 'new\n')

    await snapshotTurn(repoRoot, repoRoot, 'session-crlf', {})

    const range = getSessionSnapshotRange(repoRoot, 'session-crlf')!
    expect(git(repoRoot, ['show', `${range.headSha}:tracked.txt`])).toBe('changed')
    expect(git(repoRoot, ['show', `${range.headSha}:new.txt`])).toBe('new')
  })

  // WHY: under diff.submodule=log the moved submodule is in the file list, but
  // its summary line has no `diff --git` header for the renderer to parse.
  test.each(['log', 'diff'])('a moved submodule keeps its diff entry under diff.submodule=%s', async (format) => {
    const { repoRoot } = createRepo()
    const nested = join(repoRoot, 'sub')
    mkdirSync(nested)
    git(nested, ['init'])
    git(nested, ['config', 'user.email', 'test@example.com'])
    git(nested, ['config', 'user.name', 'Test'])
    git(nested, ['commit', '--allow-empty', '-m', 'first'])
    git(repoRoot, ['add', 'sub'])
    git(repoRoot, ['commit', '-m', 'add nested repository'])
    git(nested, ['commit', '--allow-empty', '-m', 'moved'])
    git(repoRoot, ['config', 'diff.submodule', format])

    const diff = await getDiff(repoRoot, repoRoot, { kind: 'working-tree' }, null)
    expect(diff?.patch).toContain('diff --git a/sub b/sub')
    expect(diff?.patch).toContain('+Subproject commit ')
  })

  test('a shared checkout shows nothing before the session\'s first turn', async () => {
    const { repoRoot, baseSha } = createRepo()
    await initSessionBase(repoRoot, 'session-1', baseSha)
    writeFileSync(join(repoRoot, 'tracked.txt'), 'first\nanother author\n')

    const diff = await getDiff(repoRoot, repoRoot, { kind: 'session' }, 'session-1')
    expect(diff?.patch).toBe('')
  })
})
