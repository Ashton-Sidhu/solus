import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { test, expect } from '@playwright/test'
import { createWorktree, restoreWorktree } from '@solus/server/git/worktree-manager'
import { worktreeProjectRoot } from '@solus/contracts/types'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'solus-worktree-session-'))
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.email', 'e2e@example.test'])
  git(repo, ['config', 'user.name', 'Solus E2E'])
  writeFileSync(join(repo, 'README.md'), '# Worktree session\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-m', 'initial commit'])
  return repo
}

test.describe('Worktree sessions', () => {
  let repo: string

  test.afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  test('starting a new session with worktrees creates an isolated worktree context', async () => {
    repo = makeRepo()

    const gitContext = await createWorktree(repo, 'main')

    expect(gitContext.targetBranch).toBe('main')
    expect(gitContext.branch).toMatch(/^solus\/[0-9a-f]{8}$/)
    expect(gitContext.worktreePath).toContain(join(repo, '.git', 'solus', 'worktrees'))
    expect(realpathSync(git(gitContext.worktreePath!, ['rev-parse', '--show-toplevel']))).toBe(realpathSync(gitContext.worktreePath!))
    expect(git(gitContext.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(gitContext.branch)
  })

  test('starts new worktrees from origin when the remote branch has newer commits', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'solus-worktree-remote-'))
    repo = mkdtempSync(join(tmpdir(), 'solus-worktree-session-'))
    git(remote, ['init', '--bare'])
    git(repo, ['clone', remote, '.'])
    git(repo, ['checkout', '-b', 'main'])
    git(repo, ['config', 'user.email', 'e2e@example.test'])
    git(repo, ['config', 'user.name', 'Solus E2E'])
    writeFileSync(join(repo, 'README.md'), '# Local base\n')
    git(repo, ['add', 'README.md'])
    git(repo, ['commit', '-m', 'local base'])
    git(repo, ['push', '-u', 'origin', 'main'])

    const updater = mkdtempSync(join(tmpdir(), 'solus-worktree-updater-'))
    git(updater, ['clone', remote, '.'])
    git(updater, ['checkout', 'main'])
    git(updater, ['config', 'user.email', 'e2e@example.test'])
    git(updater, ['config', 'user.name', 'Solus E2E'])
    writeFileSync(join(updater, 'README.md'), '# Remote base\n')
    git(updater, ['commit', '-am', 'remote base'])
    git(updater, ['push', 'origin', 'main'])

    const remoteMain = git(updater, ['rev-parse', 'HEAD'])
    const localMain = git(repo, ['rev-parse', 'main'])
    expect(localMain).not.toBe(remoteMain)

    const gitContext = await createWorktree(repo, 'main')

    expect(git(gitContext.worktreePath!, ['rev-parse', 'HEAD'])).toBe(remoteMain)
    expect(readFileSync(join(gitContext.worktreePath!, 'README.md'), 'utf-8')).toBe('# Remote base\n')
    rmSync(updater, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  })

  test('copies only gitignored files matched by .worktreeinclude into new worktrees', async () => {
    repo = makeRepo()
    writeFileSync(join(repo, '.gitignore'), '.env\n.env.local\nconfig/secrets.json\nignored-but-not-included.txt\n')
    writeFileSync(join(repo, '.worktreeinclude'), '.env\n.env.local\nconfig/secrets.json\nREADME.md\nnot-ignored.txt\n')
    writeFileSync(join(repo, '.env'), 'API_KEY=local\n')
    writeFileSync(join(repo, '.env.local'), 'LOCAL_ONLY=true\n')
    writeFileSync(join(repo, 'not-ignored.txt'), 'do not copy\n')
    writeFileSync(join(repo, 'ignored-but-not-included.txt'), 'do not copy\n')
    git(repo, ['add', '.gitignore', '.worktreeinclude'])
    git(repo, ['commit', '-m', 'add worktree include rules'])
    mkdirSync(join(repo, 'config'))
    writeFileSync(join(repo, 'config/secrets.json'), '{"token":"local"}\n')

    const gitContext = await createWorktree(repo, 'main')
    const worktreePath = gitContext.worktreePath!

    expect(readFileSync(join(worktreePath, '.env'), 'utf-8')).toBe('API_KEY=local\n')
    expect(readFileSync(join(worktreePath, '.env.local'), 'utf-8')).toBe('LOCAL_ONLY=true\n')
    expect(readFileSync(join(worktreePath, 'config/secrets.json'), 'utf-8')).toBe('{"token":"local"}\n')
    expect(existsSync(join(worktreePath, 'not-ignored.txt'))).toBe(false)
    expect(existsSync(join(worktreePath, 'ignored-but-not-included.txt'))).toBe(false)
    expect(readFileSync(join(worktreePath, 'README.md'), 'utf-8')).toBe('# Worktree session\n')
  })

  test('resuming a worktree session restores git context and keeps the project path at the repo root', () => {
    repo = makeRepo()
    const worktreePath = join(repo, '.git', 'solus', 'worktrees', 'solus-resume-test')
    git(repo, ['worktree', 'add', '-b', 'solus/resume-test', worktreePath, 'main'])

    const gitContext = restoreWorktree(worktreePath)
    const projectPath = worktreeProjectRoot(worktreePath)

    expect(projectPath).toBe(repo)
    expect(gitContext).toMatchObject({
      branch: 'solus/resume-test',
      targetBranch: 'main',
      worktreePath,
      repoRoot: repo,
    })
  })
})
