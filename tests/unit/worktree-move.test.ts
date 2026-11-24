import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Activity, ActivityKind } from '@solus/contracts/activity'
import type { GitCheckout, NormalizedEvent, SessionRunInput } from '@solus/contracts/types'
import { ulid } from '@solus/contracts/ulid'
import type { Actor } from '@solus/server/admission/actor'
import type { WorktreeMoveRuntime } from '@solus/server/execution/sessions/worktree-move'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

mock.module('node:sqlite', () => ({ DatabaseSync }))
// The host's git probe asks `xcode-select`, which a sandbox can refuse. These
// tests make their own repositories with the git on PATH.
const gitAvailability = await import('@solus/server/git/git-availability')
mock.module('@solus/server/git/git-availability', () => ({ ...gitAvailability, isGitUsable: () => true }))

// Server modules open the database on import: they load after the mock.
let HOST_ACTOR: Actor
let WorktreeMover: typeof import('@solus/server/execution/sessions/worktree-move')['WorktreeMover']
let worktreeOfRepository: typeof import('@solus/server/execution/sessions/worktree-move')['worktreeOfRepository']
let checkoutOfRepository: typeof import('@solus/server/execution/sessions/worktree-move')['checkoutOfRepository']
let WorktreeOffers: typeof import('@solus/server/execution/sessions/worktree-offers')['WorktreeOffers']
let worktreeAddPaths: typeof import('@solus/server/execution/sessions/worktree-offers')['worktreeAddPaths']
let checkoutStatusText: typeof import('@solus/server/execution/agents/tools/worktree-tools')['checkoutStatusText']
let worktreeTools: typeof import('@solus/server/execution/agents/tools/worktree-tools')
let createWorktree: typeof import('@solus/server/git/worktree-manager')['createWorktree']
type WorktreeOffersInstance = InstanceType<typeof WorktreeOffers>

beforeAll(async () => {
  ;({ HOST_ACTOR } = await import('@solus/server/admission/actor'))
  ;({ WorktreeMover, worktreeOfRepository, checkoutOfRepository } = await import('@solus/server/execution/sessions/worktree-move'))
  ;({ WorktreeOffers, worktreeAddPaths } = await import('@solus/server/execution/sessions/worktree-offers'))
  worktreeTools = await import('@solus/server/execution/agents/tools/worktree-tools')
  ;({ createWorktree } = await import('@solus/server/git/worktree-manager'))
  ;({ checkoutStatusText } = worktreeTools)
})

/**
 * An agent that works in a worktree Solus does not know about leaves the diff,
 * the Git status, and the branch on the wrong checkout. These tests hold the
 * rules that keep the session bound to where the work is: the move path, the
 * detection that offers a switch, and Stop's reach over a move in progress.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-worktree-move-')))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = join(root, 'data')

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

/** A path as an agent writes it in a POSIX shell. A shell reads `\` as an escape, so Git Bash on Windows takes `C:/...`. */
function shellPath(path: string): string {
  return path.replaceAll('\\', '/')
}

function makeRepo(name: string): string {
  const repo = join(root, name)
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  return repo
}

const repo = makeRepo('repo')
const worktree = join(root, 'repo-feature')
git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree)
const otherRepo = makeRepo('other')
const foreignWorktree = join(root, 'other-feature')
git(otherRepo, 'worktree', 'add', '-q', '-b', 'other-feature', foreignWorktree)

