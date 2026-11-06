import { afterEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { GitCheckout } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')
const { discardChanges } = await import('@solus/server/git/worktree-manager')

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** Discard says it threw the work away, so nothing an agent wrote may stay. */
describe('discardChanges', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  function repository(): string {
    const root = mkdtempSync(join(tmpdir(), 'solus-discard-'))
    roots.push(root)
    git(root, 'init', '-q')
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
    writeFileSync(join(root, '.gitignore'), 'build/\n')
    git(root, 'add', '.')
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'ignore build')
    return root
  }
  const discard = (cwd: string) => discardChanges({ worktreePath: cwd } as GitCheckout, cwd)

  test('removes the files that a new .gitignore hid', async () => {
    const root = repository()
    mkdirSync(join(root, 'web'))
    writeFileSync(join(root, 'web', '.gitignore'), '.env\n')
    writeFileSync(join(root, 'web', '.env'), 'SECRET=1\n')

    const result = await discard(root)

    expect(result.success).toBe(true)
    expect(existsSync(join(root, 'web'))).toBe(false)
  })

  test('keeps ignored files and a nested repository', async () => {
    // WHY: `clean` stays off -x, and it never enters a nested repository. A loop
    // that reads "something is left" as "keep going" must not fail on either.
    const root = repository()
    mkdirSync(join(root, 'build'))
    writeFileSync(join(root, 'build', 'out.js'), 'x\n')
    mkdirSync(join(root, 'nested'))
    git(join(root, 'nested'), 'init', '-q')
    writeFileSync(join(root, 'nested', 'file.txt'), 'x\n')
    writeFileSync(join(root, 'stray.txt'), 'x\n')

    const result = await discard(root)

    expect(result.success).toBe(true)
    expect(readFileSync(join(root, 'build', 'out.js'), 'utf8')).toBe('x\n')
    expect(existsSync(join(root, 'nested', 'file.txt'))).toBe(true)
    expect(existsSync(join(root, 'stray.txt'))).toBe(false)
  })
})
