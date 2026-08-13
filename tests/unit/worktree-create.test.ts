import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { realpathSync, writeFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createWorktree, ensureBranchWorktree } from '../../src/main/git/worktree-manager'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('worktree creation hot path', () => {
  test('derives the branch name locally and starts from the refreshed remote branch', async () => {
    // WHY: creating a worktree must not start a separate agent run only to name
    // its branch. The one required network operation is the base-branch fetch.
    const root = await temporaryDirectory()
    const origin = join(root, 'origin.git')
    const project = join(root, 'project')
    git(root, ['init', '--bare', origin])
    git(root, ['init', '-b', 'main', project])
    git(project, ['config', 'user.email', 'test@solus.local'])
    git(project, ['config', 'user.name', 'Solus Test'])
    writeFileSync(join(project, 'tracked.txt'), 'base\n')
    git(project, ['add', 'tracked.txt'])
    git(project, ['commit', '-m', 'base'])
    git(project, ['remote', 'add', 'origin', origin])
    git(project, ['push', '-u', 'origin', 'main'])

    const checkout = await createWorktree(project, 'Speed up worktree creation', 'main')

    expect(checkout.branch).toMatch(/^solus\/speed-up-worktree-creation-[a-z0-9]{5}$/)
    expect(checkout.targetBranch).toBe('main')
    expect(checkout.worktreePath).toContain('/.solus-worktrees/')
    expect(git(checkout.worktreePath!, ['rev-parse', 'HEAD'])).toBe(git(project, ['rev-parse', 'origin/main']))
  })

  test('materializes a selected origin branch as that branch and reuses it', async () => {
    const root = await temporaryDirectory()
    const origin = join(root, 'origin.git')
    const seed = join(root, 'seed')
    const project = join(root, 'project')
    git(root, ['init', '--bare', origin])
    git(root, ['init', '-b', 'release', seed])
    git(seed, ['config', 'user.email', 'test@solus.local'])
    git(seed, ['config', 'user.name', 'Solus Test'])
    writeFileSync(join(seed, 'tracked.txt'), 'release\n')
    git(seed, ['add', 'tracked.txt'])
    git(seed, ['commit', '-m', 'release'])
    git(seed, ['remote', 'add', 'origin', origin])
    git(seed, ['push', '-u', 'origin', 'release'])
    git(root, ['clone', origin, project])

    const first = await ensureBranchWorktree(project, 'release')
    const second = await ensureBranchWorktree(project, 'release')

    // WHY: choosing origin/release means work on release. It must not create a
    // prompt-derived branch, and selecting it again must not create a duplicate.
    expect(first.branch).toBe('release')
    expect(realpathSync(first.worktreePath!)).toBe(realpathSync(second.worktreePath!))
    expect(git(first.worktreePath!, ['branch', '--show-current'])).toBe('release')
    expect(git(project, ['worktree', 'list', '--porcelain']).match(/branch refs\/heads\/release/g)?.length).toBe(1)
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'solus-worktree-create-'))
  temporaryDirectories.push(directory)
  return directory
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
