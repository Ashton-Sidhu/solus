import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDiff, getDiffStats } from '@solus/server/git/session-snapshots'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

// A project can be a subdirectory of its repository, and a person can set
// `diff.relative=true` in their git config. Solus reads every diff as paths from
// the repository root, so that setting must not cut them down to the project.

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

actAsHostForTests()

describe('git diffs under diff.relative', () => {
  test('a project in a subdirectory still reads repository paths', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'solus-diff-relative-'))
    dirs.push(repoRoot)
    git(repoRoot, ['init'])
    git(repoRoot, ['config', 'user.email', 'test@example.com'])
    git(repoRoot, ['config', 'user.name', 'Test'])
    mkdirSync(join(repoRoot, 'app'))
    writeFileSync(join(repoRoot, 'app', 'kept.txt'), 'first\n')
    writeFileSync(join(repoRoot, 'README.md'), 'readme\n')
    git(repoRoot, ['add', '.'])
    git(repoRoot, ['commit', '-m', 'base'])
    git(repoRoot, ['config', 'diff.relative', 'true'])

    const workTree = join(repoRoot, 'app')
    writeFileSync(join(workTree, 'kept.txt'), 'changed\n')
    writeFileSync(join(repoRoot, 'README.md'), 'changed readme\n')

    const stats = await getDiffStats(workTree, repoRoot, { kind: 'working-tree' }, null)
    expect(stats.map((file) => file.path).sort()).toEqual(['README.md', 'app/kept.txt'])
    const diff = await getDiff(workTree, repoRoot, { kind: 'working-tree' }, null)
    expect(diff?.patch).toContain('+++ b/app/kept.txt')
  })
})