afterAll(async () => {
  // Windows cannot remove the data folder while the database is open.
  const { closeDb } = await import('@solus/server/db')
  closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

/** A runtime that binds sessions in memory, as `SessionRuntime` does. */
function fakeRuntime(options: { create?: WorktreeMoveRuntime['checkouts']['create']; repo?: string } = {}) {
  const repoRoot = options.repo ?? repo
  const bindings = new Map<string, GitCheckout>()
  const directories = new Map<string, string>()
  const activity: ActivityKind[] = []
  const moves = new Map<string, AbortController>()
  const held = new Map<string, () => Promise<void>>()
  const continued: string[] = []
  const runtime: WorktreeMoveRuntime = {
    checkouts: {
      create: options.create ?? (async () => { throw new Error('no create in this test') }),
      refresh: async (cwd) => {
        const branch = git(cwd, 'branch', '--show-current')
        // The main checkout has no worktree path, as the checkout service reads it.
        const checkout = realpathSync(cwd) === repoRoot ? { repoRoot, branch, targetBranch: 'main' } : { repoRoot, worktreePath: cwd, branch, targetBranch: 'main' }
        return { cwd, revision: 1, checkout } as never
      },
    },
    getGitContext: (sessionId) => bindings.get(sessionId),
    trackWorktreeMove: (sessionId, controller) => {
      moves.set(sessionId, controller)
      return () => { if (moves.get(sessionId) === controller) moves.delete(sessionId) }
    },
    moveSessionCheckout: (sessionId, directory, checkout) => {
      bindings.set(sessionId, checkout)
      directories.set(sessionId, directory)
    },
    boundDirectories: () => directories.entries(),
    holdNextTurn: (sessionId, finish) => { if (finish) held.set(sessionId, finish); else held.delete(sessionId) },
    continueSession: async (_sessionId, prompt) => { continued.push(prompt) },
    recordActivity: async (subject, _actor, kind) => {
      activity.push(kind)
      return { ...kind, id: ulid(), subject, at: Date.now(), by: { kind: 'system' } } as Activity
    },
    nameWorktreeBranch: async () => {},
    // These sessions have no codebase, so a new worktree is never a task folder.
    taskFolders: { plansFor: async () => false, createForMove: async () => null, leave: async () => ({ removed: [], kept: [] }) },
  }
  bindings.set('s1', { repoRoot, branch: git(repoRoot, 'branch', '--show-current'), targetBranch: 'main' })
  directories.set('s1', repoRoot)
  /** What `launchRun` does before the next turn: wait for the move the last turn left. */
  const nextTurn = async () => { await held.get('s1')?.() }
  return { runtime, bindings, directories, activity, moves, held, continued, nextTurn }
}

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

// The expected paths are POSIX paths resolved against '/repo'.
describe.skipIf(process.platform === 'win32')('worktreeAddPaths reads the paths a shell command creates worktrees at', () => {
  test.each([
    ['git worktree add ../wt -b feat', ['/wt']],
    ['git worktree add -b feat ../wt main', ['/wt']],
    ['git worktree add --lock --reason "keep it" -B feat ../wt', ['/wt']],
    ['cd /work && git worktree add .claude/x', ['/work/.claude/x']],
    ['git -C /elsewhere worktree add tree', ['/elsewhere/tree']],
    ["/bin/zsh -lc 'git worktree add ../wt'", ['/wt']],
    ['git worktree add "../my tree"', ['/my tree']],
    ['git worktree add -- -odd', ['/repo/-odd']],
    ['git status && git worktree list', []],
    ['echo git worktree add ../nope', []],
  ])('%s', (command, expected) => {
    expect(worktreeAddPaths(command, '/repo')).toEqual(expected)
  })

  test('a leading ~ is the host user home, not a folder named ~', () => {
    const [path] = worktreeAddPaths('git worktree add ~/trees/x', '/repo')
    expect(path?.startsWith('~')).toBe(false)
    expect(path?.endsWith('/trees/x')).toBe(true)
  })
})

describe('worktreeAddPaths reads Codex on Windows', () => {
  // WHY: Codex on Windows runs each command through PowerShell. A worktree it
  // made was never offered, because only POSIX shells were read and the
  // program was named by a POSIX basename, which keeps a whole Windows path.
  const cwd = resolve('repo')
  const powershell = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"'

  test('as Codex sends it: the PowerShell program by its full path, and -Command', () => {
    expect(worktreeAddPaths(`${powershell} -Command 'git worktree add ../scratch-codex-probe -b codex-probe-branch'`, cwd))
      .toEqual([resolve(cwd, '../scratch-codex-probe')])
  })

  test('pwsh, -c, and git.exe; -ExecutionPolicy is not the script', () => {
    expect(worktreeAddPaths(`pwsh.exe -NoProfile -ExecutionPolicy Bypass -c 'git.exe worktree add ../a'`, cwd)).toEqual([resolve(cwd, '../a')])
    expect(worktreeAddPaths(`${powershell} -ExecutionPolicy Bypass -File x.ps1`, cwd)).toEqual([])
  })
})

describe('worktreeOfRepository asks git, not the string', () => {
  test('a linked worktree of the repository, or a folder inside one, is accepted', async () => {
    expect(await worktreeOfRepository(repo, worktree)).toBe(worktree)
    expect(await worktreeOfRepository(repo, '../repo-feature')).toBe(worktree)
  })

  test('the main checkout, another repository, and a plain folder are refused', async () => {
    expect(await worktreeOfRepository(repo, repo)).toBeNull()
    expect(await worktreeOfRepository(repo, foreignWorktree)).toBeNull()
    expect(await worktreeOfRepository(repo, root)).toBeNull()
    expect(await worktreeOfRepository(repo, join(root, 'missing'))).toBeNull()
  })
})

describe('WorktreeMover', () => {
  test('a move binds the session to the worktree and records the move', async () => {
    const { runtime, bindings, activity } = fakeRuntime()
    const mover = new WorktreeMover(runtime)
    const result = await mover.move({ sessionId: 's1', cwd: repo, target: { kind: 'existing', path: worktree }, actor: HOST_ACTOR })
    expect(result.success).toBe(true)
    expect(bindings.get('s1')?.worktreePath).toBe(worktree)
    expect(activity).toEqual([{ kind: 'moved_to_worktree', path: worktree, branch: 'feature' }])
  })

  test('a move into the worktree the session is already in is refused', async () => {
    const { runtime, activity } = fakeRuntime()
    const mover = new WorktreeMover(runtime)
    await mover.move({ sessionId: 's1', cwd: repo, target: { kind: 'existing', path: worktree }, actor: HOST_ACTOR })
    const again = await mover.move({ sessionId: 's1', cwd: repo, target: { kind: 'existing', path: worktree }, actor: HOST_ACTOR })
    expect(again).toEqual({ success: false, error: 'This session is already in that worktree.' })
    expect(activity).toHaveLength(1)
  })

  test('two moves at once run one after another, so the second sees the first', async () => {
    // Without the queue both read the main checkout as the binding and both move.
    const { runtime, activity } = fakeRuntime()
    const mover = new WorktreeMover(runtime)
    const request = { sessionId: 's1', cwd: repo, target: { kind: 'existing' as const, path: worktree }, actor: HOST_ACTOR }
    const [first, second] = await Promise.all([mover.move(request), mover.move(request)])
    expect(first.success).toBe(true)
    expect(second.success).toBe(false)
    expect(activity).toHaveLength(1)
  })

  test('a path that is not a worktree of the repository is refused', async () => {
    const { runtime, bindings } = fakeRuntime()
    const result = await new WorktreeMover(runtime).move({ sessionId: 's1', cwd: repo, target: { kind: 'existing', path: foreignWorktree }, actor: HOST_ACTOR })
    expect(result.success).toBe(false)
    expect(bindings.get('s1')?.worktreePath).toBeUndefined()
  })

  test('a new worktree starts from the target branch with the given branch name', async () => {
    const created: Array<{ base?: string; name?: string | null }> = []
    const { runtime, bindings } = fakeRuntime({
      create: async (_root, base, options) => {
        created.push({ base, name: options?.generatedName })
        return { repoRoot: repo, worktreePath: worktree, branch: 'solus/fix', targetBranch: 'main' }
      },
    })
    const result = await new WorktreeMover(runtime).move({ sessionId: 's1', cwd: repo, target: { kind: 'new', branchName: 'fix' }, actor: HOST_ACTOR })
    expect(result.success).toBe(true)
    expect(created).toEqual([{ base: 'main', name: 'fix' }])
    expect(bindings.get('s1')?.worktreePath).toBe(worktree)
  })
})

describe('moves to and from the project folder', () => {
  // WHY: an agent that finished in a worktree had no way back. It removed the
  // worktree with git, the session stayed bound to the missing folder, and the
  // next turn made the worktree again on a new branch.
  test('a session in a worktree moves to the project folder, and the divider says so', async () => {
    const { runtime, bindings, directories, activity } = fakeRuntime()
    bindings.set('s1', { repoRoot: repo, worktreePath: worktree, branch: 'feature', targetBranch: 'main' })
    directories.set('s1', worktree)
    const result = await new WorktreeMover(runtime).move({ sessionId: 's1', cwd: worktree, target: { kind: 'existing', path: repo }, actor: HOST_ACTOR })
    expect(result.success).toBe(true)
    expect(directories.get('s1')).toBe(repo)
    expect(bindings.get('s1')?.worktreePath).toBeUndefined()
    expect(activity).toEqual([{ kind: 'moved_to_worktree', path: repo, branch: 'main', projectFolder: true }])
  })

  test('the project folder by its path is a checkout of the repository; the deepest checkout holds a path', async () => {
    expect(await checkoutOfRepository(worktree, repo)).toBe(repo)
    expect(await checkoutOfRepository(repo, join(worktree, '.'))).toBe(worktree)
    expect(await checkoutOfRepository(repo, foreignWorktree)).toBeNull()
  })

  test('a session already in the project folder is told so', async () => {
    const { runtime } = fakeRuntime()
    expect(await new WorktreeMover(runtime).move({ sessionId: 's1', cwd: repo, target: { kind: 'existing', path: repo }, actor: HOST_ACTOR }))
      .toEqual({ success: false, error: 'This session is already in the project folder.' })
  })

  test('a new worktree can start from inside a worktree; Git makes it from the project folder', async () => {
    // A linked worktree's `.git` is a file, so a worktree path built from it fails.
    const roots: string[] = []
    const { runtime, bindings, directories } = fakeRuntime({
      create: async (projectRoot) => {
        roots.push(projectRoot)
        return { repoRoot: repo, worktreePath: join(root, 'repo-next'), branch: 'solus/next', targetBranch: 'main' }
      },
    })
    bindings.set('s1', { repoRoot: repo, worktreePath: worktree, branch: 'feature', targetBranch: 'main' })
    directories.set('s1', worktree)
    const result = await new WorktreeMover(runtime).move({ sessionId: 's1', cwd: worktree, target: { kind: 'new' }, actor: HOST_ACTOR })
    expect(result.success).toBe(true)
    expect(roots).toEqual([repo])
    expect(directories.get('s1')).toBe(join(root, 'repo-next'))
  })
})

describe('the agent move: a checkout and a branch; Git steps wait for the turn to end', () => {
  /** A repository of its own, with a worktree on `feature`: these tests change both. */
  function scratch(name: string) {
    const projectFolder = makeRepo(name)
    const feature = join(root, `${name}-feature`)
    git(projectFolder, 'worktree', 'add', '-q', '-b', 'feature', feature)
    // Every new worktree goes through the host's one creator, with its setup.
    const harness = fakeRuntime({ repo: projectFolder, create: (projectRoot, base, options) => createWorktree(projectRoot, base, options) })
    const mover = new WorktreeMover(harness.runtime)
    const enterFeature = () => {
      harness.bindings.set('s1', { repoRoot: projectFolder, worktreePath: feature, branch: 'feature', targetBranch: 'main' })
      harness.directories.set('s1', feature)
    }
    /** What the next turn does first: the steps run, then the turn starts. */
    const endTurn = async () => {
      mover.turnSettled('s1', 'completed')
      await harness.nextTurn()
    }
    return { projectFolder, feature, mover, enterFeature, endTurn, ...harness }
  }
  const request = (cwd: string, fields: { checkout: string; branch?: string; baseBranch?: string; removeWorktree?: boolean; continueWith?: string }) =>
    ({ sessionId: 's1', cwd, actor: HOST_ACTOR, ...fields })

  test('remove_worktree moves the session now and removes the worktree only when the turn completes', async () => {
    const { projectFolder, feature, mover, enterFeature, directories, endTurn } = scratch('remove-left')
    enterFeature()
    const result = await mover.moveForAgent(request(feature, { checkout: projectFolder, branch: 'main', removeWorktree: true }))
    expect(result).toMatchObject({ success: true, directory: projectFolder, branch: 'main', movesAtTurnEnd: false, steps: [`remove the worktree ${feature}`] })
    expect(directories.get('s1')).toBe(projectFolder)
    // The agent's process still runs in the worktree until its turn ends.
    expect(existsSync(feature)).toBe(true)
    await endTurn()
    expect(existsSync(feature)).toBe(false)
    // Removing the worktree keeps its branch and commits.
    expect(git(projectFolder, 'branch', '--list', 'feature')).toContain('feature')
  })

  test('a move to an existing checkout names its branch; the branch it already has needs no Git step', async () => {
    // WHY: without a branch, the session landed on whatever branch the folder had, and the call did not say which.
    const { projectFolder, feature, mover, enterFeature, directories } = scratch('branch-required')
    enterFeature()
    expect((await mover.moveForAgent(request(feature, { checkout: projectFolder }))).error)
      .toBe(`Name the branch ${projectFolder} must be on. It is on main; pass that branch to keep it.`)
    expect(directories.get('s1')).toBe(feature)
    const result = await mover.moveForAgent(request(feature, { checkout: projectFolder, branch: 'main' }))
    expect(result).toMatchObject({ success: true, directory: projectFolder, branch: 'main', steps: [], movesAtTurnEnd: false })
    expect(directories.get('s1')).toBe(projectFolder)
  })

  test('a stopped turn cancels what waits, and the next turn does not wait for it', async () => {
    const { projectFolder, feature, mover, enterFeature, held } = scratch('remove-stopped')
    enterFeature()
    await mover.moveForAgent(request(feature, { checkout: projectFolder, branch: 'main', removeWorktree: true }))
    mover.turnSettled('s1', 'interrupted')
    expect(held.has('s1')).toBe(false)
    expect(existsSync(feature)).toBe(true)
  })

  test('a worktree with uncommitted changes, or one another session works in, is refused before anything moves', async () => {
    const { projectFolder, feature, mover, enterFeature, directories } = scratch('remove-refused')
    enterFeature()
    writeFileSync(join(feature, 'draft.txt'), 'not committed')
    const dirty = await mover.moveForAgent(request(feature, { checkout: projectFolder, branch: 'main', removeWorktree: true }))
    expect(dirty.error).toContain('uncommitted changes')
    rmSync(join(feature, 'draft.txt'))
    directories.set('s2', feature)
    const shared = await mover.moveForAgent(request(feature, { checkout: projectFolder, branch: 'main', removeWorktree: true }))
    expect(shared.error).toBe(`Another session works in ${feature}.`)
    expect(directories.get('s1')).toBe(feature)
  })

  test('the worktree branch into the project folder: freed only with remove_worktree, then the folder continues it', async () => {
    const { projectFolder, feature, mover, enterFeature, directories, activity, endTurn } = scratch('bring-in')
    enterFeature()
    git(feature, 'commit', '-q', '--allow-empty', '-m', 'feature work')
    // WHY: freeing the branch deletes the worktree folder; that is never implied.
    expect((await mover.moveForAgent(request(feature, { checkout: projectFolder, branch: 'feature' }))).error)
      .toBe(`feature is checked out in ${feature}, the worktree you leave. Pass remove_worktree to free it.`)
    const result = await mover.moveForAgent(request(feature, { checkout: projectFolder, branch: 'feature', removeWorktree: true }))
    expect(result).toMatchObject({
      success: true, directory: projectFolder, branch: 'feature', movesAtTurnEnd: true,
      steps: [`remove the worktree ${feature}`, `switch ${projectFolder} to feature`],
    })
    // Nothing changes while the turn runs.
    expect(directories.get('s1')).toBe(feature)
    await endTurn()
    expect(existsSync(feature)).toBe(false)
    expect(git(projectFolder, 'branch', '--show-current')).toBe('feature')
    expect(git(projectFolder, 'log', '-1', '--format=%s')).toBe('feature work')
    expect(directories.get('s1')).toBe(projectFolder)
    expect(activity.at(-1)).toEqual({ kind: 'moved_to_worktree', path: projectFolder, branch: 'feature', projectFolder: true })
  })

  test('the project folder branch into a new worktree: the folder goes back to the target branch', async () => {
    const { projectFolder, mover, bindings, directories, endTurn } = scratch('bring-out')
    git(projectFolder, 'switch', '-q', '-c', 'topic')
    git(projectFolder, 'commit', '-q', '--allow-empty', '-m', 'topic work')
    bindings.set('s1', { repoRoot: projectFolder, branch: 'topic', targetBranch: 'main' })
    const topic = join(projectFolder, '.git', 'solus', 'worktrees', 'topic')
    const result = await mover.moveForAgent(request(projectFolder, { checkout: 'new_worktree', branch: 'topic' }))
    expect(result).toMatchObject({
      success: true, directory: topic, branch: 'topic', movesAtTurnEnd: true,
      steps: [`switch the project folder ${projectFolder} to main`, `make a worktree at ${topic} on topic`],
    })
    await endTurn()
    expect(git(projectFolder, 'branch', '--show-current')).toBe('main')
    expect(git(topic, 'log', '-1', '--format=%s')).toBe('topic work')
    expect(directories.get('s1')).toBe(topic)
  })

  test('a new worktree on a branch the agent names exactly, from the base it names', async () => {
    // WHY: a declared branch is the branch. The naming settings shape only a branch the agent did not name.
    const { projectFolder, mover, directories, endTurn } = scratch('named')
    git(projectFolder, 'branch', 'release')
    git(projectFolder, 'commit', '-q', '--allow-empty', '-m', 'only on main')
    const path = join(projectFolder, '.git', 'solus', 'worktrees', 'fix-login')
    const result = await mover.moveForAgent(request(projectFolder, { checkout: 'new_worktree', branch: 'fix/login', baseBranch: 'release' }))
    expect(result.steps).toEqual([`make a worktree at ${path} on a new branch fix/login from release`])
    await endTurn()
    expect(git(path, 'branch', '--show-current')).toBe('fix/login')
    expect(git(path, 'log', '-1', '--format=%s')).toBe('init')
    expect(directories.get('s1')).toBe(path)
  })

  test('a worktree on a named branch gets the same setup as every new worktree', async () => {
    // WHY: a plain `git worktree add` left out the ignored files the project
    // lists in .worktreeinclude, such as .env, so the agent worked without them.
    const { projectFolder, mover, endTurn } = scratch('named-setup')
    writeFileSync(join(projectFolder, '.gitignore'), '.env\n')
    writeFileSync(join(projectFolder, '.worktreeinclude'), '.env\n')
    git(projectFolder, 'add', '.gitignore', '.worktreeinclude')
    git(projectFolder, 'commit', '-q', '-m', 'include .env')
    writeFileSync(join(projectFolder, '.env'), 'TOKEN=local')
    await mover.moveForAgent(request(projectFolder, { checkout: 'new_worktree', branch: 'with-env' }))
    await endTurn()
    const path = join(projectFolder, '.git', 'solus', 'worktrees', 'with-env')
    expect(git(path, 'branch', '--show-current')).toBe('with-env')
    expect(existsSync(join(path, '.env'))).toBe(true)
  })

  test('a branch for the checkout the session stays in is a switch, not a move', async () => {
    const { projectFolder, mover, directories, activity, endTurn } = scratch('in-place')
    const result = await mover.moveForAgent(request(projectFolder, { checkout: projectFolder, branch: 'docs' }))
    expect(result.steps).toEqual([`switch ${projectFolder} to a new branch docs from main`])
    await endTurn()
    expect(git(projectFolder, 'branch', '--show-current')).toBe('docs')
    expect(directories.get('s1')).toBe(projectFolder)
    // No divider: the session did not change checkout.
    expect(activity).toEqual([])
  })

  test('refusals name the reason: a branch in another checkout, a missing base, a base for a branch that exists', async () => {
    const { projectFolder, feature, mover } = scratch('refusals')
    expect((await mover.moveForAgent(request(projectFolder, { checkout: 'new_worktree', branch: 'feature' }))).error)
      .toBe(`feature is checked out in ${feature}. Choose that checkout, or another branch.`)
    expect((await mover.moveForAgent(request(projectFolder, { checkout: 'new_worktree', branch: 'x', baseBranch: 'nope' }))).error)
      .toBe('The base branch nope does not exist.')
    git(projectFolder, 'branch', 'spare')
    expect((await mover.moveForAgent(request(projectFolder, { checkout: 'new_worktree', branch: 'spare', baseBranch: 'main' }))).error)
      .toBe('spare already exists, so base_branch does not apply.')
    expect((await mover.moveForAgent(request(projectFolder, { checkout: projectFolder, branch: 'main' }))).error)
      .toBe('This session is already in that checkout, on that branch.')
  })

  test('continue_with starts the next turn after the move, and says when a step failed', async () => {
    const { projectFolder, feature, mover, enterFeature, continued, endTurn } = scratch('continue')
    enterFeature()
    await mover.moveForAgent(request(feature, { checkout: projectFolder, branch: 'main', removeWorktree: true, continueWith: 'Run the tests.' }))
    // The agent kept writing in the worktree after the call: the check before the steps refuses.
    writeFileSync(join(feature, 'late.txt'), 'written after the call')
    await endTurn()
    await Promise.resolve()
    expect(existsSync(feature)).toBe(true)
    expect(continued).toHaveLength(1)
    expect(continued[0]).toStartWith('The move did not finish:')
    expect(continued[0]).toEndWith('Run the tests.')
  })

  test('one move waits per turn', async () => {
    const { projectFolder, feature, mover, enterFeature } = scratch('one-at-a-time')
    enterFeature()
    await mover.moveForAgent(request(feature, { checkout: projectFolder, branch: 'main', removeWorktree: true }))
    expect((await mover.moveForAgent(request(feature, { checkout: 'new_worktree' }))).error).toBe('A move already waits for this turn to end.')
  })

  test('move_checkout lists the steps, and refuses an option it does not know', async () => {
    // WHY: a dropped option looks like a move that succeeded without it.
    const { projectFolder, feature, mover, enterFeature } = scratch('tool-options')
    enterFeature()
    worktreeTools.setWorktreeMover(mover, () => undefined)
    const context = { provider: 'claude-code' as const, cwd: feature, sessionId: () => 's1', abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => {} }
    const unknown = await worktreeTools.moveCheckoutAgentTool.execute({ checkout: projectFolder, bring_branch: true }, context)
    expect(unknown.ok).toBe(false)
    const moved = await worktreeTools.moveCheckoutAgentTool.execute({ checkout: projectFolder, branch: 'feature', remove_worktree: true }, context)
    expect(moved.text).toStartWith(`Move recorded. When this turn ends, Solus will (1) remove the worktree ${feature}, (2) switch ${projectFolder} to feature. Then the session works in ${projectFolder} on feature.`)
  })

  test('checkout_status names uncommitted changes, other sessions, and the branches with their checkouts', async () => {
    const { projectFolder, feature, mover, directories } = scratch('status')
    writeFileSync(join(feature, 'draft.txt'), 'not committed')
    directories.set('s2', feature)
    worktreeTools.setWorktreeMover(mover, () => undefined)
    const context = { provider: 'claude-code' as const, cwd: projectFolder, sessionId: () => 's1', abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => {} }
    const result = await worktreeTools.checkoutStatusAgentTool.execute({ branches: { query: 'feat' } }, context)
    expect(result.text).toContain(`- ${feature} on feature (1 uncommitted change, 1 other session)`)
    expect(result.text).toContain(`feature (local, checked out in ${feature})`)
    expect(result.text).not.toContain('- main (local')
  })
})

describe('checkout_status', () => {
  // An agent picks between a new and an existing worktree from this answer, and
  // after a move in the same turn its process directory no longer says where the
  // session is bound. The answer must come from the binding, not from the cwd.
  test('names the binding and every checkout of the repository', async () => {
    const { runtime } = fakeRuntime()
    const status = await new WorktreeMover(runtime).status('s1', repo)
    expect(status?.directory).toBe(repo)
    expect(status?.checkouts.map(({ path, branch, holdsSession }) => ({ path: realpathSync(path), branch, holdsSession }))).toEqual([
      { path: repo, branch: 'main', holdsSession: true },
      { path: worktree, branch: 'feature', holdsSession: false },
    ])
    expect(checkoutStatusText(status!)).toContain(`Bound directory: ${repo} (the project folder)`)
  })

  test('after a move, reports the new worktree while the caller still runs in the old directory', async () => {
    const { runtime } = fakeRuntime()
    const mover = new WorktreeMover(runtime)
    await mover.move({ sessionId: 's1', cwd: repo, target: { kind: 'existing', path: worktree }, actor: HOST_ACTOR })
    const status = await mover.status('s1', repo)
    expect(status?.directory).toBe(worktree)
    expect(status?.checkouts.find((checkout) => checkout.holdsSession)?.branch).toBe('feature')
    expect(checkoutStatusText(status!)).toContain(`Bound directory: ${worktree} (a linked worktree)`)
  })

  test('outside a git repository there is no status', async () => {
    const { runtime, bindings } = fakeRuntime()
    bindings.delete('s1')
    const outside = join(root, 'not-a-repo')
    mkdirSync(outside, { recursive: true })
    expect(await new WorktreeMover(runtime).status('s1', outside)).toBeNull()
  })
})

describe('Stop and a move in progress', () => {
  test('Stop aborts the worktree setup of a move; the session stays where it was', async () => {
    const { SessionRuntime } = await import('@solus/server/execution/session-runtime')
    const sessionRuntime = new SessionRuntime(new Map())
    const sessions = (sessionRuntime as unknown as { activeSessions: Map<string, { status: string }> }).activeSessions
    sessions.set('s1', { status: 'idle' })
    let setupStarted!: () => void
    const started = new Promise<void>((resolve) => { setupStarted = resolve })
    const { runtime, bindings } = fakeRuntime({
      create: (_root, _base, options) => new Promise((_resolve, reject) => {
        setupStarted()
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason))
      }),
    })
    // The registry is the runtime's own: the one Stop reads.
    runtime.trackWorktreeMove = (sessionId, controller) => sessionRuntime.sessionCheckouts.trackWorktreeMove(sessionId, controller)
    try {
      const move = new WorktreeMover(runtime).move({ sessionId: 's1', cwd: repo, target: { kind: 'new' }, actor: HOST_ACTOR })
      await started
      expect(sessionRuntime.stopSession('s1', HOST_ACTOR)).toBe(true)
      expect(await move).toEqual({ success: false, error: 'The move was stopped.' })
      expect(bindings.get('s1')?.worktreePath).toBeUndefined()
      // Nothing is left to stop once the move ended.
      expect(sessionRuntime.stopSession('s1', HOST_ACTOR)).toBe(false)
    } finally {
      sessions.clear()
      sessionRuntime.shutdown()
    }
  })

  test('the first turn after a move forks the active thread in the new checkout', async () => {
    const { SessionRuntime } = await import('@solus/server/execution/session-runtime')
    const { registerSessionLineage } = await import('@solus/server/data/sessions/session-lineage')
    const sessionRuntime = new SessionRuntime(new Map())
    try {
      registerSessionLineage({ sessionId: 'moved-session', provider: 'claude-code', providerSessionId: 'thread-1', cwd: repo })
      sessionRuntime.sessionCheckouts.moveSessionCheckout('moved-session', worktree, { repoRoot: repo, worktreePath: worktree, branch: 'feature', targetBranch: 'main' })
      const forkFor = (sessionRuntime.sessionCheckouts as unknown as {
        continueInMovedCheckout(request: { sessionId: string; target: { kind: string }; input: Partial<SessionRunInput> }): { target: { kind: string }; input: Partial<SessionRunInput> }
      }).continueInMovedCheckout.bind(sessionRuntime.sessionCheckouts)
      const request = { sessionId: 'moved-session', target: { kind: 'session' }, input: { provider: 'claude-code' as const, agentSessionId: 'thread-1', forked: false, workingDirectory: repo } }
      const first = forkFor(request)
      expect(first.target.kind).toBe('new-session')
      expect(first.input).toMatchObject({ forked: true, agentSessionId: 'thread-1', workingDirectory: worktree })
      // Only the first turn forks; the next one continues the forked thread.
      expect(forkFor(request)).toBe(request)
      // A move into the project folder forks there: the checkout has no worktree path.
      sessionRuntime.sessionCheckouts.moveSessionCheckout('moved-session', repo, { repoRoot: repo, branch: 'main', targetBranch: 'main' })
      expect(forkFor({ ...request, input: { ...request.input, workingDirectory: worktree } }).input).toMatchObject({ forked: true, workingDirectory: repo })
    } finally {
      sessionRuntime.shutdown()
    }
  })
})

