import { afterEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitCheckout, GitCheckoutBranchResult, IpcContext } from '@solus/contracts/types'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { registerWorktreeHandlers, workTreeForCtx } = await import('@solus/server/transport/handlers/worktree-handlers')
type Deps = Parameters<typeof registerWorktreeHandlers>[1]
type Server = Parameters<typeof registerWorktreeHandlers>[0]

actAsHostForTests()
const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const contextFor = (session: Partial<IpcContext['session']>) => ({ session }) as IpcContext

describe('the checkout of a diff request', () => {
  test('is known without asking git, so a file load spawns nothing for it', () => {
    // WHY: a large diff loads each file with its own request. Reading the
    // branch for each one cost two spawns, and no caller used the branch.
    expect(workTreeForCtx(contextFor({ workingDirectory: '/no/such/checkout', gitContext: null }))).toBe('/no/such/checkout')
  })

  test('is the worktree the client names, not the folder the session started in', () => {
    // WHY: a session in a worktree must diff that worktree, not the project.
    const gitContext = { branch: 'fix', targetBranch: 'main', worktreePath: '/work/fix' }
    expect(workTreeForCtx(contextFor({ workingDirectory: '/work/project', gitContext }))).toBe('/work/fix')
  })
})

describe('a branch switch that the host answers with another worktree', () => {
  /** The handler on a fixture repository: `main` here, `fix` in another worktree. */
  function handler() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-checkout-handler-')))
    temporaryDirectories.push(root)
    const repo = join(root, 'repo')
    const other = join(root, 'other')
    const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git(root, ['init', '--initial-branch=main', repo])
    git(repo, ['config', 'user.name', 'Solus Test'])
    git(repo, ['config', 'user.email', 'solus@example.com'])
    writeFileSync(join(repo, 'file.txt'), 'base\n')
    git(repo, ['add', 'file.txt'])
    git(repo, ['commit', '-m', 'base'])
    git(repo, ['branch', 'other-work'])
    git(repo, ['worktree', 'add', other, '-b', 'fix'])
    const bound: Array<[string, string]> = []
    const handlers = new Map<string, (args: unknown[], ctx: unknown) => Promise<GitCheckoutBranchResult>>()
    const server = { register: (method: string, run: (args: unknown[], ctx: unknown) => Promise<GitCheckoutBranchResult>) => { handlers.set(method, run) } }
    const checkoutOf = (cwd: string): GitCheckout => cwd === other
      ? { branch: 'fix', targetBranch: 'main', repoRoot: repo, worktreePath: other }
      : { branch: git(cwd, ['branch', '--show-current']), targetBranch: 'main', repoRoot: repo }
    const sessionRuntime = {
      checkouts: { refresh: async (cwd: string) => ({ checkout: checkoutOf(cwd) }) },
      sessionCheckouts: { sessionCheckoutPaths: new Map<string, string>(), setSessionGitEnvironment: (sessionId: string, cwd: string) => { bound.push([sessionId, cwd]) } },
      // The session on screen has no folder besides its working directory.
      sessionFolders: { read: async () => [] },
    }
    // SAFETY: the handler under test reads only `checkouts.refresh`, the session's checkout path and folders, and `setSessionGitEnvironment`.
    registerWorktreeHandlers(server as unknown as Server, { sessionRuntime } as unknown as Deps)
    const checkout = (branch: string) => handlers.get('gitCheckoutBranch')!([contextFor({ sessionId: 'on-screen', workingDirectory: repo }), branch, undefined], { actor: null })
    return { repo, other, bound, checkout, head: () => git(repo, ['branch', '--show-current']) }
  }

  test('names that worktree and leaves the started session on screen where it is', async () => {
    // WHY: desktop sends the active tab's session with a branch switch. When a
    // stale list leads to a branch in another worktree, the caller opens or
    // moves its own run there; the conversation on screen must not start its
    // next turn in that worktree.
    const { other, bound, checkout, head } = handler()
    const result = await checkout('fix')
    expect(result).toMatchObject({ success: true, workingDirectory: other, gitContext: { branch: 'fix', worktreePath: other } })
    expect(bound).toEqual([])
    expect(head()).toBe('main')
  })

  test('a switch in the folder itself still records the new branch for the session', async () => {
    const { repo, bound, checkout, head } = handler()
    expect(await checkout('other-work')).toMatchObject({ success: true, workingDirectory: repo, gitContext: { branch: 'other-work' } })
    expect(head()).toBe('other-work')
    expect(bound).toEqual([['on-screen', repo]])
  })
})
