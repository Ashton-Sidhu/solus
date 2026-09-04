import { afterEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { fetchPrHead } = await import('@solus/server/git/worktree-manager')

const temporaryDirectories: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('pull-request checkout fetch', () => {
  test('uses the durable pull ref after a same-repository branch is deleted', async () => {
    // WHY: GitHub keeps refs/pull/<number>/head after merge, but the source
    // branch can be deleted before a user opens the merged pull request.
    const fixture = mkdtempSync(join(tmpdir(), 'solus-pr-fetch-'))
    temporaryDirectories.push(fixture)
    const source = join(fixture, 'source')
    const remote = join(fixture, 'remote.git')
    const checkout = join(fixture, 'checkout')

    git(fixture, ['init', '--initial-branch=main', source])
    git(source, ['config', 'user.name', 'Solus Test'])
    git(source, ['config', 'user.email', 'solus@example.com'])
    writeFileSync(join(source, 'change.txt'), 'change\n')
    git(source, ['add', 'change.txt'])
    git(source, ['commit', '-m', 'change'])
    const headSha = git(source, ['rev-parse', 'HEAD'])

    git(fixture, ['init', '--bare', '--initial-branch=main', remote])
    git(source, ['remote', 'add', 'origin', remote])
    git(source, ['push', 'origin', `${headSha}:refs/heads/main`])
    git(source, ['push', 'origin', `${headSha}:refs/pull/1/head`])
    git(fixture, ['clone', remote, checkout])

    await expect(fetchPrHead(checkout, 1, {
      headRef: 'solus/deleted-after-merge',
      isFork: false,
    })).resolves.toEqual({ branch: 'solus/deleted-after-merge', headSha })
  })
})
