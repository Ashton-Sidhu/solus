import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runGitAction, type GitActionManagerOptions } from '../../src/main/git/git-action-manager'
import type { GitActionRequest, GitCheckout } from '../../src/shared/types'
import type { TextGenerator } from '../../src/main/agents/text-generator'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function createRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'solus-selective-commit-'))
  roots.push(root)
  git(root, ['init', '-q', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'test@solus.local'])
  git(root, ['config', 'user.name', 'Solus Test'])
  return root
}

function baseOptions(overrides: Partial<GitActionManagerOptions> = {}): GitActionManagerOptions {
  return {
    generateCommitSubject: async () => 'chore: generated subject',
    publish: () => {},
    writer: {
      provider: 'codex',
      textGenerator: { generate: async () => '' } as unknown as TextGenerator,
      instructions: '',
      followPullRequestTemplate: false,
    },
    ...overrides,
  }
}

let actionCounter = 0
function commitAction(overrides: Partial<GitActionRequest> = {}): GitActionRequest {
  actionCounter++
  return { actionId: `selective-commit-${actionCounter}`, action: 'commit', ...overrides }
}

const mainCheckout: GitCheckout = { branch: 'main', targetBranch: 'main' }

describe('selective commit', () => {
  test('commits only the selected files, preserving excluded staged and unstaged state', async () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'a.txt'), 'a1\n')
    writeFileSync(join(repo, 'b.txt'), 'b1\n')
    writeFileSync(join(repo, 'c.txt'), 'c1\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'init'])

    writeFileSync(join(repo, 'a.txt'), 'a2\n') // unstaged edit (selected)
    writeFileSync(join(repo, 'b.txt'), 'b2\n')
    git(repo, ['add', 'b.txt']) // staged edit (excluded — must survive untouched)
    writeFileSync(join(repo, 'd.txt'), 'd1\n') // untracked (selected)
    unlinkSync(join(repo, 'c.txt')) // deleted (selected)

    const result = await runGitAction(
      commitAction({ filePaths: ['a.txt', 'd.txt', 'c.txt'], commitMessage: 'manual selective subject' }),
      mainCheckout,
      repo,
      baseOptions(),
    )

    expect(result.commit).toMatchObject({ status: 'created', subject: 'manual selective subject' })
    expect(git(repo, ['status', '--porcelain'])).toBe('M  b.txt')
    expect(git(repo, ['diff', '--cached', '--', 'b.txt'])).toContain('+b2')

    const committed = git(repo, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean)
    expect(committed.sort()).toEqual(['a.txt', 'c.txt', 'd.txt'])
    expect(git(repo, ['show', 'HEAD:d.txt'])).toBe('d1')
  })

  test('restores exact repository state when the commit fails', async () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'a.txt'), 'a1\n')
    writeFileSync(join(repo, 'b.txt'), 'b1\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'init'])
    const headBefore = git(repo, ['rev-parse', 'HEAD'])

    writeFileSync(join(repo, 'a.txt'), 'a2\n') // selected, unstaged
    writeFileSync(join(repo, 'b.txt'), 'b2\n')
    git(repo, ['add', 'b.txt']) // excluded, staged
    writeFileSync(join(repo, 'd.txt'), 'd1\n') // selected, untracked — must roll back to untracked on failure

    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n')
    spawnSync('chmod', ['+x', join(repo, '.git', 'hooks', 'pre-commit')])

    const statusBefore = git(repo, ['status', '--porcelain'])

    await expect(
      runGitAction(commitAction({ filePaths: ['a.txt', 'd.txt'] }), mainCheckout, repo, baseOptions()),
    ).rejects.toThrow()

    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(git(repo, ['status', '--porcelain'])).toBe(statusBefore)
  })

  test('rejects an empty selection, path traversal, absolute paths, and duplicates', async () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'a.txt'), 'a1\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'init'])
    writeFileSync(join(repo, 'a.txt'), 'a2\n')

    await expect(
      runGitAction(commitAction({ filePaths: [] }), mainCheckout, repo, baseOptions()),
    ).rejects.toThrow()
    await expect(
      runGitAction(commitAction({ filePaths: ['../outside.txt'] }), mainCheckout, repo, baseOptions()),
    ).rejects.toThrow()
    await expect(
      runGitAction(commitAction({ filePaths: ['/etc/passwd'] }), mainCheckout, repo, baseOptions()),
    ).rejects.toThrow()
    await expect(
      runGitAction(commitAction({ filePaths: ['a.txt', 'a.txt'] }), mainCheckout, repo, baseOptions()),
    ).rejects.toThrow()

    // None of the rejected attempts touched the repository.
    expect(git(repo, ['rev-list', '--count', 'HEAD'])).toBe('1')
    // `git()` trims stdout, which eats the porcelain format's leading index-status space.
    expect(git(repo, ['status', '--porcelain'])).toBe('M a.txt')
  })

  test('rejects commit fields on a non-commit action', async () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'a.txt'), 'a1\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'init'])

    await expect(
      runGitAction(
        { actionId: 'push-only', action: 'push', filePaths: ['a.txt'] },
        mainCheckout,
        repo,
        baseOptions(),
      ),
    ).rejects.toThrow()
    await expect(
      runGitAction(
        { actionId: 'push-only-2', action: 'push', commitMessage: 'nope' },
        mainCheckout,
        repo,
        baseOptions(),
      ),
    ).rejects.toThrow()
  })

  test('a blank message falls back to the generator; a manual message skips it', async () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'a.txt'), 'a1\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'init'])

    writeFileSync(join(repo, 'a.txt'), 'a2\n')
    let generatorCalls = 0
    const generated = await runGitAction(
      commitAction({ filePaths: ['a.txt'], commitMessage: '   ' }),
      mainCheckout,
      repo,
      baseOptions({
        generateCommitSubject: async () => {
          generatorCalls++
          return 'chore: generated subject'
        },
      }),
    )
    expect(generatorCalls).toBe(1)
    expect(generated.commit).toMatchObject({ subject: 'chore: generated subject' })

    writeFileSync(join(repo, 'a.txt'), 'a3\n')
    let generatorCalls2 = 0
    const manual = await runGitAction(
      commitAction({ filePaths: ['a.txt'], commitMessage: '  my manual subject  ' }),
      mainCheckout,
      repo,
      baseOptions({
        generateCommitSubject: async () => {
          generatorCalls2++
          return 'chore: generated subject'
        },
      }),
    )
    expect(generatorCalls2).toBe(0)
    expect(manual.commit).toMatchObject({ subject: 'my manual subject' })
  })

  test('commit and push only pushes after the selective commit succeeds, keeping the feature branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'solus-selective-commit-push-'))
    roots.push(root)
    const origin = join(root, 'origin.git')
    const local = join(root, 'local')
    mkdirSync(origin)
    git(origin, ['init', '--bare', '-q', '--initial-branch=main'])
    git(root, ['clone', '-q', origin, local])
    git(local, ['config', 'user.email', 'test@solus.local'])
    git(local, ['config', 'user.name', 'Solus Test'])
    writeFileSync(join(local, 'base.txt'), 'base\n')
    git(local, ['add', '-A'])
    git(local, ['commit', '-q', '-m', 'base'])
    git(local, ['push', '-q', '-u', 'origin', 'main'])
    git(local, ['checkout', '-q', '-b', 'feature/selective'])

    writeFileSync(join(local, 'a.txt'), 'a1\n')
    writeFileSync(join(local, 'b.txt'), 'b1\n')
    git(local, ['add', 'b.txt']) // new file staged, excluded from the selective commit

    const result = await runGitAction(
      commitAction({ action: 'commit_push', filePaths: ['a.txt'] }),
      { branch: 'feature/selective', targetBranch: 'main' },
      local,
      baseOptions(),
    )

    expect(result.commit.status).toBe('created')
    expect(result.push).toEqual({ status: 'pushed', branch: 'feature/selective' })
    expect(git(local, ['status', '--porcelain'])).toBe('A  b.txt')
    expect(git(origin, ['rev-parse', 'feature/selective'])).toBe(git(local, ['rev-parse', 'HEAD']))
  })
})
