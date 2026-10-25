import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { NormalizedEvent, Session, SessionRunInput, Tab, WireNormalizedEvent } from '@solus/contracts/types'

/**
 * A first send that makes a worktree shows the host's setup card at once, not
 * one or more round trips later. The client card is the host's first card, so
 * the host's card replaces it with no change, and the client card goes by the
 * same paths as the host's card when the send stops or makes no worktree.
 */

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type TestGlobal = typeof globalThis & { $state?: unknown }
// SAFETY: This test installs the Svelte rune shim on the test process global and restores it after all cases.
const testGlobal = globalThis as TestGlobal
const previousState = testGlobal.$state
const previousDataDir = process.env.SOLUS_DATA_DIR
const dataDir = mkdtempSync(join(tmpdir(), 'solus-pending-worktree-'))

let setupCard: typeof import('@solus/contracts/setup-card')
let runLocation: typeof import('@solus/workspace-ui/contexts/workspace/run-location')
let showPendingWorktreeSetup: typeof import('@solus/workspace-ui/contexts/workspace/pending-setup-card')['showPendingWorktreeSetup']
let buildRemoteDispatchCard: typeof import('@solus/workspace-ui/lib/remote-dispatch-card')['buildRemoteDispatchCard']

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  testGlobal.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value, raw: <T>(value: T) => value })
  setupCard = await import('@solus/contracts/setup-card')
  runLocation = await import('@solus/workspace-ui/contexts/workspace/run-location')
  ;({ showPendingWorktreeSetup } = await import('@solus/workspace-ui/contexts/workspace/pending-setup-card'))
  ;({ buildRemoteDispatchCard } = await import('@solus/workspace-ui/lib/remote-dispatch-card'))
})

afterAll(async () => {
  const { closeDatabase } = await import('@solus/server/db/database')
  const { closeDb } = await import('@solus/server/db')
  await closeDatabase()
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  if (previousState === undefined) delete testGlobal.$state
  else testGlobal.$state = previousState
})

/** A draft's session in `/code/solus`, which asks for a worktree from `main`. */
function draftSession(newWorktree: { baseBranch: string | null } | null = { baseBranch: 'main' }): Session {
  return {
    id: 'session-1',
    status: 'connecting',
    statusCard: null,
    messages: [],
    outboundPrompts: [],
    permissionQueue: [],
    questionQueue: [],
    run: { location: runLocation.folderLocation({ serverId: 'local', path: '/code/solus' }, { newWorktree }) },
    task: { kind: 'none' },
  } as unknown as Session
}

async function reducerFor(session: Session) {
  const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
  const tab = { id: 'tab-1', sessionId: session.id } as Tab
  return new SessionEventReducer({
    sessions: { byId: { [session.id]: session } },
    registry: {
      tabs: { 'tab-1': tab },
      sessionFor: (tabId: string) => tabId === 'tab-1' ? session : undefined,
      tabIdsBySession: new Map([[session.id, ['tab-1']]]),
    },
    settings: { rateLimitBehavior: 'ask' },
    tasksStore: { refreshSessionBinding: async () => null, get: () => ({ trackSessionStart: () => {}, linkSession: () => new Promise(() => {}) }) },
    workStreamTracker: { sweep: () => {}, beginWorkStream: () => {} },
    onTurnSettled: () => {},
    refreshTurnSnapshots: () => {},
    isSessionVisible: () => true,
    publishSessionViewed: () => {},
    closePlanModal: () => {},
    playNotificationIfHidden: () => {},
    log: () => {},
  } as never)
}

