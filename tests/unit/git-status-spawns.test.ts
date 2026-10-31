import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Status refreshes run on every watcher fire and completed edit, so each git
// process they start is paid many times. These tests count the processes.
mock.module('node:sqlite', () => ({ DatabaseSync }))
const gitAvailability = await import('@solus/server/git/git-availability')
mock.module('@solus/server/git/git-availability', () => ({ ...gitAvailability, isGitUsable: () => true }))
const { git } = await import('@solus/server/git/exec')
const { useGitCommandMeter } = await import('@solus/server/git/git-metrics')
const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')
actAsHostForTests()

let CheckoutService: typeof import('@solus/server/git/checkout-service')['CheckoutService']
let GitWatcher: typeof import('@solus/server/git/git-watcher')['GitWatcher']
let computeGitState: typeof import('@solus/server/git/git-helpers')['computeGitState']
let getDefaultBranchLocal: typeof import('@solus/server/git/worktree-manager')['getDefaultBranchLocal']

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'solus-git-status-spawns-')))
const repo = join(directory, 'repo')
const linked = join(directory, 'linked')
const previousDataDir = process.env.SOLUS_DATA_DIR
const realNow = Date.now

let spawned: string[] = []
function countSpawns(): void {
  spawned = []
  useGitCommandMeter(({ operation }) => { spawned.push(operation) })
}

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = join(directory, 'data')
  ;({ CheckoutService } = await import('@solus/server/git/checkout-service'))
  ;({ GitWatcher } = await import('@solus/server/git/git-watcher'))
  ;({ computeGitState } = await import('@solus/server/git/git-helpers'))
  ;({ getDefaultBranchLocal } = await import('@solus/server/git/worktree-manager'))
  git(['init', '-b', 'main', repo], directory)
  git(['config', 'user.name', 'Test'], repo)
  git(['config', 'user.email', 'test@example.invalid'], repo)
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(['add', 'a.txt'], repo)
  git(['commit', '-m', 'Initial'], repo)
  git(['worktree', 'add', '-b', 'feature', linked], repo)
  writeFileSync(join(linked, 'a.txt'), 'one\ntwo\n')
  git(['commit', '-am', 'Second line'], linked)
  writeFileSync(join(linked, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(linked, 'new.txt'), 'x\ny\n')
})
afterEach(() => {
  useGitCommandMeter(null)
  Date.now = realNow
})
afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

test('a checkout refresh reads identity and top level in one rev-parse, and the default-branch fallback once', async () => {
  const service = new CheckoutService(() => false)
  try {
    countSpawns()
    const main = await service.refresh(repo)
    // First read: identity, operation state, and the local default-branch
    // fallback (`origin/HEAD` is missing, then `main` is verified).
    expect(spawned.sort()).toEqual(['rev-parse', 'rev-parse', 'rev-parse', 'status', 'symbolic-ref'])
    expect(main.checkout?.branch).toBe('main')
    expect(main.checkout?.targetBranch).toBe('main')
    // The main checkout's top level is the repository: it is not a worktree.
    expect(main.checkout?.worktreePath).toBeUndefined()

    countSpawns()
    await service.refresh(repo)
    // The fallback is cached, so only the identity and operation-state reads remain.
    expect(spawned.sort()).toEqual(['rev-parse', 'rev-parse', 'status'])

    const worktree = await service.refresh(linked)
    expect(worktree.checkout).toMatchObject({ branch: 'feature', targetBranch: 'main', repoRoot: repo, worktreePath: linked })
  } finally { service.dispose() }
})

test('the default-branch fallback follows origin/HEAD once the cached answer expires', async () => {
  const fresh = join(directory, 'fallback')
  git(['init', '-b', 'main', fresh], directory)
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Initial'], fresh)
  countSpawns()
  expect(await getDefaultBranchLocal(fresh)).toBe('main')
  expect(await getDefaultBranchLocal(fresh)).toBe('main')
  expect(spawned).toEqual(['symbolic-ref', 'rev-parse'])

  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'], fresh)
  Date.now = () => realNow() + 60_000
  expect(await getDefaultBranchLocal(fresh)).toBe('trunk')
})

test('branch changes count committed, uncommitted and untracked work against the merge base', async () => {
  const status = await computeGitState(linked, { includeDetails: true })
  // a.txt gained two lines since main (one committed, one not); new.txt is untracked.
  expect(status?.branchChanges).toEqual({ fileCount: 2, insertions: 4, deletions: 0 })
  expect(status?.targetAheadCount).toBe(1)
})

test('the watcher resolves a linked worktree with one rev-parse', async () => {
  const watcher = new GitWatcher(() => {})
  countSpawns()
  const paths = await watcher['_resolveGitPaths'](linked)
  expect(spawned).toEqual(['rev-parse'])
  expect(paths).toEqual({
    commonDir: join(repo, '.git'),
    headPath: join(repo, '.git', 'worktrees', 'linked', 'HEAD'),
    indexPath: join(repo, '.git', 'worktrees', 'linked', 'index'),
  })
  watcher.dispose()
})
