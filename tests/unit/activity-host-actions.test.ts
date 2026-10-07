import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Activity } from '@solus/contracts/activity'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import type { AgentBackend, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { AgentId, GitCheckout, IpcContext, NormalizedEvent } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// plans/012-user-actor-and-activity.md §5, stage 6: accepting a plan, a fork, a
// move into a worktree, an agent switch and a mention are facts the host records
// where it does the work, once, with who did it. The client writes no divider of
// its own, so every reader sees the same row, live and after a reload.

let dataDir: string
let db: typeof import('@solus/server/db')
let sessionRuntimeModule: typeof import('@solus/server/execution/session-runtime')
let activityModule: typeof import('@solus/server/data/activity/activity')
let works: typeof import('@solus/server/data/works/works')
let workEntity: typeof import('@solus/server/data/works/work')
let workAnnotations: typeof import('@solus/server/data/works/work-annotations')
let indexer: typeof import('@solus/server/db/session-indexer')
let lineage: typeof import('@solus/server/data/sessions/session-lineage')
let actors: typeof import('./helpers/actors')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-activity-actions-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  sessionRuntimeModule = await import('@solus/server/execution/session-runtime')
  activityModule = await import('@solus/server/data/activity/activity')
  works = await import('@solus/server/data/works/works')
  workEntity = await import('@solus/server/data/works/work')
  workAnnotations = await import('@solus/server/data/works/work-annotations')
  indexer = await import('@solus/server/db/session-indexer')
  lineage = await import('@solus/server/data/sessions/session-lineage')
  actors = await import('./helpers/actors')
})

const cleanups: Array<() => void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const BOB = { kind: 'user', user: { id: { kind: 'account', accountId: 'bob' }, displayName: 'Bob' } }

/** A backend whose runs stay busy until released, with a history to read back. */
function backend(id: AgentId, history: SessionLoadMessage[] = []) {
  const handles = new Map<string, RunHandle>()
  const releases: Array<() => void> = []
  const requests: AgentRunRequest[] = []
  const value = Object.assign(new EventEmitter(), {
    id,
    metadata: { id, label: id, models: [], defaultModel: '' },
    permissions: { getPendingInfo: () => undefined, respondToPermission: () => false, respondToQuestion: () => false, clearPendingForSession: () => {}, setCurrentSessionId: () => {} },
    getEnrichedError: () => ({ message: '', stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 }),
    isSessionRunning: (threadId: string) => handles.has(threadId),
    getSessionHandle: (threadId: string) => handles.get(threadId),
    cancelSession: (threadId: string) => {
      if (!handles.has(threadId)) return false
      queueMicrotask(() => { handles.delete(threadId); value.emit('exit', threadId, null, 'SIGINT') })
      return true
    },
    getPendingHandles: () => [],
    shutdown: () => {},
    loadSession: async () => history,
    startRun(request: AgentRunRequest): RunHandle {
      requests.push(request)
      let resolve!: () => void
      const runPromise = new Promise<void>((res) => { resolve = res })
      const threadId = `${id}-thread-${requests.length}`
      const handle: RunHandle = {
        agentSessionId: threadId,
        persistence: request.persistence,
        startedAt: Date.now(),
        toolCallCount: 0,
        sawPermissionRequest: false,
        permissionDenials: [],
        abortController: new AbortController(),
        runPromise,
        _resolveRun: resolve,
        _rejectRun: () => {},
      }
      handles.set(threadId, handle)
      releases.push(() => { handles.delete(threadId); resolve(); value.emit('exit', threadId, 0, null) })
      queueMicrotask(() => {
        value.emit('normalized', threadId, { type: 'session_init', sessionId: threadId, model: 'test', skills: [] } satisfies NormalizedEvent)
      })
      return handle
    },
  })
  return { value: value as unknown as AgentBackend, requests, releaseAll: () => { for (const release of releases.splice(0)) release() } }
}

function ctx(sessionId: string, agentSessionId: string | null = null, extra: { forked?: boolean; provider?: AgentId } = {}): IpcContext {
  return {
    session: { sessionId, provider: extra.provider ?? 'claude-code', agentSessionId, workingDirectory: '/tmp/project', origin: 'user', forked: extra.forked ?? false },
    window: {},
    settings: { activeAgent: 'claude-code' },
    statusBar: { model: null, reasoningEffort: 'medium', permissionMode: 'full-access' },
  } as unknown as IpcContext
}

