import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Activity, ActivityKind } from '@solus/contracts/activity'
import type { GitCheckout, NormalizedEvent, SessionRunInput } from '@solus/contracts/types'
import { ulid } from '@solus/contracts/ulid'
import type { Actor } from '@solus/server/admission/actor'
import type { WorktreeMoveRuntime } from '@solus/server/execution/sessions/worktree-move'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
// The host's git probe asks `xcode-select`, which a sandbox can refuse. These
// tests make their own repositories with the git on PATH.
const gitAvailability = await import('@solus/server/git/git-availability')
mock.module('@solus/server/git/git-availability', () => ({ ...gitAvailability, isGitUsable: () => true }))

// Server modules open the database on import: they load after the mock.
let HOST_ACTOR: Actor
let WorktreeMover: typeof import('@solus/server/execution/sessions/worktree-move')['WorktreeMover']
let worktreeOfRepository: typeof import('@solus/server/execution/sessions/worktree-move')['worktreeOfRepository']
let WorktreeOffers: typeof import('@solus/server/execution/sessions/worktree-offers')['WorktreeOffers']
let worktreeAddPaths: typeof import('@solus/server/execution/sessions/worktree-offers')['worktreeAddPaths']
type WorktreeOffersInstance = InstanceType<typeof WorktreeOffers>

beforeAll(async () => {
  ;({ HOST_ACTOR } = await import('@solus/server/admission/actor'))
  ;({ WorktreeMover, worktreeOfRepository } = await import('@solus/server/execution/sessions/worktree-move'))
  ;({ WorktreeOffers, worktreeAddPaths } = await import('@solus/server/execution/sessions/worktree-offers'))
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

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

/** A runtime that binds sessions in memory, as `SessionRuntime` does. */
function fakeRuntime(options: { create?: WorktreeMoveRuntime['checkouts']['create'] } = {}) {
  const bindings = new Map<string, GitCheckout>()
  const activity: ActivityKind[] = []
  const moves = new Map<string, AbortController>()
  const runtime: WorktreeMoveRuntime = {
    checkouts: {
      create: options.create ?? (async () => { throw new Error('no create in this test') }),
      refresh: async (cwd) => ({
        cwd,
        revision: 1,
        checkout: { repoRoot: repo, worktreePath: cwd, branch: git(cwd, 'branch', '--show-current'), targetBranch: 'main' },
      }) as never,
    },
    getGitContext: (sessionId) => bindings.get(sessionId),
    trackWorktreeMove: (sessionId, controller) => {
      moves.set(sessionId, controller)
      return () => { if (moves.get(sessionId) === controller) moves.delete(sessionId) }
    },
    moveSessionCheckout: (sessionId, checkout) => { bindings.set(sessionId, checkout) },
    recordActivity: async (subject, _actor, kind) => {
      activity.push(kind)
      return { ...kind, id: ulid(), subject, at: Date.now(), by: { kind: 'system' } } as Activity
    },
    nameWorktreeBranch: async () => {},
  }
  bindings.set('s1', { repoRoot: repo, branch: 'main', targetBranch: 'main' })
  return { runtime, bindings, activity, moves }
}

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

describe('worktreeAddPaths reads the paths a shell command creates worktrees at', () => {
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
      sessionRuntime.sessionCheckouts.moveSessionCheckout('moved-session', { repoRoot: repo, worktreePath: worktree, branch: 'feature', targetBranch: 'main' })
      const forkFor = (sessionRuntime.sessionCheckouts as unknown as {
        continueInMovedCheckout(request: { sessionId: string; target: { kind: string }; input: Partial<SessionRunInput> }): { target: { kind: string }; input: Partial<SessionRunInput> }
      }).continueInMovedCheckout.bind(sessionRuntime.sessionCheckouts)
      const request = { sessionId: 'moved-session', target: { kind: 'session' }, input: { provider: 'claude-code' as const, agentSessionId: 'thread-1', forked: false, workingDirectory: repo } }
      const first = forkFor(request)
      expect(first.target.kind).toBe('new-session')
      expect(first.input).toMatchObject({ forked: true, agentSessionId: 'thread-1', workingDirectory: worktree })
      // Only the first turn forks; the next one continues the forked thread.
      expect(forkFor(request)).toBe(request)
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
    offers.observe('s1', { type: 'tool_call', toolName: 'exec_command', toolId: 'c1', index: 0, toolInput: `/bin/zsh -lc 'git worktree add ${worktree}'` })
    offers.observe('s1', { type: 'tool_call_complete', index: 0, toolId: 'c1', outcome: { status: 'completed', exitCode: 0 } })
    await offers.settled('s1')
    expect(offered()).toMatchObject([{ path: worktree }])
  })

  test('a failed command, a path outside the repository, and a sub-agent call offer nothing', async () => {
    const { offers, offered } = offersHarness()
    await claudeTool(offers, 't1', 'Bash', { command: `git worktree add ${worktree}` }, 'fatal', true)
    await claudeTool(offers, 't2', 'Bash', { command: `git worktree add ${foreignWorktree}` })
    offers.observe('s1', { type: 'tool_call', toolName: 'Bash', toolId: 't3', index: 2, parentToolUseId: 'agent', toolInput: JSON.stringify({ command: `git worktree add ${worktree}` }) })
    offers.observe('s1', { type: 'tool_result', toolUseId: 't3', content: '', parentToolUseId: 'agent' })
    await offers.settled('s1')
    expect(offered()).toHaveLength(0)
  })

  test('a worktree the session is already bound to is not offered', async () => {
    const { offers, offered, bindings } = offersHarness()
    bindings.set('s1', { repoRoot: repo, worktreePath: worktree, branch: 'feature', targetBranch: 'main' })
    await claudeTool(offers, 't1', 'Bash', { command: `git worktree add ${worktree}` })
    expect(offered()).toHaveLength(0)
  })

  test('after Keep current the same worktree is not offered again', async () => {
    const { offers, offered } = offersHarness()
    await claudeTool(offers, 't1', 'Bash', { command: `git worktree add ${worktree}` })
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
    await claudeTool(offers, 't1', 'Bash', { command: `git worktree add ${worktree}` })
    expect(offered()).toHaveLength(1)
  })

  test('Switch moves the session, and the answer is recorded once', async () => {
    const { offers, offered, recorded, bindings } = offersHarness()
    await claudeTool(offers, 't1', 'Bash', { command: `git worktree add ${worktree}` })
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
