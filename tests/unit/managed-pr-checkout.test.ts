import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureManagedPrCheckout, managedPrCheckoutPath } from '@solus/server/review/managed-pr-checkout'
import { readGuideFileContentsAt, readGuidePatchAt } from '@solus/server/review/pr-guide-diff'
import type { PrDiffFileContentsRequest } from '@solus/contracts/providers'
import { reviewGuidePath, writeJsonAtomic } from '@solus/server/review/review-store'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

const temporaryDirectories: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

describe('managed pull-request checkout', () => {
  test('creates an exact full-history partial checkout under a path-safe review identity', async () => {
    // WHY: a review needs merge bases, so history is never cut; but old file
    // contents are not downloaded until something reads them.
    const fixture = mkdtempSync(join(tmpdir(), 'solus-managed-pr-'))
    temporaryDirectories.push(fixture)
    const source = join(fixture, 'source')
    const remote = join(fixture, 'remote.git')
    const checkouts = join(fixture, 'checkouts')

    git(fixture, ['init', '--initial-branch=main', source])
    git(source, ['config', 'user.name', 'Solus Test'])
    git(source, ['config', 'user.email', 'solus@example.com'])
    // A file version that neither side of the review holds.
    writeFileSync(join(source, 'old.txt'), 'ancient\n')
    git(source, ['add', 'old.txt'])
    git(source, ['commit', '-m', 'ancient'])
    const oldBlob = git(source, ['rev-parse', 'HEAD:old.txt'])
    writeFileSync(join(source, 'old.txt'), 'current\n')
    writeFileSync(join(source, 'change.txt'), 'base\n')
    git(source, ['add', 'old.txt', 'change.txt'])
    git(source, ['commit', '-m', 'base'])
    const baseSha = git(source, ['rev-parse', 'HEAD'])
    writeFileSync(join(source, 'change.txt'), 'head\n')
    git(source, ['commit', '-am', 'head'])
    const headSha = git(source, ['rev-parse', 'HEAD'])

    git(fixture, ['init', '--bare', '--initial-branch=main', remote])
    git(remote, ['config', 'uploadpack.allowFilter', 'true'])
    git(remote, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
    git(source, ['remote', 'add', 'origin', remote])
    git(source, ['push', 'origin', 'main'])
    git(source, ['push', 'origin', `${baseSha}:refs/heads/review-base`])
    git(source, ['push', 'origin', `${headSha}:refs/pull/25/head`])

    const repo = { host: 'github.com', owner: '../Ashton-Sidhu', repo: 'plotly-graph' }
    const target = { kind: 'pr' as const, host: repo.host, owner: repo.owner, repo: repo.repo, number: 25, baseSha, headSha }
    const checkout = await ensureManagedPrCheckout(repo, target, {
      root: checkouts,
      cloneUrl: `file://${remote}`,
    })

    expect(checkout.baseSha).toBe(baseSha)
    expect(checkout.headSha).toBe(headSha)
    expect(git(checkout.worktreePath, ['rev-parse', '--is-shallow-repository'])).toBe('false')
    expect(existsSync(join(checkout.worktreePath, '.git', 'shallow'))).toBe(false)
    expect(git(checkout.worktreePath, ['rev-parse', 'HEAD'])).toBe(headSha)
    expect(git(checkout.worktreePath, ['rev-list', '--count', headSha])).toBe('3')
    expect(git(checkout.worktreePath, ['merge-base', baseSha, headSha])).toBe(baseSha)
    const missing = git(checkout.worktreePath, ['rev-list', '--objects', '--all', '--missing=print'])
    expect(missing.split('\n')).toContain(`?${oldBlob}`)
    expect(managedPrCheckoutPath(repo, target, checkouts).startsWith(`${checkouts}/`)).toBe(true)

    const guideStorageRoot = join(fixture, 'review-guides')
    const patchBeforeGuide = git(checkout.worktreePath, ['diff', baseSha])
    const statusBeforeGuide = git(checkout.worktreePath, ['status', '--short', '--untracked-files=all'])
    const guide = {
      version: 1 as const,
      key: 'pr-github.com-Ashton-Sidhu-plotly-graph-25',
      headSha,
      baseSha,
      changeFingerprint: 'fingerprint',
      generatedAt: new Date().toISOString(),
      title: 'Dependency update',
      summary: 'Reviews the pull request without changing its checkout.',
      sections: [],
    }
    const storedGuidePath = reviewGuidePath(checkout.worktreePath, guide.key, guideStorageRoot)
    expect(await writeJsonAtomic(storedGuidePath, guide, 'test guide')).toBe(true)
    expect(existsSync(storedGuidePath)).toBe(true)
    expect(existsSync(join(checkout.worktreePath, '.solus', 'review', `${guide.key}.json`))).toBe(false)
    expect(git(checkout.worktreePath, ['diff', baseSha])).toBe(patchBeforeGuide)
    expect(git(checkout.worktreePath, ['status', '--short', '--untracked-files=all'])).toBe(statusBeforeGuide)

    const legacyGuideDirectory = join(checkout.worktreePath, '.solus', 'review')
    mkdirSync(legacyGuideDirectory, { recursive: true })
    writeFileSync(join(legacyGuideDirectory, 'old-guide.json'), '{}')

    // What a guide reads was fetched with the checkout: it needs no remote or credential later.
    const remoteMoved = `${remote}-moved`
    execFileSync('mv', [remote, remoteMoved])
    const guideRevision = { number: 25, baseSha, headSha }
    expect((await readGuidePatchAt(checkout.worktreePath, guideRevision)).patch).toContain('+head')
    const fileRequest: PrDiffFileContentsRequest = { ...guideRevision, changeType: 'change', oldPath: 'change.txt', newPath: 'change.txt' }
    expect(await readGuideFileContentsAt(checkout.worktreePath, fileRequest)).toEqual({ oldContents: 'base\n', newContents: 'head\n' })
    execFileSync('mv', [remoteMoved, remote])

    const reused = await ensureManagedPrCheckout(repo, target, {
      root: checkouts,
      cloneUrl: `file://${remote}`,
    })
    expect(reused).toEqual(checkout)
    expect(existsSync(legacyGuideDirectory)).toBe(false)
  })
})
