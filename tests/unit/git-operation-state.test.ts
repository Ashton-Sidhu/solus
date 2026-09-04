import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isGitOperationInProgress } from '@solus/server/git/git-operation-state'

const repositories: string[] = []

afterEach(() => {
  for (const repository of repositories.splice(0)) rmSync(repository, { recursive: true, force: true })
})

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'solus-git-operation-'))
  repositories.push(cwd)
  execFileSync('git', ['init', '-b', 'main'], { cwd })
  execFileSync('git', ['config', 'user.email', 'tests@solus.local'], { cwd })
  execFileSync('git', ['config', 'user.name', 'Solus Tests'], { cwd })
  writeFileSync(join(cwd, 'tracked.txt'), 'initial\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd })
  return cwd
}

describe('Git operation state', () => {
  test('ignores REBASE_HEAD after Git has finished the rebase', async () => {
    // WHY: Git can retain REBASE_HEAD after rebase --continue finishes. The
    // project panel must not show a conflict when Git reports a clean tree.
    const cwd = repository()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    writeFileSync(join(cwd, '.git', 'REBASE_HEAD'), `${head}\n`)

    expect(await isGitOperationInProgress(cwd)).toBe(false)
  })

  test('reports the directory Git uses for an active rebase', async () => {
    const cwd = repository()
    mkdirSync(join(cwd, '.git', 'rebase-merge'))

    expect(await isGitOperationInProgress(cwd)).toBe(true)
  })
})
