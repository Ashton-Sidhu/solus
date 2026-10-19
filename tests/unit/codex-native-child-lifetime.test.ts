import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import type { NormalizedEvent } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']
let CodexTurnNormalizer: typeof import('@solus/server/execution/agents/codex/codex-event-normalizer')['CodexTurnNormalizer']
let CodexRpcError: typeof import('@solus/server/execution/agents/codex/codex-agent')['CodexRpcError']
beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
  ;({ CodexTurnNormalizer } = await import('@solus/server/execution/agents/codex/codex-event-normalizer'))
  ;({ CodexRpcError } = await import('@solus/server/execution/agents/codex/codex-agent'))
})

/** A turn as `thread/read` reports it. */
type ReadTurn = { id: string; status: 'inProgress' | 'completed' | 'interrupted' | 'failed'; items: Array<{ type: 'agentMessage'; text: string }> }

/** An app-server that answers every request and records it. */
class FakeAppServer extends EventEmitter {
  readonly requests: Array<{ method: string; params: unknown }> = []
  /** How `turn/interrupt` fails: Codex answers with this error, or never answers. */
  interruptFailure: { answered: string } | 'unanswered' | null = null
  /** The turns `thread/read` reports for a child thread; null never answers. */
  childTurns: ReadTurn[] | null = []
  async request(method: string, params: unknown): Promise<object> {
    this.requests.push({ method, params })
    if (method === 'turn/interrupt' && this.interruptFailure === 'unanswered') throw new Error('Request turn/interrupt timed out')
    if (method === 'turn/interrupt' && this.interruptFailure) throw new CodexRpcError(this.interruptFailure.answered, -32600)
    if (method === 'thread/read' && !this.childTurns) throw new Error('Request thread/read timed out')
    if (method === 'thread/read') return { thread: { turns: this.childTurns } }
    return {}
  }
}

type Normalizer = InstanceType<typeof CodexTurnNormalizer>
type RootRun = {
  agentSessionId: string
  threadId: string
  turnId: string
  client: FakeAppServer
  normalizer: Normalizer
  persistent: boolean
  persistence: 'session' | 'ephemeral'
  permissionMode: 'supervised'
  interrupted: boolean
  isCompaction: boolean
  abortController: AbortController
  toolCallCount: number
  _resolveRun(): void
}
type Internals = {
  activeRuns: Map<string, RootRun>
  idleThreads: Map<unknown, Map<string, ReturnType<typeof setTimeout>>>
  attachClient(client: unknown): void
  onNotification(message: { method: string; params: unknown }, client: unknown): void
  unloadIdleThread(client: unknown, threadId: string): Promise<void>
}

const ROOT = 'root-thread'
const CHILD = 'child-thread'

