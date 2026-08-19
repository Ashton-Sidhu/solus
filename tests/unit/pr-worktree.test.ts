import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fetchAndCheckoutPr } from '@solus/server/git/worktree-manager'

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

describe('fetchAndCheckoutPr', () => {
  test('reuses the deterministic PR directory when it already exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'solus-pr-worktree-'))
    roots.push(root)
    const origin = join(root, 'origin.git')
    const project = join(root, 'project')
    const worktreePath = join(project, '.solus-worktrees', 'pr-40')

    mkdirSync(origin)
    git(origin, ['init', '--bare', '--initial-branch=main'])
    git(root, ['clone', origin, project])
    git(project, ['config', 'user.email', 'test@solus.local'])
    git(project, ['config', 'user.name', 'Solus Test'])
    writeFileSync(join(project, 'base.txt'), 'base\n')
    git(project, ['add', 'base.txt'])
    git(project, ['commit', '-m', 'base'])
    git(project, ['push', '-u', 'origin', 'main'])
    git(origin, ['update-ref', 'refs/pull/40/head', git(project, ['rev-parse', 'HEAD'])])

    mkdirSync(join(project, '.solus-worktrees'), { recursive: true })
    git(root, ['clone', origin, worktreePath])
    git(worktreePath, ['checkout', '-b', 'solus/pr-40'])

    const source = { headRef: 'contributor/change', isFork: true }
    const result = await fetchAndCheckoutPr(project, 40, 'main', source)

    expect(result.worktreePath).toBe(worktreePath)
    expect(result.branch).toBe('solus/pr-40')
    expect(result.headSha).toBe(git(project, ['rev-parse', 'HEAD']))
    expect(existsSync(worktreePath)).toBe(true)

    // WHY: lazy checkout can run after an agent edited this deterministic PR
    // worktree. Local work is now the source of truth, so refresh must reuse it
    // without synchronizing or blocking the conversation.
    writeFileSync(join(worktreePath, 'base.txt'), 'local agent work\n')
    const dirtyResult = await fetchAndCheckoutPr(project, 40, 'main', source)
    expect(dirtyResult.worktreePath).toBe(worktreePath)
    expect(readFileSync(join(worktreePath, 'base.txt'), 'utf8')).toBe('local agent work\n')

    git(worktreePath, ['add', 'base.txt'])
    git(worktreePath, ['config', 'user.email', 'test@solus.local'])
    git(worktreePath, ['config', 'user.name', 'Solus Test'])
    git(worktreePath, ['commit', '-m', 'local follow-up'])
    const localHead = git(worktreePath, ['rev-parse', 'HEAD'])
    const advancedResult = await fetchAndCheckoutPr(project, 40, 'main', source)
    expect(advancedResult.worktreePath).toBe(worktreePath)
    expect(git(worktreePath, ['rev-parse', 'HEAD'])).toBe(localHead)
  })

  test('checks out the real head branch for a same-repository PR', async () => {
    const root = mkdtempSync(join(tmpdir(), 'solus-pr-head-'))
    roots.push(root)
    const origin = join(root, 'origin.git')
    const project = join(root, 'project')

    mkdirSync(origin)
    git(origin, ['init', '--bare', '--initial-branch=main'])
    git(root, ['clone', origin, project])
    git(project, ['config', 'user.email', 'test@solus.local'])
    git(project, ['config', 'user.name', 'Solus Test'])
    writeFileSync(join(project, 'base.txt'), 'base\n')
    git(project, ['add', 'base.txt'])
    git(project, ['commit', '-m', 'base'])
    git(project, ['push', '-u', 'origin', 'main'])
    git(project, ['checkout', '-b', 'feature/pr-head'])
    writeFileSync(join(project, 'feature.txt'), 'feature\n')
    git(project, ['add', 'feature.txt'])
    git(project, ['commit', '-m', 'feature'])
    git(project, ['push', '-u', 'origin', 'feature/pr-head'])
    const headSha = git(project, ['rev-parse', 'HEAD'])
    git(origin, ['update-ref', 'refs/pull/41/head', headSha])
    git(project, ['checkout', 'main'])

    const result = await fetchAndCheckoutPr(project, 41, 'main', {
      headRef: 'feature/pr-head',
      isFork: false,
    })

    expect(result.branch).toBe('feature/pr-head')
    expect(result.worktreePath).toBe(join(project, '.solus-worktrees', 'pr-41'))
    expect(git(result.worktreePath, ['branch', '--show-current'])).toBe('feature/pr-head')
    expect(result.headSha).toBe(headSha)
  })

  test('reuses the checkout that already holds the PR head branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'solus-pr-source-'))
    roots.push(root)
    const origin = join(root, 'origin.git')
    const project = join(root, 'project')

    mkdirSync(origin)
    git(origin, ['init', '--bare', '--initial-branch=main'])
    git(root, ['clone', origin, project])
    git(project, ['config', 'user.email', 'test@solus.local'])
    git(project, ['config', 'user.name', 'Solus Test'])
    writeFileSync(join(project, 'base.txt'), 'base\n')
    git(project, ['add', 'base.txt'])
    git(project, ['commit', '-m', 'base'])
    git(project, ['push', '-u', 'origin', 'main'])
    git(project, ['checkout', '-b', 'feature/already-open'])
    writeFileSync(join(project, 'feature.txt'), 'feature\n')
    git(project, ['add', 'feature.txt'])
    git(project, ['commit', '-m', 'feature'])
    git(project, ['push', '-u', 'origin', 'feature/already-open'])
    const headSha = git(project, ['rev-parse', 'HEAD'])
    git(origin, ['update-ref', 'refs/pull/42/head', headSha])

    const result = await fetchAndCheckoutPr(project, 42, 'main', {
      headRef: 'feature/already-open',
      isFork: false,
    })

    expect(result.branch).toBe('feature/already-open')
    expect(result.worktreePath).toBe(git(project, ['rev-parse', '--show-toplevel']))
    expect(result.reused).toBe(true)
    expect(existsSync(join(project, '.solus-worktrees', 'pr-42'))).toBe(false)

    writeFileSync(join(project, 'feature.txt'), 'unfinished follow-up\n')
    const dirtyResult = await fetchAndCheckoutPr(project, 42, 'main', {
      headRef: 'feature/already-open',
      isFork: false,
    })
    expect(dirtyResult.branch).toBe('feature/already-open')
    expect(readFileSync(join(project, 'feature.txt'), 'utf8')).toBe('unfinished follow-up\n')
  })
})
