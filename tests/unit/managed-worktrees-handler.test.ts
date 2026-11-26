import { afterAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Codebase } from '@solus/contracts/codebases'
import type { ManagedWorktree } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const gitAvailability = await import('@solus/server/git/git-availability')
mock.module('@solus/server/git/git-availability', () => ({ ...gitAvailability, isGitUsable: () => true }))

const root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-managed-worktrees-handler-')))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = join(root, 'data')
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function makeRepo(path: string): string {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.email', 'test@example.com')
  git(path, 'config', 'user.name', 'Test')
  writeFileSync(join(path, 'README.md'), 'hello\n')
  git(path, 'add', '.')
  git(path, 'commit', '-q', '-m', 'init')
  return path
}
function addManaged(repo: string, slug: string): string {
  const path = join(repo, '.git', 'solus', 'worktrees', slug)
  git(repo, 'worktree', 'add', '-q', '-b', `solus/${slug}`, path)
  return path
}

// One plain project, and one container whose repository is no project.
const project = makeRepo(join(root, 'atlas'))
const container = join(root, 'platform')
const inContainer = makeRepo(join(container, 'api'))
const projectWorktree = addManaged(project, 'fix-login')
const containerWorktree = addManaged(inContainer, 'add-auth')

const INSTALLATION = 'this-host'
const codebase: Codebase = {
  id: 'cb1', name: 'Platform', updatedAt: 1, deletedAt: null,
  roots: [{ installationId: INSTALLATION, path: container, name: 'platform', container: true }],
}

const manifest = await import('@solus/server/project-config/projects-manifest')
mock.module('@solus/server/project-config/projects-manifest', () => ({ ...manifest, listProjects: async () => [{ path: project }] }))
const codebases = await import('@solus/server/data/codebases/codebases')
mock.module('@solus/server/data/codebases/codebases', () => ({ ...codebases, codebasesFor: () => ({ list: async () => [codebase] }) }))
const auth = await import('@solus/server/admission/auth')
mock.module('@solus/server/admission/auth', () => ({ ...auth, getInstallationId: () => INSTALLATION }))

;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
const { registerWorktreeHandlers } = await import('@solus/server/transport/handlers/worktree-handlers')
type Deps = Parameters<typeof registerWorktreeHandlers>[1]
type Server = Parameters<typeof registerWorktreeHandlers>[0]

function listHandler() {
  const handlers = new Map<string, (args: unknown[], ctx: unknown) => Promise<ManagedWorktree[]>>()
  const server = { register: (method: string, run: (args: unknown[], ctx: unknown) => Promise<ManagedWorktree[]>) => { handlers.set(method, run) } }
  const sessionRuntime = { sessionCheckouts: { sessionCheckoutPaths: new Map<string, string>() } }
  // SAFETY: the list reads only the session bindings of the runtime.
  registerWorktreeHandlers(server as unknown as Server, { sessionRuntime } as unknown as Deps)
  return () => handlers.get('managedWorktreesList')!([], { principal: { kind: 'owner', via: 'local' }, actor: null })
}

describe('the Solus worktrees that Settings lists', () => {
  test('come from each project and each repository of a codebase on this host', async () => {
    // WHY: a container root is never a project, so its repositories are only
    // in its codebase. Their worktrees take disk space too and must be listed.
    const listed = await listHandler()()
    expect(listed.map((worktree) => worktree.path).sort()).toEqual([containerWorktree, projectWorktree].sort())
    expect(listed.find((worktree) => worktree.path === containerWorktree)?.group.key).toBe(`project:${inContainer}`)
  })
})