function setup() {
  const backend = new CodexBackend()
  const internals = backend as unknown as Internals
  const appServer = new FakeAppServer()
  internals.attachClient(appServer)
  const events: Array<{ sessionId: string; event: NormalizedEvent }> = []
  const exits: Array<number | null> = []
  const waitsEnded: string[] = []
  backend.on('normalized', (sessionId: string, event: NormalizedEvent) => events.push({ sessionId, event }))
  backend.on('exit', (_sessionId: string, code: number | null) => exits.push(code))
  backend.on('background-work-ended', (sessionId: string) => waitsEnded.push(sessionId))
  backend.on('error', () => {})
  const startRoot = (turnId: string, persistence: 'session' | 'ephemeral' = 'session'): RootRun => {
    const run: RootRun = {
      agentSessionId: ROOT, threadId: ROOT, turnId, client: appServer,
      normalizer: new CodexTurnNormalizer({ planMode: false }), persistent: false, persistence,
      permissionMode: 'supervised', interrupted: false, isCompaction: false,
      abortController: new AbortController(), toolCallCount: 0, _resolveRun() {},
    }
    internals.activeRuns.set(ROOT, run)
    return run
  }
  const send = (method: string, params: object) => internals.onNotification({ method, params }, appServer)
  /** The root turn ends; resolves once the backend reported its exit. */
  const completeRoot = async (turnId: string, status: 'completed' | 'failed' | 'interrupted') => {
    const exited = new Promise((resolve) => backend.once('exit', resolve))
    send('turn/completed', {
      threadId: ROOT,
      turn: { id: turnId, status, ...(status === 'failed' && { error: { message: 'Root failed' } }) },
    })
    await exited
  }
  const spawnChild = (spawnId: string) => {
    send('item/completed', { threadId: ROOT, item: { type: 'subAgentActivity', id: spawnId, kind: 'started', agentThreadId: CHILD, agentPath: '/root/audit' } })
    send('turn/started', { threadId: CHILD, turn: { id: `${spawnId}-turn`, status: 'inProgress' } })
  }
  const childEnds = (spawnId: string, status: 'completed' | 'failed' | 'interrupted', text?: string) =>
    send('turn/completed', { threadId: CHILD, turn: { id: `${spawnId}-turn`, status, items: text ? [{ type: 'agentMessage', text }] : [] } })
  const types = (from = 0) => events.slice(from).map(({ event }) => event.type)
  const reports = () => events.flatMap(({ event }) => event.type === 'tool_result' && event.isSubagentReport ? [event] : [])
  const settles = () => events.flatMap(({ event }) => event.type === 'background_task_settled' ? [event] : [])
  return { backend, internals, appServer, events, exits, waitsEnded, startRoot, send, completeRoot, spawnChild, childEnds, types, reports, settles }
}

