import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkoutPrInRepo } from '../../src/main/git/worktree-manager'

const roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function makeRepo(prefix: string): { root: string; origin: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  const origin = join(root, 'origin.git')
  const project = join(root, 'project')
  mkdirSync(origin)
  git(origin, ['init', '--bare', '--initial-branch=main'])
  git(root, ['clone', origin, project])
  git(project, ['config', 'user.email', 'test@solus.local'])
  git(project, ['config', 'user.name', 'Solus Test'])
  writeFileSync(join(project, 'base.txt'), 'base\n')
  // Isolated worktrees live inside the project directory; a real Solus repo
  // ignores them, and a test worktree that shows up as untracked would make
  // `git status --porcelain` see the fixture itself as dirty.
  writeFileSync(join(project, '.gitignore'), '.solus-worktrees/**\n')
  git(project, ['add', 'base.txt', '.gitignore'])
  git(project, ['commit', '-m', 'base'])
  git(project, ['push', '-u', 'origin', 'main'])
  return { root, origin, project }
}

/** Pushes a feature branch with one commit and returns its head sha. */
function pushFeatureBranch(project: string, branch: string, file: string, contents: string): string {
  git(project, ['checkout', 'main'])
  git(project, ['checkout', '-b', branch])
  writeFileSync(join(project, file), contents)
  git(project, ['add', file])
  git(project, ['commit', '-m', `add ${file}`])
  git(project, ['push', '-u', 'origin', branch])
  const sha = git(project, ['rev-parse', 'HEAD'])
  git(project, ['checkout', 'main'])
  git(project, ['branch', '-D', branch])
  return sha
}

describe('checkoutPrInRepo', () => {
  test('checks out a same-repository PR head branch cleanly', async () => {
    const { project } = makeRepo('solus-pr-repo-clean-')
    const headSha = pushFeatureBranch(project, 'feature/x', 'feature.txt', 'feature\n')

    const outcome = await checkoutPrInRepo(project, 41, headSha, { headRef: 'feature/x', isFork: false })

    expect(outcome).toEqual({ outcome: 'ready', branch: 'feature/x', headSha })
    expect(git(project, ['branch', '--show-current'])).toBe('feature/x')
  })

  test('blocks on a dirty working tree without touching it', async () => {
    const { project } = makeRepo('solus-pr-repo-dirty-')
    const headSha = pushFeatureBranch(project, 'feature/x', 'feature.txt', 'feature\n')
    writeFileSync(join(project, 'base.txt'), 'uncommitted change\n')

    const outcome = await checkoutPrInRepo(project, 41, headSha, { headRef: 'feature/x', isFork: false })

    expect(outcome).toEqual({ outcome: 'blocked', reason: 'dirty' })
    expect(git(project, ['branch', '--show-current'])).toBe('main')
  })

  test('blocks on unresolved merge conflicts', async () => {
    const { project } = makeRepo('solus-pr-repo-conflicted-')
    const headSha = pushFeatureBranch(project, 'feature/x', 'feature.txt', 'feature\n')
    git(project, ['checkout', '-b', 'conflict-source', 'main'])
    writeFileSync(join(project, 'base.txt'), 'from conflict-source\n')
    git(project, ['add', 'base.txt'])
    git(project, ['commit', '-m', 'conflict-source change'])
    git(project, ['checkout', 'main'])
    writeFileSync(join(project, 'base.txt'), 'from main\n')
    git(project, ['add', 'base.txt'])
    git(project, ['commit', '-m', 'main change'])
    spawnSync('git', ['merge', 'conflict-source'], { cwd: project })

    const outcome = await checkoutPrInRepo(project, 41, headSha, { headRef: 'feature/x', isFork: false })

    expect(outcome).toEqual({ outcome: 'blocked', reason: 'conflicted' })
  })

  test('rejects a stale expected head instead of checking out the wrong revision', async () => {
    const { project } = makeRepo('solus-pr-repo-stale-')
    pushFeatureBranch(project, 'feature/x', 'feature.txt', 'feature\n')

    const outcome = await checkoutPrInRepo(project, 41, 'f'.repeat(40), { headRef: 'feature/x', isFork: false })

    expect(outcome).toEqual({ outcome: 'blocked', reason: 'stale-head' })
    expect(git(project, ['branch', '--show-current'])).toBe('main')
  })

  test('uses the local review-branch convention for a fork PR', async () => {
    const { project } = makeRepo('solus-pr-repo-fork-')
    git(project, ['checkout', '-b', 'contributor-work'])
    writeFileSync(join(project, 'feature.txt'), 'fork change\n')
    git(project, ['add', 'feature.txt'])
    git(project, ['commit', '-m', 'fork change'])
    const headSha = git(project, ['rev-parse', 'HEAD'])
    // A fork's commit is never pushed to a real branch on the base repo; GitHub
    // exposes it only under `refs/pull/<n>/head`, so mirror that here.
    git(project, ['push', 'origin', 'contributor-work:refs/pull/55/head'])
    git(project, ['checkout', 'main'])
    git(project, ['branch', '-D', 'contributor-work'])

    const outcome = await checkoutPrInRepo(project, 55, headSha, { headRef: 'contributor/change', isFork: true })

    expect(outcome).toEqual({ outcome: 'ready', branch: 'solus/pr-55', headSha })
    expect(git(project, ['branch', '--show-current'])).toBe('solus/pr-55')
  })

  test('blocks when the branch is already checked out in another worktree', async () => {
    const { project } = makeRepo('solus-pr-repo-inuse-')
    const headSha = pushFeatureBranch(project, 'feature/x', 'feature.txt', 'feature\n')
    const otherWorktree = join(project, '.solus-worktrees', 'feature-x')
    mkdirSync(join(project, '.solus-worktrees'), { recursive: true })
    git(project, ['worktree', 'add', otherWorktree, 'feature/x'])

    const outcome = await checkoutPrInRepo(project, 41, headSha, { headRef: 'feature/x', isFork: false })

    expect(outcome).toEqual({ outcome: 'blocked', reason: 'branch-in-use', worktreePath: realpathSync(otherWorktree) })
    expect(git(project, ['branch', '--show-current'])).toBe('main')
  })

  test('fetches the exact new head on a repeat checkout and fast-forwards the existing branch', async () => {
    const { project } = makeRepo('solus-pr-repo-refetch-')
    const firstHeadSha = pushFeatureBranch(project, 'feature/x', 'feature.txt', 'feature v1\n')
    const first = await checkoutPrInRepo(project, 41, firstHeadSha, { headRef: 'feature/x', isFork: false })
    expect(first).toEqual({ outcome: 'ready', branch: 'feature/x', headSha: firstHeadSha })
    git(project, ['checkout', 'main'])

    // The PR gained a follow-up commit upstream after the first checkout.
    git(project, ['checkout', 'feature/x'])
    writeFileSync(join(project, 'feature.txt'), 'feature v2\n')
    git(project, ['add', 'feature.txt'])
    git(project, ['commit', '-m', 'follow-up'])
    git(project, ['push', 'origin', 'feature/x'])
    const secondHeadSha = git(project, ['rev-parse', 'HEAD'])
    git(project, ['checkout', 'main'])

    const second = await checkoutPrInRepo(project, 41, secondHeadSha, { headRef: 'feature/x', isFork: false })

    expect(second).toEqual({ outcome: 'ready', branch: 'feature/x', headSha: secondHeadSha })
    expect(git(project, ['rev-parse', 'feature/x'])).toBe(secondHeadSha)
  })
})
