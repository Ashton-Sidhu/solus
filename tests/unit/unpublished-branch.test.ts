import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { isUnpublishedBranch } = await import('@solus/server/git/git-helpers')
const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')
actAsHostForTests()

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

function repository(): { dir: string; git: (...args: string[]) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'solus-unpublished-'))
  roots.push(dir)
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'start')
  git('remote', 'add', 'origin', 'https://github.com/acme/app.git')
  return { dir, git }
}

// WHY: each turn end asked GitHub about every live branch, and most are
// worktree branches an agent never pushed. A branch with no upstream and no
// remote branch of its name has no pull request; t3code answers that from Git
// alone (`GitManager.isUnpublishedBranch`) and so does this.
test('a branch with no upstream and no remote branch of its name is unpublished', async () => {
  const { dir, git } = repository()
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('branch', 'solus/agent-work')
  expect(await isUnpublishedBranch(dir, 'solus/agent-work')).toBe(true)

  // Pushed: a remote branch of its name now exists.
  git('update-ref', 'refs/remotes/origin/solus/agent-work', 'HEAD')
  expect(await isUnpublishedBranch(dir, 'solus/agent-work')).toBe(false)
})

test('a branch with an upstream is published, and a repository that tracks no remote branch cannot tell', async () => {
  const { dir, git } = repository()
  git('branch', 'never-fetched')
  // Nothing fetched yet: no remote-tracking branch at all, so it is looked up.
  expect(await isUnpublishedBranch(dir, 'never-fetched')).toBe(false)

  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('branch', 'tracking')
  git('branch', '--set-upstream-to=origin/main', 'tracking')
  expect(await isUnpublishedBranch(dir, 'tracking')).toBe(false)
})