describe('a Codex native child that outlives its root turn', () => {
  // WHY: Codex runs a native sub-agent on its own thread, so the root turn can
  // end first. The root settles at once and frees its queue; the child is the
  // session's background task, visible and stoppable, until it settles once.
  test.each(['completed', 'failed'] as const)('a %s root settles at once and leaves the child as background work', async (status: 'completed' | 'failed') => {
    const { backend, internals, events, exits, waitsEnded, startRoot, send, completeRoot, spawnChild, childEnds, types, settles } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')

    const before = events.length
    await completeRoot('root-turn', status)
    // Announced before the turn's result, as a command left running is.
    expect(types(before)).toEqual(['background_task_started', status === 'failed' ? 'error' : 'task_complete'])
    expect(events[before]!.event).toEqual({ type: 'background_task_started', taskId: CHILD, toolUseId: 'spawn-1' })
    expect(exits).toEqual([status === 'failed' ? 1 : 0])
    expect(internals.activeRuns.has(ROOT)).toBe(false)
    expect(backend.hasBackgroundTasks(ROOT)).toBe(true)

    const late = events.length
    send('item/completed', { threadId: CHILD, turnId: 'spawn-1-turn', item: { type: 'agentMessage', id: 'child-msg', text: 'Halfway.' } })
    childEnds('spawn-1', 'completed', 'Audit complete.')

    expect(events.slice(late).every(({ sessionId }) => sessionId === ROOT)).toBe(true)
    expect(events.slice(late).map(({ event }) => event)).toEqual([
      { type: 'assistant_message', text: 'Halfway.', parentToolUseId: 'spawn-1' },
      { type: 'tool_result', toolUseId: 'spawn-1', content: 'Audit complete.', isError: false, parentToolUseId: 'spawn-1', isSubagentReport: true },
      { type: 'background_task_settled', taskId: CHILD, toolUseId: 'spawn-1', status: 'completed' },
    ])
    // Nothing wakes the agent for it, so the session's wait ends, once.
    expect(waitsEnded).toEqual([ROOT])
    expect(backend.hasBackgroundTasks(ROOT)).toBe(false)
    expect(exits).toHaveLength(1)
    expect(settles()).toHaveLength(1)
  })

  test('a child that fails after its root settles its task as failed', async () => {
    const { startRoot, completeRoot, spawnChild, childEnds, settles, waitsEnded } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')
    await completeRoot('root-turn', 'completed')
    childEnds('spawn-1', 'failed')
    expect(settles().map((settle) => settle.status)).toEqual(['failed'])
    expect(waitsEnded).toEqual([ROOT])
  })

  test('a repeated child end reports and settles once', async () => {
    const { backend, events, startRoot, send, completeRoot, spawnChild, childEnds, reports, settles, waitsEnded } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')
    await completeRoot('root-turn', 'completed')

    childEnds('spawn-1', 'completed', 'Done once.')
    const settled = events.length
    childEnds('spawn-1', 'completed', 'Done once.')
    send('item/agentMessage/delta', { threadId: CHILD, turnId: 'spawn-1-turn', delta: 'stale' })

    expect(events).toHaveLength(settled)
    expect(reports()).toHaveLength(1)
    expect(settles()).toHaveLength(1)
    expect(waitsEnded).toHaveLength(1)
    expect(backend.cancelSession(ROOT)).toBe(false)
  })

  // WHY: Codex can send a spawn record twice (item/started and
  // item/completed), and a replay sends it again. That is no new work: a child
  // whose turn ended must not come back as a task that never settles.
  test('a repeated spawn record does not bring back a child whose turn ended', async () => {
    const { backend, events, send, startRoot, completeRoot, spawnChild, childEnds, types } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')
    childEnds('spawn-1', 'completed')
    const spawn = { threadId: ROOT, item: { type: 'subAgentActivity', id: 'spawn-1', kind: 'started', agentThreadId: CHILD, agentPath: '/root/audit' } }
    send('item/started', spawn)
    send('item/completed', spawn)
    const before = events.length
    await completeRoot('root-turn', 'completed')

    expect(types(before)).toEqual(['task_complete'])
    expect(backend.hasBackgroundTasks(ROOT)).toBe(false)
  })

  test('a child that settled during the root turn is not background work', async () => {
    const { backend, events, startRoot, completeRoot, spawnChild, childEnds, types } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')
    childEnds('spawn-1', 'completed')
    const before = events.length
    await completeRoot('root-turn', 'completed')

    expect(types(before)).toEqual(['task_complete'])
    expect(backend.hasBackgroundTasks(ROOT)).toBe(false)
    const after = events.length
    childEnds('spawn-1', 'completed')
    expect(events).toHaveLength(after)
  })

  // WHY: a child's non-card output must not change the session it outlived:
  // its usage is not the session's context, and it has no turn to complete.
  test('only sub-agent card events leave a detached child', async () => {
    const { events, startRoot, send, completeRoot, spawnChild } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')
    await completeRoot('root-turn', 'completed')
    const before = events.length

    send('thread/tokenUsage/updated', { threadId: CHILD, tokenUsage: { last: { totalTokens: 900, inputTokens: 800, outputTokens: 100 }, total: { totalTokens: 900, inputTokens: 800, outputTokens: 100 } } })
    send('turn/started', { threadId: CHILD, turn: { id: 'spawn-1-turn-2', status: 'inProgress' } })

    expect(events.slice(before).map(({ event }) => event)).toEqual([{ type: 'subagent_running', toolUseId: 'spawn-1' }])
  })

  test('an ephemeral root keeps no child: its events never reach a session', async () => {
    const { backend, events, startRoot, completeRoot, spawnChild, childEnds, types } = setup()
    startRoot('root-turn', 'ephemeral')
    spawnChild('spawn-1')
    const before = events.length
    await completeRoot('root-turn', 'completed')
    expect(types(before)).toEqual(['task_complete'])
    expect(backend.hasBackgroundTasks(ROOT)).toBe(false)
    const after = events.length
    childEnds('spawn-1', 'completed')
    expect(events).toHaveLength(after)
  })
})

