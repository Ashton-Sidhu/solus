import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
import { git } from '@solus/server/git/exec'
import { PARTIAL_CLONE_ARGS, ensureFullHistory } from '@solus/server/git/partial-clone'
import { readPullRequestAuthoringContext } from '@solus/server/git/pull-request-authoring'
let ensureBranchWorktree: typeof import('@solus/server/git/worktree-manager')['ensureBranchWorktree']
beforeAll(async () => {
  ({ ensureBranchWorktree } = await import('@solus/server/git/worktree-manager'))
})

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'solus-dispatch-partial-'))
  directories.push(directory)
  return directory
}

function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content)
  git(['add', '-A'], repo)
  git(['commit', '-m', message], repo)
  return git(['rev-parse', 'HEAD'], repo)
}

/**
 * An origin where main and feature diverged from `fork`, and `legacy` holds a
 * file version no branch tip needs (`ancientBlob`).
 */
function origin(options: { filters: boolean } = { filters: true }) {
  const source = temporaryDirectory()
  git(['init', '-b', 'main'], source)
  git(['config', 'user.name', 'Test'], source)
  git(['config', 'user.email', 'test@example.invalid'], source)
  commit(source, { 'file.txt': 'ancient\n', 'keep.txt': 'keep\n' }, 'Ancient')
  const ancientBlob = git(['rev-parse', 'HEAD:file.txt'], source)
  git(['branch', 'legacy'], source)
  const fork = commit(source, { 'file.txt': 'base\n' }, 'Base')
  git(['checkout', '-b', 'feature'], source)
  commit(source, { 'file.txt': 'feature\n' }, 'Feature change')
  git(['checkout', 'main'], source)
  commit(source, { 'other.txt': 'main moved\n' }, 'Main moves on')
  const bare = join(temporaryDirectory(), 'origin.git')
  git(['clone', '--bare', source, bare], source)
  git(['config', 'uploadpack.allowFilter', String(options.filters)], bare)
  git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], bare)
  return { bare, fork, ancientBlob }
}

/** Cloned the way a dispatch checkout is. */
function dispatchClone(bare: string, args: readonly string[] = PARTIAL_CLONE_ARGS): string {
  const parent = temporaryDirectory()
  git(['clone', ...args, `file://${bare}`, 'checkout'], parent)
  return join(parent, 'checkout')
}

function missingObjects(checkout: string): string[] {
  return git(['rev-list', '--objects', '--all', '--missing=print'], checkout)
    .split('\n').filter((line) => line.startsWith('?')).map((line) => line.slice(1))
}

test('a dispatch checkout has full history and every branch, and fetches old file contents only when read', async () => {
  // WHY: a shallow clone of diverged branches has no merge base, so reviews
  // and PR descriptions come out empty; downloading every old file version
  // upfront is what the partial clone avoids.
  const { bare, fork, ancientBlob } = origin()
  const checkout = dispatchClone(bare)
  expect(git(['rev-parse', '--is-shallow-repository'], checkout)).toBe('false')
  expect(git(['rev-list', '--count', 'origin/feature'], checkout)).toBe('3')
  expect(git(['merge-base', 'origin/main', 'origin/feature'], checkout)).toBe(fork)
  expect(readFileSync(join(checkout, 'file.txt'), 'utf8')).toBe('base\n')
  expect(readFileSync(join(checkout, 'other.txt'), 'utf8')).toBe('main moved\n')
  expect(missingObjects(checkout)).toContain(ancientBlob)

  const feature = await ensureBranchWorktree(checkout, 'feature')
  expect(readFileSync(join(feature.worktreePath!, 'file.txt'), 'utf8')).toBe('feature\n')
  expect(git(['show', `${ancientBlob}`], checkout)).toBe('ancient')
  expect(missingObjects(checkout)).not.toContain(ancientBlob)

  const context = await readPullRequestAuthoringContext(feature.worktreePath!, 'main', 'feature', false)
  expect(context.commitSummary).toBe('Feature change')
  expect(context.diffPatch).toContain('-base')
  expect(context.diffPatch).toContain('+feature')
  expect(context.diffPatch).not.toContain('other.txt')
})

test('a file content that cannot be fetched fails the PR description instead of making it empty', async () => {
  // WHY: an empty diff reads as "no changes" and produces a wrong pull request.
  const { bare } = origin()
  const checkout = dispatchClone(bare)
  renameSync(bare, `${bare}-gone`)
  await expect(readPullRequestAuthoringContext(checkout, 'legacy', 'main', false)).rejects.toThrow()
})

test('an origin that does not filter gives a full clone, which is accepted', () => {
  const { bare, ancientBlob } = origin({ filters: false })
  const checkout = dispatchClone(bare)
  expect(git(['rev-parse', '--is-shallow-repository'], checkout)).toBe('false')
  expect(missingObjects(checkout)).not.toContain(ancientBlob)
})

test('a checkout cloned shallow before gets its full history once, and keeps its work', async () => {
  // WHY: existing dispatch checkouts were cloned with --depth=1; converting them
  // must not lose the member's uncommitted files, local commits, or HEAD.
  const { bare, fork } = origin()
  const checkout = dispatchClone(bare, ['--depth=1', '--no-single-branch'])
  git(['config', 'user.name', 'Member'], checkout)
  git(['config', 'user.email', 'member@example.invalid'], checkout)
  const localCommit = commit(checkout, { 'local.txt': 'local\n' }, 'Local work')
  writeFileSync(join(checkout, 'file.txt'), 'uncommitted\n')
  expect(git(['rev-parse', '--is-shallow-repository'], checkout)).toBe('true')

  await ensureFullHistory(checkout)
  expect(git(['rev-parse', '--is-shallow-repository'], checkout)).toBe('false')
  expect(git(['rev-parse', 'HEAD'], checkout)).toBe(localCommit)
  expect(readFileSync(join(checkout, 'file.txt'), 'utf8')).toBe('uncommitted\n')
  expect(git(['status', '--porcelain'], checkout)).toBe('M file.txt')
  expect(git(['merge-base', 'origin/main', 'origin/feature'], checkout)).toBe(fork)
  // Once full, it is not fetched again.
  renameSync(bare, `${bare}-gone`)
  await ensureFullHistory(checkout)
})

test('a failed conversion stops preparation with an error to retry, and changes nothing', async () => {
  const { bare } = origin()
  const checkout = dispatchClone(bare, ['--depth=1', '--no-single-branch'])
  const head = git(['rev-parse', 'HEAD'], checkout)
  renameSync(bare, `${bare}-gone`)
  await expect(ensureFullHistory(checkout)).rejects.toThrow('Try again')
  expect(git(['rev-parse', '--is-shallow-repository'], checkout)).toBe('true')
  expect(git(['rev-parse', 'HEAD'], checkout)).toBe(head)
  expect(existsSync(join(checkout, 'file.txt'))).toBe(true)
})

test('the branch the dispatch checkout holds is worked on there, never detached', async () => {
  // WHY: sessions work directly in the checkout; detaching it would move
  // HEAD under a running session.
  const { bare } = origin()
  const checkout = dispatchClone(bare)
  const main = await ensureBranchWorktree(checkout, 'main')
  expect(main.worktreePath).toBeUndefined()
  expect(main.repoRoot).toBe(checkout)
  expect(git(['branch', '--show-current'], checkout)).toBe('main')
})
