import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'

// bun has no node:sqlite; the ledger's import chain reaches the metrics db.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let resolveReviewContext: typeof import('@solus/server/review/ledger')['resolveReviewContext']

beforeAll(async () => {
  ;({ resolveReviewContext } = await import('@solus/server/review/ledger'))
})

const repos: string[] = []

afterEach(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true })
  repos.length = 0
})

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

/**
 * A repository that looks exactly like one whose pull request the old code went
 * and asked GitHub about: a real `origin` on github.com, and a branch off the
 * default. `origin/HEAD` is set locally so resolving the default branch never
 * reaches `ls-remote` either.
 */
function createRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'solus-review-context-'))
  repos.push(cwd)
  git(cwd, ['init', '--initial-branch=main'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test'])
  writeFileSync(join(cwd, 'tracked.txt'), 'first\n')
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', 'base'])
  const baseSha = git(cwd, ['rev-parse', 'HEAD'])

  git(cwd, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
  git(cwd, ['update-ref', 'refs/remotes/origin/main', baseSha])
  git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])

  git(cwd, ['checkout', '-b', 'feat/reviews'])
  writeFileSync(join(cwd, 'tracked.txt'), 'first\nsecond\n')
  git(cwd, ['commit', '-am', 'work'])
  return { cwd, baseSha, headSha: git(cwd, ['rev-parse', 'HEAD']) }
}

describe('review context', () => {
  test('resolves the branch and its base from local git alone', async () => {
    // WHY: this is what the review pane's diff base waits on, so every await in
    // it sits between the click and the first painted hunk. It must resolve the
    // comparison and nothing else — no provider read, no `gh`, no network.
    const { cwd, baseSha, headSha } = createRepo()

    const context = await resolveReviewContext(cwd, null)

    expect(context).not.toBeNull()
    expect(context?.branch).toBe('feat/reviews')
    expect(context?.targetBranch).toBe('main')
    expect(context?.baseSha).toBe(baseSha)
    expect(context?.headSha).toBe(headSha)
    expect(context?.key).toBe('feat__reviews')
  })

  test('never asks a code host which pull request the branch has', () => {
    // WHY: the branch's pull request is already reported by the Git status, and
    // a second opinion cost this path a full provider round trip. If a caller
    // needs it again, it belongs beside that status — not in front of the diff.
    const ledger = readFileSync(
      join(import.meta.dir, '../../packages/server/src/review/ledger.ts'),
      'utf8',
    )
    expect(ledger).not.toContain('getExistingPR')
    expect(ledger).not.toContain('providerForRepo')
  })
})