describe('a Codex native child and the next root turn', () => {
  // WHY: the next root run has its own normalizer, which does not know the old
  // card. Routed there, a child's end reads as the root's own turn end.
  test('a late child goes to its old card, never to the next root run', async () => {
    const { backend, events, exits, waitsEnded, startRoot, completeRoot, spawnChild, childEnds, reports, settles } = setup()
    startRoot('root-turn-1')
    spawnChild('spawn-1')
    await completeRoot('root-turn-1', 'failed')

    const next = startRoot('root-turn-2')
    const nextPush = mock(next.normalizer.push.bind(next.normalizer))
    next.normalizer.push = nextPush
    childEnds('spawn-1', 'completed', 'Late report.')

    expect(nextPush).not.toHaveBeenCalled()
    expect(reports().map((report) => report.toolUseId)).toEqual(['spawn-1'])
    expect(settles().map((settle) => settle.status)).toEqual(['completed'])
    expect(events.some(({ event }) => event.type === 'task_complete')).toBe(false)
    // A turn is running, so it, not this child, settles the session.
    expect(waitsEnded).toEqual([])

    await completeRoot('root-turn-2', 'completed')
    expect(exits).toEqual([1, 0])
    expect(backend.hasBackgroundTasks(ROOT)).toBe(false)
  })

  test('a child still working when the next root turn ends stays one background task', async () => {
    const { backend, startRoot, completeRoot, spawnChild, events } = setup()
    startRoot('root-turn-1')
    spawnChild('spawn-1')
    await completeRoot('root-turn-1', 'completed')
    startRoot('root-turn-2')
    await completeRoot('root-turn-2', 'completed')
    expect(events.filter(({ event }) => event.type === 'background_task_started')).toHaveLength(1)
    expect(backend.hasBackgroundTasks(ROOT)).toBe(true)
  })

  test('a later root run that links the child again takes it over, and the old task settles once', async () => {
    const { startRoot, completeRoot, spawnChild, childEnds, reports, settles } = setup()
    startRoot('root-turn-1')
    spawnChild('spawn-1')
    await completeRoot('root-turn-1', 'completed')

    startRoot('root-turn-2')
    spawnChild('spawn-2')
    childEnds('spawn-2', 'completed')

    expect(settles().map((settle) => [settle.toolUseId, settle.status])).toEqual([['spawn-1', 'completed']])
    expect(reports().map((report) => report.toolUseId)).toEqual(['spawn-2'])
  })
})