describe('the worktree card at Send', () => {
  test('is the card the host publishes first', async () => {
    // WHY: the host's card replaces the client's card. If they differ, the card
    // changes on screen when the host answers.
    const { SessionRuntime } = await import('@solus/server/execution/session-runtime')
    const repository = mkdtempSync(join(dataDir, 'empty-repository-'))
    // No commit, so the host stops at its first step and starts no agent.
    execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'ignore' })
    // An agent that must never start: setup stops before it.
    const backend = Object.assign(new EventEmitter(), {
      startRun: () => { throw new Error('the agent started') },
      isSessionRunning: () => false,
      getPendingHandles: () => [],
      getEnrichedError: () => ({ message: 'failed', isError: true, stderrTail: [] }),
    })
    const runtime = new SessionRuntime(new Map([['codex', backend as never]]))
    runtime.on('error', () => {})
    const cards: Array<Extract<WireNormalizedEvent, { type: 'status_card' }>> = []
    runtime.on('event', (_sessionId: string, event: NormalizedEvent | WireNormalizedEvent) => {
      if (event.type === 'status_card') cards.push(event)
    })
    const input: SessionRunInput = {
      provider: 'codex', agentSessionId: null, forked: false, workingDirectory: repository, projectPath: repository,
      additionalDirs: [], gitContext: null, worktreeBaseBranch: 'main', contextWindow: null,
      model: 'gpt-requested', preferredModel: 'gpt-requested', reasoningEffort: 'medium', fastMode: false,
      permissionMode: 'supervised', rateLimitBehavior: 'queue', extraInstructions: '',
    }
    try {
      await runtime.runTurn({ target: { kind: 'new-session' }, sessionId: 'solus-pending', tools: [], input, options: { prompt: 'go' } }).catch(() => {})
      expect(cards[0]).toEqual({ type: 'status_card', card: setupCard.pendingWorktreeSetupCard('solus-pending', 'main') })
    } finally { runtime.shutdown() }
  })

  test('shows only when the host will make a worktree', () => {
    const session = draftSession()
    showPendingWorktreeSetup(session)
    expect(session.statusCard).toEqual(setupCard.pendingWorktreeSetupCard('session-1', 'main'))

    // WHY: the host makes no worktree without a base branch or in a worktree,
    // so a card there would announce work that never happens.
    const noBase = draftSession({ baseBranch: null })
    showPendingWorktreeSetup(noBase)
    expect(noBase.statusCard).toBeNull()
    const noRequest = draftSession(null)
    showPendingWorktreeSetup(noRequest)
    expect(noRequest.statusCard).toBeNull()
    const inWorktree = draftSession()
    inWorktree.run.location = runLocation.folderLocation(
      { serverId: 'local', path: '/code/solus' },
      { git: { repoRoot: '/code/solus', worktreePath: '/code/solus/.worktrees/a', branch: 'a', targetBranch: 'main' }, newWorktree: { baseBranch: 'main' } },
    )
    showPendingWorktreeSetup(inWorktree)
    expect(inWorktree.statusCard).toBeNull()
  })

  test('is not shown for a clone, whose host card starts with the repository', () => {
    // WHY: the host copies the repository before it makes the worktree. A
    // worktree card at Send would mark that copy done before it started.
    const session = draftSession()
    session.run.location = runLocation.chooseStart(
      runLocation.dispatchTo(session.run.location, 'studio', 'github.com/solus-sh/solus'),
      { kind: 'new-worktree', baseBranch: 'main' },
    )
    session.statusCard = buildRemoteDispatchCard({ tabId: 'tab-1', hostLabel: 'Studio', phase: 'repository' })
    showPendingWorktreeSetup(session)
    expect(session.statusCard?.steps.map((step) => [step.id, step.status]).slice(0, 2)).toEqual([['connection', 'done'], ['repository', 'active']])
  })

  test('a clone moves to the folder the host made for it', async () => {
    // WHY: the client no longer asks the host to prepare the clone before the
    // prompt, so the host's git context is how the run learns its folder.
    const session = draftSession()
    session.run.location = runLocation.dispatchTo(session.run.location, 'studio', 'github.com/solus-sh/solus')
    const reducer = await reducerFor(session)
    const checkout = '/srv/projects/.solus-dispatch/device/github.com/solus-sh/solus'
    reducer.apply('session-1', { type: 'git_context', gitContext: { repoRoot: checkout, branch: 'main', targetBranch: 'main' } })
    expect(runLocation.pendingClone(session.run)).toBeNull()
    expect(runLocation.runHost(session.run)).toBe('studio')
    expect(runLocation.workingPlace(session.run)).toEqual({ serverId: 'studio', path: checkout })
    // The project stays home: the run is a dispatch.
    expect(runLocation.projectHome(session.run)).toEqual({ serverId: 'local', path: '/code/solus' })
  })

  test('keeps the steps a remote host already finished', () => {
    // WHY: a send to a host that had to connect first shows one operation.
    const session = draftSession()
    session.statusCard = buildRemoteDispatchCard({ tabId: 'tab-1', hostLabel: 'Studio', phase: 'ready' })
    showPendingWorktreeSetup(session)
    expect(session.statusCard?.id).toStartWith('remote-dispatch-')
    expect(session.statusCard?.steps.map((step) => step.id)).toEqual(['connection', 'repository', 'fetch', 'checkout', 'submodules', 'agent'])
  })

  test('is replaced by the host card', async () => {
    const session = draftSession()
    showPendingWorktreeSetup(session)
    const reducer = await reducerFor(session)
    const hostCard = { ...setupCard.pendingWorktreeSetupCard('session-1', 'main'), title: 'Linking workspace' }
    reducer.apply('session-1', { type: 'status_card', card: hostCard })
    expect(session.statusCard).toEqual(hostCard)
  })

  test('goes when the session leaves connecting without a worktree', async () => {
    // WHY: the host found a worktree already, or started the run without one.
    const session = draftSession()
    showPendingWorktreeSetup(session)
    const reducer = await reducerFor(session)
    reducer.apply('session-1', { type: 'status_change', status: 'running', oldStatus: 'connecting' })
    expect(session.statusCard).toBeNull()
  })

  test('goes when the send fails or is stopped', async () => {
    // WHY: a refused or failed send has no setup going on; a spinning card would lie.
    const failed = draftSession()
    showPendingWorktreeSetup(failed)
    ;(await reducerFor(failed)).handleError('session-1', { message: 'refused', stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 })
    expect(failed.statusCard).toBeNull()

    const stopped = draftSession()
    showPendingWorktreeSetup(stopped)
    ;(await reducerFor(stopped)).interruptSession('session-1')
    expect(stopped.statusCard).toBeNull()
  })
})
