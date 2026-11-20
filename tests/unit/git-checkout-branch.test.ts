import { afterEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { checkoutBranch } = await import('@solus/server/git/checkout-branch')
const { listBranchRefs } = await import('@solus/server/git/worktree-manager')

/**
 * The branch picker of a new session's current checkout (T3's
 * checkoutNewTaskBranch, on the host). Every repository here is a fixture
 * this test makes and removes; no real project changes branch.
 */

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

actAsHostForTests()

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function commit(cwd: string, file: string, text: string): void {
  writeFileSync(join(cwd, file), text)
  git(cwd, ['add', file])
  git(cwd, ['commit', '-m', text])
}

/** A repository on main with a bare origin, a local branch, and a branch on origin only. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-checkout-branch-')))
  temporaryDirectories.push(root)
  const repo = join(root, 'repo')
  const origin = join(root, 'origin.git')
  git(root, ['init', '--initial-branch=main', repo])
  git(root, ['init', '--bare', '--initial-branch=main', origin])
  git(repo, ['config', 'user.name', 'Solus Test'])
  git(repo, ['config', 'user.email', 'solus@example.com'])
  git(repo, ['remote', 'add', 'origin', origin])
  commit(repo, 'file.txt', 'base\n')
  git(repo, ['branch', 'local-feature'])
  git(repo, ['switch', '--create', 'remote-feature'])
  commit(repo, 'remote.txt', 'remote\n')
  git(repo, ['push', 'origin', 'remote-feature'])
  git(repo, ['switch', 'main'])
  git(repo, ['branch', '-D', 'remote-feature'])
  const head = () => git(repo, ['branch', '--show-current'])
  return { root, repo, origin, head }
}

describe('the branch list of a checkout', () => {
  test('names the branch the checkout is on, and the branches other worktrees have', async () => {
    // WHY: the picker badges (T3's current and worktree) come from these
    // facts, read in the checkout the list is for.
    const { root, repo } = fixture()
    const other = join(root, 'other')
    git(repo, ['worktree', 'add', other, 'local-feature'])
    const byName = (refs: Awaited<ReturnType<typeof listBranchRefs>>) => Object.fromEntries(refs.map((ref) => [ref.name, { current: ref.current, worktreePath: ref.worktreePath, remoteOnly: ref.remoteOnly }]))
    expect(byName(await listBranchRefs(repo))).toEqual({
      main: { current: true, worktreePath: undefined, remoteOnly: false },
      'local-feature': { current: false, worktreePath: other, remoteOnly: false },
      'remote-feature': { current: false, worktreePath: undefined, remoteOnly: true },
    })
    expect(byName(await listBranchRefs(other))).toMatchObject({
      main: { current: false, worktreePath: repo },
      'local-feature': { current: true, worktreePath: undefined },
    })
  })
})

describe('a branch picked for the current checkout', () => {
  test('the branch the checkout is on changes nothing', async () => {
    const { repo, head } = fixture()
    expect(await checkoutBranch(repo, 'main')).toEqual({ kind: 'current', workingDirectory: repo })
    expect(head()).toBe('main')
  })

  test('a local branch moves the checkout to it', async () => {
    const { repo, head } = fixture()
    expect(await checkoutBranch(repo, 'local-feature')).toEqual({ kind: 'switched', workingDirectory: repo })
    expect(head()).toBe('local-feature')
  })

  test('a branch on the remote only becomes a local branch that tracks it', async () => {
    // WHY: the person picked origin's branch. A local branch with no upstream
    // would push and pull somewhere the person did not choose.
    const { repo, head } = fixture()
    expect(await checkoutBranch(repo, 'remote-feature', { remoteOnly: true })).toEqual({ kind: 'switched', workingDirectory: repo })
    expect(head()).toBe('remote-feature')
    expect(git(repo, ['rev-parse', '--symbolic-full-name', 'remote-feature@{upstream}'])).toBe('refs/remotes/origin/remote-feature')
  })

  test('a remote branch never checks out a local branch of that name that tracks something else', async () => {
    // WHY: the list said remote-only, but a local branch of the same name
    // appeared since. It holds other work; switching to it would put the
    // session on commits the person did not pick.
    const { repo, head } = fixture()
    git(repo, ['branch', 'remote-feature', 'main'])
    const choice = await checkoutBranch(repo, 'remote-feature', { remoteOnly: true })
    expect(choice.kind).toBe('refused')
    expect(head()).toBe('main')
    expect(git(repo, ['rev-parse', 'remote-feature'])).toBe(git(repo, ['rev-parse', 'main']))
  })

  test('a branch in another worktree names that worktree, and the checkout stays where it is', async () => {
    // WHY: git cannot check one branch out twice. The work belongs in the
    // worktree that already has the branch, as T3 reuses it.
    const { root, repo, head } = fixture()
    const other = join(root, 'other')
    git(repo, ['worktree', 'add', other, 'local-feature'])
    expect(await checkoutBranch(repo, 'local-feature')).toEqual({ kind: 'worktree', workingDirectory: other })
    expect(head()).toBe('main')
  })

  test('the main checkout is a worktree too, from a linked worktree project', async () => {
    const { root, repo } = fixture()
    const linked = join(root, 'linked')
    git(repo, ['worktree', 'add', linked, 'local-feature'])
    expect(await checkoutBranch(linked, 'main')).toEqual({ kind: 'worktree', workingDirectory: repo })
    expect(git(linked, ['branch', '--show-current'])).toBe('local-feature')
  })

  test('a tracking branch picked from the remote reuses the worktree that has it', async () => {
    const { root, repo } = fixture()
    const other = join(root, 'other')
    git(repo, ['worktree', 'add', '--track', '-b', 'remote-feature', other, 'origin/remote-feature'])
    expect(await checkoutBranch(repo, 'remote-feature', { remoteOnly: true })).toEqual({ kind: 'worktree', workingDirectory: other })
  })

  test('a project inside a repository never reuses another worktree', async () => {
    // WHY: the session would start at the other worktree's root, not in the
    // folder the project names.
    const { root, repo, head } = fixture()
    git(repo, ['worktree', 'add', join(root, 'other'), 'local-feature'])
    const folder = join(repo, 'packages')
    mkdirSync(folder)
    const choice = await checkoutBranch(folder, 'local-feature')
    expect(choice.kind).toBe('refused')
    expect(head()).toBe('main')
  })

  test('a worktree deleted outside git is refused, not offered', async () => {
    const { root, repo, head } = fixture()
    const other = join(root, 'other')
    git(repo, ['worktree', 'add', other, 'local-feature'])
    rmSync(other, { recursive: true, force: true })
    const choice = await checkoutBranch(repo, 'local-feature')
    expect(choice.kind).toBe('refused')
    expect(head()).toBe('main')
  })

  test('uncommitted changes stay: a switch that would overwrite them fails', async () => {
    const { repo, head } = fixture()
    git(repo, ['switch', 'local-feature'])
    commit(repo, 'file.txt', 'feature\n')
    git(repo, ['switch', 'main'])
    writeFileSync(join(repo, 'file.txt'), 'unsaved\n')
    await expect(checkoutBranch(repo, 'local-feature')).rejects.toThrow()
    expect(head()).toBe('main')
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('unsaved\n')
  })

  test('a name that is no branch, or reads as an option, is refused', async () => {
    const { repo, head } = fixture()
    expect((await checkoutBranch(repo, 'missing')).kind).toBe('refused')
    expect((await checkoutBranch(repo, '--orphan')).kind).toBe('refused')
    expect((await checkoutBranch(repo, '')).kind).toBe('refused')
    expect(head()).toBe('main')
  })

  test('a branch on several remotes, none of them origin, is refused', async () => {
    const { root, repo, origin, head } = fixture()
    git(repo, ['remote', 'rename', 'origin', 'upstream'])
    const fork = join(root, 'fork.git')
    git(root, ['clone', '--bare', origin, fork])
    git(repo, ['remote', 'add', 'fork', fork])
    git(repo, ['fetch', 'fork'])
    const choice = await checkoutBranch(repo, 'remote-feature', { remoteOnly: true })
    expect(choice.kind).toBe('refused')
    expect(head()).toBe('main')
  })
})