describe('stopping and releasing a Codex native child', () => {
  test('the background row stops the child: its turn is interrupted and its task settles as stopped', async () => {
    const { backend, appServer, startRoot, completeRoot, spawnChild, childEnds, reports, settles, waitsEnded } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')
    await completeRoot('root-turn', 'completed')

    expect(await backend.stopBackgroundTask(ROOT, CHILD)).toBe(true)
    expect(appServer.requests).toContainEqual({ method: 'turn/interrupt', params: { threadId: CHILD, turnId: 'spawn-1-turn' } })
    childEnds('spawn-1', 'interrupted')

    expect(reports().map((report) => [report.content, report.isError])).toEqual([['Interrupted', true]])
    expect(settles().map((settle) => settle.status)).toEqual(['stopped'])
    // A stopped task ends the wait through its own settle.
    expect(waitsEnded).toEqual([])
    expect(backend.hasBackgroundTasks(ROOT)).toBe(false)
  })

  test('a task that is not this session’s child is not stopped', async () => {
    const { backend, appServer, startRoot, completeRoot, spawnChild } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')
    await completeRoot('root-turn', 'completed')
    expect(await backend.stopBackgroundTask('other-thread', CHILD)).toBe(false)
    expect(await backend.stopBackgroundTask(ROOT, 'unknown-task')).toBe(false)
    expect(appServer.requests.some(({ method }) => method === 'turn/interrupt')).toBe(false)
  })

  // WHY: an error answer to turn/interrupt does not say the turn ended. Only
  // what Codex reports for the thread may settle the task; otherwise the task
  // stays visible, and Stop answers false so the person can try again.
  test('an unrelated error answer leaves a still-running child visible and stoppable', async () => {
    const { backend, appServer, startRoot, completeRoot, spawnChild, childEnds, settles } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')
    await completeRoot('root-turn', 'completed')
    appServer.interruptFailure = { answered: 'Internal error' }
    appServer.childTurns = [{ id: 'spawn-1-turn', status: 'inProgress', items: [] }]

    expect(await backend.stopBackgroundTask(ROOT, CHILD)).toBe(false)
    expect(appServer.requests).toContainEqual({ method: 'thread/read', params: { threadId: CHILD, includeTurns: true } })
    expect(settles()).toEqual([])
    expect(backend.hasBackgroundTasks(ROOT)).toBe(true)
    // The failed Stop is forgotten: the child's own end settles as it ended.
    childEnds('spawn-1', 'completed', 'Finished anyway.')
    expect(settles().map((settle) => settle.status)).toEqual(['completed'])
  })

  test('an error answer for a turn that already ended settles the task as Codex reports it', async () => {
    const { backend, appServer, startRoot, completeRoot, spawnChild, reports, settles } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')
    await completeRoot('root-turn', 'completed')
    appServer.interruptFailure = { answered: 'no active turn to interrupt' }
    appServer.childTurns = [{ id: 'spawn-1-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Already done.' }] }]

    expect(await backend.stopBackgroundTask(ROOT, CHILD)).toBe(true)
    expect(reports().map((report) => report.content)).toEqual(['Already done.'])
    expect(settles().map((settle) => settle.status)).toEqual(['completed'])
    expect(backend.hasBackgroundTasks(ROOT)).toBe(false)
  })

  test('a Stop with no answer, to the interrupt or to the read, stays to stop again', async () => {
    const { backend, appServer, startRoot, completeRoot, spawnChild, settles } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')
    await completeRoot('root-turn', 'completed')

    appServer.interruptFailure = 'unanswered'
    expect(await backend.stopBackgroundTask(ROOT, CHILD)).toBe(false)
    appServer.interruptFailure = { answered: 'no active turn to interrupt' }
    appServer.childTurns = null
    expect(await backend.stopBackgroundTask(ROOT, CHILD)).toBe(false)
    expect(settles()).toEqual([])
    expect(backend.hasBackgroundTasks(ROOT)).toBe(true)
  })

  // WHY: Codex sends the spawn record before the child's turn/started, so a
  // root can end between the two. Stop then has no turn id yet; it must not
  // leave a visible task that nothing can stop.
  test('a Stop before the child turn starts interrupts that turn as soon as it starts', async () => {
    const { backend, appServer, send, startRoot, completeRoot, childEnds, settles } = setup()
    startRoot('root-turn')
    send('item/completed', { threadId: ROOT, item: { type: 'subAgentActivity', id: 'spawn-1', kind: 'started', agentThreadId: CHILD, agentPath: '/root/audit' } })
    await completeRoot('root-turn', 'completed')
    expect(backend.hasBackgroundTasks(ROOT)).toBe(true)

    appServer.childTurns = []
    expect(await backend.stopBackgroundTask(ROOT, CHILD)).toBe(true)
    expect(appServer.requests.some(({ method }) => method === 'turn/interrupt')).toBe(false)

    send('turn/started', { threadId: CHILD, turn: { id: 'spawn-1-turn', status: 'inProgress' } })
    expect(appServer.requests).toContainEqual({ method: 'turn/interrupt', params: { threadId: CHILD, turnId: 'spawn-1-turn' } })
    childEnds('spawn-1', 'interrupted')
    expect(settles().map((settle) => settle.status)).toEqual(['stopped'])
  })

  test('a child whose turn/started came before its spawn record is stopped through the thread read', async () => {
    const { backend, appServer, send, startRoot, completeRoot, childEnds, settles } = setup()
    startRoot('root-turn')
    // Not yet linked to this session, so the turn start finds no owner.
    send('turn/started', { threadId: CHILD, turn: { id: 'spawn-1-turn', status: 'inProgress' } })
    send('item/completed', { threadId: ROOT, item: { type: 'subAgentActivity', id: 'spawn-1', kind: 'started', agentThreadId: CHILD, agentPath: '/root/audit' } })
    await completeRoot('root-turn', 'completed')

    appServer.childTurns = [{ id: 'spawn-1-turn', status: 'inProgress', items: [] }]
    expect(await backend.stopBackgroundTask(ROOT, CHILD)).toBe(true)
    expect(appServer.requests).toContainEqual({ method: 'turn/interrupt', params: { threadId: CHILD, turnId: 'spawn-1-turn' } })
    childEnds('spawn-1', 'interrupted')
    expect(settles().map((settle) => settle.status)).toEqual(['stopped'])
  })

  test('Stop on the session in background interrupts the child', async () => {
    const { backend, appServer, startRoot, completeRoot, spawnChild, childEnds, settles } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')
    await completeRoot('root-turn', 'completed')

    expect(backend.cancelSession(ROOT)).toBe(true)
    expect(appServer.requests).toContainEqual({ method: 'turn/interrupt', params: { threadId: CHILD, turnId: 'spawn-1-turn' } })
    childEnds('spawn-1', 'interrupted')
    expect(settles().map((settle) => settle.status)).toEqual(['stopped'])
  })

  test('Stop during the root turn interrupts its children too, and the interrupted root keeps none', async () => {
    const { backend, appServer, events, startRoot, completeRoot, spawnChild, childEnds, types } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')

    expect(backend.cancelSession(ROOT)).toBe(true)
    expect(appServer.requests.map(({ method, params }) => [method, params])).toEqual(expect.arrayContaining([
      ['turn/interrupt', { threadId: ROOT, turnId: 'root-turn' }],
      ['turn/interrupt', { threadId: CHILD, turnId: 'spawn-1-turn' }],
    ]))
    const before = events.length
    await completeRoot('root-turn', 'interrupted')
    expect(types(before)).not.toContain('background_task_started')
    expect(backend.hasBackgroundTasks(ROOT)).toBe(false)
    const after = events.length
    childEnds('spawn-1', 'interrupted')
    expect(events).toHaveLength(after)
  })

  test('an app-server exit settles its detached children as killed', async () => {
    const { backend, appServer, startRoot, completeRoot, spawnChild, reports, settles, waitsEnded } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')
    await completeRoot('root-turn', 'completed')

    appServer.emit('exit')

    expect(reports().map((report) => [report.content, report.isError])).toEqual([['Codex app-server exited', true]])
    expect(settles().map((settle) => settle.status)).toEqual(['killed'])
    expect(waitsEnded).toEqual([])
    expect(backend.hasBackgroundTasks(ROOT)).toBe(false)
  })

  test('shutdown releases detached children without reporting them', async () => {
    const { backend, events, startRoot, completeRoot, spawnChild, childEnds } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')
    await completeRoot('root-turn', 'completed')
    ;(backend as unknown as { client: { shutdown(): void } }).client = { shutdown() {} }

    backend.shutdown()
    const before = events.length
    childEnds('spawn-1', 'completed')
    expect(events).toHaveLength(before)
  })

  // WHY: unloading the root thread can end the children it started. The
  // thread stays loaded while one works, and its idle clock restarts after.
  test('the root thread is not unloaded while a detached child works', async () => {
    const { internals, appServer, startRoot, completeRoot, spawnChild, childEnds } = setup()
    startRoot('root-turn')
    spawnChild('spawn-1')
    await completeRoot('root-turn', 'completed')

    await internals.unloadIdleThread(appServer, ROOT)
    expect(appServer.requests.some(({ method }) => method === 'thread/unsubscribe')).toBe(false)

    // The idle clock that fired is spent.
    clearTimeout(internals.idleThreads.get(appServer)?.get(ROOT))
    internals.idleThreads.get(appServer)?.delete(ROOT)
    childEnds('spawn-1', 'completed')
    expect(internals.idleThreads.get(appServer)?.has(ROOT)).toBe(true)
    await internals.unloadIdleThread(appServer, ROOT)
    expect(appServer.requests).toContainEqual({ method: 'thread/unsubscribe', params: { threadId: ROOT } })
  })
})
