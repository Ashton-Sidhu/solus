import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fetchAndCheckoutPr } from '../../src/main/git/worktree-manager'

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

    const result = await fetchAndCheckoutPr(project, 40, 'main')

    expect(result.worktreePath).toBe(worktreePath)
    expect(result.branch).toBe('solus/pr-40')
    expect(result.headSha).toBe(git(project, ['rev-parse', 'HEAD']))
    expect(existsSync(worktreePath)).toBe(true)
  })
})