/** A runtime on fake Claude and Codex backends, and every activity it sends, by session. */
function host(history: SessionLoadMessage[] = []) {
  const claude = backend('claude-code', history)
  const codex = backend('codex')
  const runtime = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', claude.value], ['codex', codex.value]]))
  runtime.on('error', () => {})
  cleanups.push(() => { claude.releaseAll(); codex.releaseAll(); runtime.shutdown() })
  const sent: Array<{ sessionId: string; activity: Activity }> = []
  runtime.on('event', (sessionId: string, event: NormalizedEvent) => {
    if (event.type === 'activity') sent.push({ sessionId, activity: event.activity })
  })
  return { runtime, claude, codex, sent }
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

describe('accepting a plan', () => {
  test('stops the planning run, starts a fresh agent session, and records one decision by the person', async () => {
    const { runtime, claude, sent } = host()
    const bob = actors.memberActor('bob', 'Bob')
    await runtime.dispatch.submitPrompt(ctx('s1'), { prompt: 'plan it' }, { actor: bob })
    await until(() => runtime.statuses.isSessionBusy('s1') && runtime.agentSessionIdFor('s1') === 'claude-code-thread-1')

    const result = await runtime.acceptPlan(ctx('s1', 'claude-code-thread-1'), { planId: 'claude-code-thread-1__tool-plan', startNewSession: true }, bob)

    // WHY: the planning run ends because the work moves on, not because Bob
    // stopped it, so there is no `stopped` row; the decision is one row, Bob's,
    // and it names the session that implements the plan (plans/012 §5).
    expect(result).toEqual({})
    expect(sent.map(({ activity }) => activity.kind)).toEqual(['plan_decided'])
    expect(sent[0].activity).toMatchObject({ kind: 'plan_decided', planId: 'claude-code-thread-1__tool-plan', decision: 'accepted', newSessionId: 's1', by: BOB })
    expect(runtime.statuses.isSessionBusy('s1')).toBe(false)
    expect(runtime.agentSessionIdFor('s1')).toBeUndefined()
    // After a reload the same row comes back.
    expect(await activityModule.activityFor('local', { kind: 'session', id: 's1' })).toEqual([sent[0].activity])
    claude.releaseAll()
  })

  test('keeping the plan session records the decision without a new session', async () => {
    const { runtime, sent } = host()
    const bob = actors.memberActor('bob', 'Bob')
    await runtime.acceptPlan(ctx('s2', 'thread-x'), { planId: 'thread-x__p', startNewSession: false }, bob)
    expect(sent.map(({ activity }) => activity)).toEqual([expect.objectContaining({ kind: 'plan_decided', decision: 'accepted', by: BOB })])
    expect(sent[0].activity).not.toHaveProperty('newSessionId')
  })
})

describe('a fork', () => {
  test('is recorded once, on the fork, when its first prompt forks the source thread; a move into a worktree is not a fork', async () => {
    const { runtime, claude, sent } = host()
    const bob = actors.memberActor('bob', 'Bob')
    const cara = actors.memberActor('cara', 'Cara')
    await runtime.dispatch.submitPrompt(ctx('s-source'), { prompt: 'start' }, { actor: bob })
    await until(() => runtime.agentSessionIdFor('s-source') === 'claude-code-thread-1')
    claude.releaseAll()
    await until(() => !runtime.statuses.isSessionBusy('s-source'))

    await runtime.dispatch.submitPrompt(ctx('s-fork', 'claude-code-thread-1', { forked: true }), { prompt: 'try another way' }, { actor: cara })
    await until(() => sent.length > 0)

    // WHY: the fork's divider is the host's record, made where the provider
    // thread is forked, so a reload and every reader show it (plans/012 §5).
    expect(sent).toEqual([{ sessionId: 's-fork', activity: expect.objectContaining({ kind: 'forked', sourceSessionId: 'claude-code-thread-1', subject: { kind: 'session', id: 's-fork' } }) }])
    expect(sent[0].activity.by).toMatchObject({ kind: 'user', user: { id: { kind: 'account', accountId: 'cara' } } })
    claude.releaseAll()
    await until(() => !runtime.statuses.isSessionBusy('s-fork'))

    // The source re-homed into a worktree forks its own active thread and stays
    // the same session: its move is recorded by the worktree handler, not here.
    const before = sent.length
    await runtime.dispatch.submitPrompt(ctx('s-source', 'claude-code-thread-1', { forked: true }), { prompt: 'continue in the worktree' }, { actor: bob })
    await until(() => claude.requests.length === 3)
    expect(sent.slice(before)).toEqual([])
    claude.releaseAll()
  })
})

describe('an agent switch', () => {
  const history: SessionLoadMessage[] = [
    { role: 'user', content: 'first', timestamp: 10 },
    { role: 'assistant', content: 'one', timestamp: 11 },
  ]

  async function historyCall(runtime: InstanceType<typeof sessionRuntimeModule.SessionRuntime>) {
    const handlers = new Map<string, (args: unknown[], ctx: unknown) => Promise<unknown>>()
    const { registerHistoryHandlers } = await import('@solus/server/transport/handlers/history-handlers')
    registerHistoryHandlers({ register: (method: string, handler: (args: unknown[], ctx: unknown) => Promise<unknown>) => { handlers.set(method, handler) } } as never, {
      sessionRuntime: runtime,
      events: { broadcast: () => {} } as never,
      agentIdFromContext: () => 'claude-code',
      exchangeProgress: () => undefined,
    })
    const { TEST_HANDLER_CTX } = await import('./helpers/handler-ctx')
    return (sessionId: string) => handlers.get('loadSession')!([sessionId, '/tmp/project', undefined, 'codex'], TEST_HANDLER_CTX) as Promise<Array<{ content: string; activity?: Activity }>>
  }

  test('is recorded by the person who switched, and shows once after a reload', async () => {
    const { runtime, sent } = host(history)
    indexer.persistIndexedSessionStart('thread-1', 'claude-code', '/tmp/project', '/tmp/project', 'claude-opus-5', 'high', 'first')
    const bob = actors.memberActor('bob', 'Bob')

    await runtime.handoffs.switchSessionProvider('solus-1', 'codex', 'thread-1', bob)

    expect(sent.map(({ activity }) => activity)).toEqual([expect.objectContaining({ kind: 'agent_switched', provider: 'codex', fromProvider: 'claude-code', fromModel: 'claude-opus-5', by: BOB })])
    // WHY: the lineage still rebuilds a divider for this handoff; the recorded
    // row takes its place, so the reader sees the switch once, named by who
    // made it (plans/012 §5).
    const loaded = await (await historyCall(runtime))('solus-1')
    const switches = loaded.filter((message) => message.activity?.kind === 'agent_switched')
    expect(switches).toHaveLength(1)
    expect(switches[0].activity).toMatchObject({ id: sent[0].activity.id, by: BOB, fromModel: 'claude-opus-5' })
  })

  test('from before the record existed still shows once, rebuilt from the lineage', async () => {
    const { runtime } = host(history)
    indexer.persistIndexedSessionStart('thread-2', 'claude-code', '/tmp/project', '/tmp/project', 'claude-opus-5', 'high', 'first')
    lineage.beginSessionHandoff({ sessionId: 'solus-2', sourceProvider: 'claude-code', sourceProviderSessionId: 'thread-2', targetProvider: 'codex', cwd: '/tmp/project' })

    const loaded = await (await historyCall(runtime))('solus-2')
    const switches = loaded.filter((message) => message.activity?.kind === 'agent_switched')
    expect(switches).toHaveLength(1)
    expect(switches[0].activity).toMatchObject({ provider: 'codex', fromProvider: 'claude-code', fromModel: 'claude-opus-5', by: { kind: 'system' } })
  })
})

describe('a move into a worktree', () => {
  test('is recorded by the handler that creates the worktree, with who moved it', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'solus-activity-repo-'))
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }))
    execFileSync('git', ['init', '-q', repo])
    const worktreePath = join(repo, '.git/solus/worktrees/solus-abc')
    const gitContext: GitCheckout = { repoRoot: repo, worktreePath, branch: 'solus/abc', targetBranch: 'main' }
    const recorded: unknown[][] = []
    const runtime = {
      checkouts: { create: async () => gitContext, refresh: async () => ({ checkout: gitContext }) },
      getGitContext: () => undefined,
      trackWorktreeMove: () => () => {},
      moveSessionCheckout: () => {},
      nameWorktreeBranch: async () => {},
      recordActivity: async (...args: unknown[]) => { recorded.push(args) },
    }
    const handlers = new Map<string, (args: unknown[], ctx: unknown) => Promise<unknown>>()
    const { registerWorktreeHandlers } = await import('@solus/server/transport/handlers/worktree-handlers')
    const { WorktreeMover } = await import('@solus/server/execution/sessions/worktree-move')
    registerWorktreeHandlers({ register: (method: string, handler: (args: unknown[], ctx: unknown) => Promise<unknown>) => { handlers.set(method, handler) } } as never, {
      sessionRuntime: runtime as never,
      events: { broadcast: () => {} } as never,
      worktreeMover: new WorktreeMover(runtime as never),
      worktreeOffers: {} as never,
    })
    const bob = actors.memberActor('bob', 'Bob')
    const ipc = { session: { sessionId: 's1', workingDirectory: repo, gitContext: null }, settings: {} } as unknown as IpcContext

    const result = await handlers.get('continueInWorktree')!([ipc, 'name it'], { actor: bob })

    expect(result).toEqual({ success: true, gitContext })
    expect(recorded).toEqual([[{ kind: 'session', id: 's1' }, bob, { kind: 'moved_to_worktree', path: worktreePath, branch: 'solus/abc' }]])
  })
})

