import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDiff, getDiffStats, initSessionBase } from '@solus/server/git/session-snapshots'

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
