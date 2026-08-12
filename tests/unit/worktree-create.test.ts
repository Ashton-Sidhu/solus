import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createWorktree } from '../../src/main/git/worktree-manager'

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
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'solus-worktree-create-'))
  temporaryDirectories.push(directory)
  return directory
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
