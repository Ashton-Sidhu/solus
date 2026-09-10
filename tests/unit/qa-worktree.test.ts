import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQaWorktree } from '../../scripts/qa/worktree'

const temporaryDirectories: string[] = []
function createRepository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-qa-worktree-')))
  temporaryDirectories.push(root)
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' })
  writeFileSync(join(root, 'fixture.txt'), 'committed\n')
  execFileSync('git', ['add', 'fixture.txt'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=QA Fixture', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], { cwd: root, stdio: 'pipe' })
  return root
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('QA worktree readiness', () => {
  test('reports readiness only after setup succeeds and leaves the original checkout unchanged', () => {
    const root = createRepository()
    writeFileSync(join(root, 'fixture.txt'), 'uncommitted owner changes\n')
    writeFileSync(join(root, 'untracked.txt'), 'owner file\n')
    const before = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
    let installed = false
    const result = createQaWorktree(root, 'qa/session-flow', (worktree) => {
      expect(readFileSync(join(worktree, 'fixture.txt'), 'utf8')).toBe('committed\n')
      expect(existsSync(join(worktree, 'untracked.txt'))).toBe(false)
      expect(execFileSync('git', ['branch', '--show-current'], { cwd: worktree, encoding: 'utf8' }).trim()).toBe('qa/session-flow')
      installed = true
    })
    expect(installed).toBe(true)
    expect(result.readiness).toBe('ready')
    expect(result.worktree.startsWith(join(root, '.git/solus/worktrees') + '/')).toBe(true)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe(before)
    expect(readFileSync(join(root, 'fixture.txt'), 'utf8')).toBe('uncommitted owner changes\n')
  })

  test('retains a failed setup checkout and gives a retry without reporting ready', () => {
    const root = createRepository()
    const result = createQaWorktree(root, 'qa/setup-fails', () => { throw new Error('fixture install failed') })
    expect(result.readiness).toBe('setup_failed')
    expect(existsSync(join(result.worktree, 'fixture.txt'))).toBe(true)
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: result.worktree, encoding: 'utf8' }).trim()).toBe('qa/setup-fails')
    if (result.readiness === 'setup_failed') {
      expect(result.error).toContain('fixture install failed')
      expect(result.retryCommand).toContain(result.worktree)
      expect(result.retryCommand).toContain('bun run qa setup')
    }
  })

  test.each(['../escape', '-option', '', 'qa branch', '@{-1}'])('rejects invalid branch %s before setup', (branch) => {
    const root = createRepository()
    let called = false
    expect(() => createQaWorktree(root, branch, () => { called = true })).toThrow('Invalid QA branch')
    expect(called).toBe(false)
    expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' }).match(/^worktree /gm)?.length).toBe(1)
  })

  test('refuses an existing branch without changing its checkout', () => {
    const root = createRepository()
    expect(() => createQaWorktree(root, 'main', () => { throw new Error('must not run') })).toThrow('already exists')
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()).toBe('main')
  })

  test('rejects an ancestor symlink before creating directories or a branch', () => {
    const root = createRepository()
    const external = realpathSync(mkdtempSync(join(tmpdir(), 'solus-qa-external-')))
    temporaryDirectories.push(external)
    symlinkSync(external, join(root, '.git', 'solus'), 'dir')
    expect(() => createQaWorktree(root, 'qa/symlink', () => { throw new Error('must not run') })).toThrow('must not be a symlink')
    expect(readdirSync(external)).toEqual([])
    expect(execFileSync('git', ['branch', '--list', 'qa/symlink'], { cwd: root, encoding: 'utf8' }).trim()).toBe('')
  })

  test('resolves the common Git directory when called from a linked worktree', () => {
    const root = createRepository()
    const first = createQaWorktree(root, 'qa/first', () => {})
    const second = createQaWorktree(first.worktree, 'qa/second', () => {})
    expect(second.worktree.startsWith(join(root, '.git/solus/worktrees') + '/')).toBe(true)
    expect(second.worktree.startsWith(first.worktree + '/')).toBe(false)
  })
})
