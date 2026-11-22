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
type WorktreeOffersInstance = InstanceType<typeof WorktreeOffers>

beforeAll(async () => {
  ;({ HOST_ACTOR } = await import('@solus/server/admission/actor'))
  ;({ WorktreeMover, worktreeOfRepository, checkoutOfRepository } = await import('@solus/server/execution/sessions/worktree-move'))
  ;({ WorktreeOffers, worktreeAddPaths } = await import('@solus/server/execution/sessions/worktree-offers'))
  worktreeTools = await import('@solus/server/execution/agents/tools/worktree-tools')
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
    const result = await new WorktreeMover(runtime).move({ sessionId: 's1', cwd: worktree, target: { kind: 'project-folder' }, actor: HOST_ACTOR })
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
    expect(await new WorktreeMover(runtime).move({ sessionId: 's1', cwd: repo, target: { kind: 'project-folder' }, actor: HOST_ACTOR }))
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

describe('the agent move: Git steps wait for the turn to end', () => {
  /** A repository of its own, with a worktree on `feature`: these tests change both. */
  function scratch(name: string) {
    const projectFolder = makeRepo(name)
    const feature = join(root, `${name}-feature`)
    git(projectFolder, 'worktree', 'add', '-q', '-b', 'feature', feature)
    const harness = fakeRuntime({ repo: projectFolder })
    const mover = new WorktreeMover(harness.runtime)
    const enterFeature = () => {
      harness.bindings.set('s1', { repoRoot: projectFolder, worktreePath: feature, branch: 'feature', targetBranch: 'main' })
      harness.directories.set('s1', feature)
    }
    return { projectFolder, feature, mover, enterFeature, ...harness }
  }
  const toProjectFolder = (cwd: string) => ({ sessionId: 's1', cwd, target: { kind: 'project-folder' as const }, actor: HOST_ACTOR })

  test('remove_worktree moves the session now and removes the worktree only when the turn completes', async () => {
    const { projectFolder, feature, mover, enterFeature, directories, nextTurn } = scratch('remove-left')
    enterFeature()
    const result = await mover.moveForAgent(toProjectFolder(feature), { removeWorktree: true })
    expect(result).toMatchObject({ success: true, directory: projectFolder, atTurnEnd: true })
    expect(directories.get('s1')).toBe(projectFolder)
    // The agent's process still runs in the worktree until its turn ends.
    expect(existsSync(feature)).toBe(true)
    mover.turnSettled('s1', 'completed')
    await nextTurn()
    expect(existsSync(feature)).toBe(false)
    // Removing the worktree keeps its branch and commits.
    expect(git(projectFolder, 'branch', '--list', 'feature')).toContain('feature')
  })

  test('a stopped turn cancels what waits, and the next turn does not wait for it', async () => {
    const { feature, mover, enterFeature, held } = scratch('remove-stopped')
    enterFeature()
    await mover.moveForAgent(toProjectFolder(feature), { removeWorktree: true })
    mover.turnSettled('s1', 'interrupted')
    expect(held.has('s1')).toBe(false)
    expect(existsSync(feature)).toBe(true)
  })

  test('a worktree with uncommitted changes, or one another session works in, is refused before anything moves', async () => {
    const { feature, mover, enterFeature, directories } = scratch('remove-refused')
    enterFeature()
    writeFileSync(join(feature, 'draft.txt'), 'not committed')
    const dirty = await mover.moveForAgent(toProjectFolder(feature), { removeWorktree: true })
    expect(dirty.error).toContain('uncommitted changes')
    rmSync(join(feature, 'draft.txt'))
    directories.set('s2', feature)
    const shared = await mover.moveForAgent(toProjectFolder(feature), { removeWorktree: true })
    expect(shared.error).toBe(`Another session works in ${feature}.`)
    expect(directories.get('s1')).toBe(feature)
  })

  test('bringing a branch from a worktree: the worktree goes, and the project folder continues the branch', async () => {
    const { projectFolder, feature, mover, enterFeature, directories, activity, nextTurn } = scratch('bring-in')
    enterFeature()
    git(feature, 'commit', '-q', '--allow-empty', '-m', 'feature work')
    const result = await mover.moveForAgent(toProjectFolder(feature), { bringBranch: true })
    expect(result).toMatchObject({ success: true, directory: projectFolder, branch: 'feature', atTurnEnd: true })
    // Nothing changes while the turn runs.
    expect(directories.get('s1')).toBe(feature)
    mover.turnSettled('s1', 'completed')
    await nextTurn()
    expect(existsSync(feature)).toBe(false)
    expect(git(projectFolder, 'branch', '--show-current')).toBe('feature')
    expect(git(projectFolder, 'log', '-1', '--format=%s')).toBe('feature work')
    expect(directories.get('s1')).toBe(projectFolder)
    expect(activity.at(-1)).toEqual({ kind: 'moved_to_worktree', path: projectFolder, branch: 'feature', projectFolder: true })
  })

  test('bringing a branch from the project folder: the folder goes back to the target branch, a worktree continues the branch', async () => {
    const { projectFolder, mover, bindings, directories, nextTurn } = scratch('bring-out')
    git(projectFolder, 'switch', '-q', '-c', 'topic')
    git(projectFolder, 'commit', '-q', '--allow-empty', '-m', 'topic work')
    bindings.set('s1', { repoRoot: projectFolder, branch: 'topic', targetBranch: 'main' })
    const result = await mover.moveForAgent({ sessionId: 's1', cwd: projectFolder, target: { kind: 'new' }, actor: HOST_ACTOR }, { bringBranch: true })
    const topic = join(projectFolder, '.git', 'solus', 'worktrees', 'topic')
    expect(result).toMatchObject({ success: true, directory: topic, branch: 'topic', atTurnEnd: true })
    mover.turnSettled('s1', 'completed')
    await nextTurn()
    expect(git(projectFolder, 'branch', '--show-current')).toBe('main')
    expect(git(topic, 'branch', '--show-current')).toBe('topic')
    expect(git(topic, 'log', '-1', '--format=%s')).toBe('topic work')
    expect(directories.get('s1')).toBe(topic)
  })

  test('continue_with starts the next turn after the move, and says when a step failed', async () => {
    const { feature, mover, enterFeature, continued, nextTurn } = scratch('continue')
    enterFeature()
    await mover.moveForAgent(toProjectFolder(feature), { removeWorktree: true, continueWith: 'Run the tests.' })
    // The agent kept writing in the worktree after the call: Git refuses to remove it.
    writeFileSync(join(feature, 'late.txt'), 'written after the call')
    mover.turnSettled('s1', 'completed')
    await nextTurn()
    await Promise.resolve()
    expect(existsSync(feature)).toBe(true)
    expect(continued).toHaveLength(1)
    expect(continued[0]).toStartWith('The move did not finish:')
    expect(continued[0]).toEndWith('Run the tests.')
  })

  test('one move waits per turn', async () => {
    const { feature, mover, enterFeature } = scratch('one-at-a-time')
    enterFeature()
    await mover.moveForAgent(toProjectFolder(feature), { removeWorktree: true })
    expect((await mover.moveForAgent({ sessionId: 's1', cwd: feature, target: { kind: 'new' }, actor: HOST_ACTOR }, {})).error)
      .toBe('A move already waits for this turn to end.')
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
      { type: 'tool_call_complete', index: 1, toolInput: JSON.stringify(input) },
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