describe('WorktreeOffers', () => {
  function offersHarness(stored: Activity[] = []) {
    const { runtime, bindings } = fakeRuntime()
    const mover = new WorktreeMover(runtime)
    const recorded: Activity[] = [...stored]
    const offers = new WorktreeOffers({
      mover,
      hostActor: HOST_ACTOR,
      recordActivity: async (sessionId, _actor, kind) => {
        const activity = { ...kind, id: ulid(), subject: { kind: 'session', id: sessionId }, at: Date.now(), by: { kind: 'system' } } as Activity
        recorded.push(activity)
        return activity
      },
      sessionActivity: async () => stored,
    })
    const offered = () => recorded.filter((row) => row.kind === 'worktree_offered')
    return { offers, offered, recorded, bindings }
  }

  /** Claude streams the tool, its input, then its result. */
  async function claudeTool(offers: WorktreeOffersInstance, toolId: string, toolName: string, input: unknown, result = '', isError = false) {
    const events: NormalizedEvent[] = [
      { type: 'tool_call', toolName, toolId, index: 1 },
      { type: 'tool_call_complete', index: 1, toolId, toolInput: JSON.stringify(input) },
      { type: 'tool_result', toolUseId: toolId, content: result, isError },
    ]
    for (const event of events) offers.observe('s1', event)
    await offers.settled('s1')
  }

  test('a Claude EnterWorktree result offers the worktree it names', async () => {
    const { offers, offered } = offersHarness()
    await claudeTool(offers, 't1', 'EnterWorktree', { name: 'feature' }, `Created worktree at ${worktree} on branch feature.`)
    expect(offered()).toMatchObject([{ kind: 'worktree_offered', path: worktree, branch: 'feature' }])
  })

  test('a Claude Bash `git worktree add` offers the new worktree', async () => {
    const { offers, offered } = offersHarness()
    await claudeTool(offers, 't1', 'Bash', { command: 'git worktree add ../repo-feature feature' })
    expect(offered()).toMatchObject([{ path: worktree }])
  })

  test('a Codex command offers the new worktree once its command succeeds', async () => {
    const { offers, offered } = offersHarness()
    offers.observe('s1', { type: 'tool_call', toolName: 'exec_command', toolId: 'c1', index: 0, toolInput: `/bin/zsh -lc 'git worktree add ${shellPath(worktree)}'` })
    offers.observe('s1', { type: 'tool_call_complete', index: 0, toolId: 'c1', outcome: { status: 'completed', exitCode: 0 } })
    await offers.settled('s1')
    expect(offered()).toMatchObject([{ path: worktree }])
  })

  test('a failed command, a path outside the repository, and a sub-agent call offer nothing', async () => {
    const { offers, offered } = offersHarness()
    await claudeTool(offers, 't1', 'Bash', { command: `git worktree add ${shellPath(worktree)}` }, 'fatal', true)
    await claudeTool(offers, 't2', 'Bash', { command: `git worktree add ${shellPath(foreignWorktree)}` })
    offers.observe('s1', { type: 'tool_call', toolName: 'Bash', toolId: 't3', index: 2, parentToolUseId: 'agent', toolInput: JSON.stringify({ command: `git worktree add ${shellPath(worktree)}` }) })
    offers.observe('s1', { type: 'tool_result', toolUseId: 't3', content: '', parentToolUseId: 'agent' })
    await offers.settled('s1')
    expect(offered()).toHaveLength(0)
  })

  test('a worktree the session is already bound to is not offered', async () => {
    const { offers, offered, bindings } = offersHarness()
    bindings.set('s1', { repoRoot: repo, worktreePath: worktree, branch: 'feature', targetBranch: 'main' })
    await claudeTool(offers, 't1', 'Bash', { command: `git worktree add ${shellPath(worktree)}` })
    expect(offered()).toHaveLength(0)
  })

  test('after Keep current the same worktree is not offered again', async () => {
    const { offers, offered } = offersHarness()
    await claudeTool(offers, 't1', 'Bash', { command: `git worktree add ${shellPath(worktree)}` })
    const [offer] = offered()
    expect(await offers.decide('s1', offer!.id, 'keep', HOST_ACTOR, { cwd: repo })).toEqual({ decision: 'kept' })
    await claudeTool(offers, 't2', 'EnterWorktree', {}, `Switched to ${worktree}`)
    expect(offered()).toHaveLength(1)
  })

  test('a decline stored before a restart still holds', async () => {
    const offerId = ulid()
    const stored = [
      { kind: 'worktree_offered', path: worktree, id: offerId, subject: { kind: 'session', id: 's1' }, at: 1, by: { kind: 'system' } },
      { kind: 'worktree_offer_decided', offerId, resolution: { decision: 'kept' }, id: ulid(), subject: { kind: 'session', id: 's1' }, at: 2, by: { kind: 'system' } },
    ] as Activity[]
    const { offers, offered } = offersHarness(stored)
    await claudeTool(offers, 't1', 'Bash', { command: `git worktree add ${shellPath(worktree)}` })
    expect(offered()).toHaveLength(1)
  })

  test('Switch moves the session, and the answer is recorded once', async () => {
    const { offers, offered, recorded, bindings } = offersHarness()
    await claudeTool(offers, 't1', 'Bash', { command: `git worktree add ${shellPath(worktree)}` })
    const [offer] = offered()
    const [first, second] = await Promise.all([
      offers.decide('s1', offer!.id, 'switch', HOST_ACTOR, { cwd: repo }),
      offers.decide('s1', offer!.id, 'keep', HOST_ACTOR, { cwd: repo }),
    ])
    expect(first).toEqual({ decision: 'switched' })
    expect(second).toEqual({ decision: 'switched' })
    expect(bindings.get('s1')?.worktreePath).toBe(worktree)
    expect(recorded.filter((row) => row.kind === 'worktree_offer_decided')).toHaveLength(1)
  })
})