describe('a mention', () => {
  const ann = { kind: 'account' as const, accountId: 'ann' }
  const mention = (id: string, name: string) => `[@${name}](person://ref?userId=${id})`

  test('in a work body is recorded when first saved, not again on an edit that keeps it, and reads as "mentions of this user"', async () => {
    const bob = { kind: 'user' as const, user: actors.accountUser('bob', 'Bob') }
    const created = await works.createWork('org-1', 'Spec', 'doc', `Hi ${mention('ann', 'Ann')}`, '', undefined, 'claude-code', '~', undefined, bob)
    const work = await workEntity.Work.byId('org-1', created.id)
    await work.updateContent({ content: `Hi ${mention('ann', 'Ann')}, see this`, author: bob, expectedContentVersion: work.contentVersion, reason: 'edit' })
    await work.updateContent({ content: `Hi ${mention('ann', 'Ann')} and ${mention('cara', 'Cara')}`, author: bob, expectedContentVersion: work.contentVersion, reason: 'edit' })

    const rows = await activityModule.activityFor('org-1', { kind: 'work', id: created.id })
    expect(rows.map((row) => row.kind === 'mentioned' && row.userId)).toEqual([ann, { kind: 'account', accountId: 'cara' }])
    expect(rows.every((row) => row.kind === 'mentioned' && row.by.kind === 'user' && row.by.user.displayName === 'Bob')).toBe(true)
    // WHY: the notifications hub asks for the mentions of one person (D15).
    const forAnn = await activityModule.activityFor('org-1', { targetUserId: ann, since: 0 })
    expect(forAnn).toEqual([rows[0]])
    // A person's own work outside an organization has no members to mention.
    await works.createWork('local', 'Notes', 'doc', `Hi ${mention('ann', 'Ann')}`, '', undefined, 'claude-code', '~', undefined, bob)
    expect(await activityModule.activityFor('local', { targetUserId: ann, since: 0 })).toEqual([])
  })

  test('in a comment is recorded once per message that first saves it', async () => {
    const bob = { kind: 'user' as const, user: actors.accountUser('bob', 'Bob') }
    const created = await works.createWork('org-1', 'Spec', 'doc', 'Body', '', undefined, 'claude-code', '~', undefined, bob)
    const actor = { by: bob, canModerate: true, now: 1 }
    await workAnnotations.applyWorkComment('org-1', created.id, { kind: 'add', comment: { id: 'c1', selectedText: 'Body', comment: `Look ${mention('ann', 'Ann')}` } }, actor)
    await workAnnotations.applyWorkComment('org-1', created.id, { kind: 'edit', commentId: 'c1', text: `Look again ${mention('ann', 'Ann')}` }, actor)
    await workAnnotations.applyWorkComment('org-1', created.id, { kind: 'reply', commentId: 'c1', reply: { id: 'r1', text: `Also ${mention('ann', 'Ann')}` } }, actor)

    const rows = await activityModule.activityFor('org-1', { targetUserId: ann, since: 0 })
    expect(rows.map((row) => row.kind === 'mentioned' && [row.subject.id, row.threadId])).toEqual([[created.id, 'c1'], [created.id, 'c1']])
  })
})
