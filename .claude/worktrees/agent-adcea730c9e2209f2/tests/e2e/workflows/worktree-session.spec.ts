import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { test, expect } from '@playwright/test'
import { createWorktree, restoreWorktree } from '../../../src/main/git/worktree-manager'
import { worktreeProjectRoot } from '../../../src/shared/types'

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

    const gitContext = await createWorktree(repo, 'make a focused test change', 'main')

    expect(gitContext.targetBranch).toBe('main')
    expect(gitContext.branch).toMatch(/^solus\/make-a-focused-test-change-/)
    expect(gitContext.worktreePath).toContain(join(repo, '.solus-worktrees'))
    expect(realpathSync(git(gitContext.worktreePath!, ['rev-parse', '--show-toplevel']))).toBe(realpathSync(gitContext.worktreePath!))
    expect(git(gitContext.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(gitContext.branch)
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

    const gitContext = await createWorktree(repo, 'copy include files', 'main')
    const worktreePath = gitContext.worktreePath!

    expect(readFileSync(join(worktreePath, '.env'), 'utf-8')).toBe('API_KEY=local\n')
    expect(readFileSync(join(worktreePath, '.env.local'), 'utf-8')).toBe('LOCAL_ONLY=true\n')
    expect(readFileSync(join(worktreePath, 'config/secrets.json'), 'utf-8')).toBe('{"token":"local"}\n')
    expect(existsSync(join(worktreePath, 'not-ignored.txt'))).toBe(false)
    expect(existsSync(join(worktreePath, 'ignored-but-not-included.txt'))).toBe(false)
    expect(readFileSync(join(worktreePath, 'README.md'), 'utf-8')).toBe('# Worktree session\n')
  })

  test('names the branch from the model summary, not the generic prompt lead-in', async () => {
    repo = makeRepo()

    // Plans routinely start with boilerplate ("implement this plan…"); the
    // distinctive part is buried. WHY: branches must stay searchable instead of
    // all collapsing into solus/implement-this-plan-*.
    const prompt = 'implement this plan: add a dark mode toggle to the settings screen'
    const gitContext = await createWorktree(repo, prompt, 'main', {
      generateName: async () => '"Dark Mode Toggle"',
    })

    expect(gitContext.branch).toMatch(/^solus\/dark-mode-toggle-/)
    expect(gitContext.branch).not.toContain('implement-this-plan')
    expect(git(gitContext.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(gitContext.branch)
  })

  test('ignores model preamble when extracting a generated branch name', async () => {
    repo = makeRepo()

    // WHY: small naming calls must tolerate agent-style preamble without
    // turning it into branches like solus/sure-here-is-*.
    const gitContext = await createWorktree(repo, 'fix automatic worktree naming', 'main', {
      generateName: async () => [
        'Sure, here is a concise branch name:',
        'worktree-name-generation',
      ].join('\n'),
    })

    expect(gitContext.branch).toMatch(/^solus\/worktree-name-generation-/)
    expect(gitContext.branch).not.toContain('sure-here')
  })

  test('falls back to a prompt slug when name generation fails', async () => {
    repo = makeRepo()

    // WHY: a slow or failing model call must never block worktree creation.
    const gitContext = await createWorktree(repo, 'make a focused test change', 'main', {
      generateName: async () => {
        throw new Error('model unavailable')
      },
    })

    expect(gitContext.branch).toMatch(/^solus\/make-a-focused-test-change-/)
  })

  test('resuming a worktree session restores git context and keeps the project path at the repo root', () => {
    repo = makeRepo()
    const worktreePath = join(repo, '.solus-worktrees', 'solus-resume-test')
    git(repo, ['worktree', 'add', '-b', 'solus/resume-test', worktreePath, 'main'])

    const gitContext = restoreWorktree(worktreePath)
    const projectPath = worktreeProjectRoot(worktreePath)

    expect(projectPath).toBe(repo)
    expect(gitContext).toMatchObject({
      branch: 'solus/resume-test',
      targetBranch: 'main',
      worktreePath,
    })
  })
})
