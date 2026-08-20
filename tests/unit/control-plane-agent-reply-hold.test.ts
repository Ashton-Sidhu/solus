import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/agents/agent-backend'
import type { AgentRunRequest, AgentRunSessionState } from '@solus/server/agents/agent-runner'
import type {
  AgentMetadata,
  IpcContext,
  NormalizedEvent,
  SessionRunInput,
  SessionStatus,
} from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let ControlPlane: typeof import('@solus/server/control-plane')['ControlPlane']
type ControlPlaneInstance = import('@solus/server/control-plane').ControlPlane

beforeAll(async () => {
  ;({ ControlPlane } = await import('@solus/server/control-plane'))
})

class FakePermissions implements PermissionResponder {
  getPendingInfo(): undefined { return undefined }
  respondToPermission(): boolean { return false }
  respondToQuestion(): boolean { return false }
  clearPendingForSession(): void {}
  setCurrentSessionId(): void {}
}

class FakeBackend extends EventEmitter implements AgentBackend {
  readonly id = 'codex' as const
  readonly metadata: AgentMetadata = {
    id: 'codex',
    label: 'Codex',
    models: [],
    defaultModel: '',
  }
  readonly permissions = new FakePermissions()
  readonly inputs: AgentRunRequest[] = []
  private handles = new Map<string, RunHandle>()
  private pendingHandles = new Set<RunHandle>()
  private running = new Set<string>()

  startRun(input: AgentRunRequest, _sessionState?: AgentRunSessionState): RunHandle {
    this.inputs.push(input)
    this.emit('run-started', input)
    const sessionId = input.sessionId ?? `session-${this.inputs.length}`
    let resolveRun!: () => void
    let rejectRun!: (error: Error) => void
    const runPromise = new Promise<void>((resolve, reject) => {
      resolveRun = resolve
      rejectRun = reject
    })
    const handle: RunHandle = {
      agentSessionId: input.sessionId ?? null,
      persistence: input.persistence,
      sessionId: input.sessionId,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController: new AbortController(),
      runPromise,
      _resolveRun: resolveRun,
      _rejectRun: rejectRun,
    }
    this.pendingHandles.add(handle)
    handle.abortController.signal.addEventListener('abort', () => {
      this.pendingHandles.delete(handle)
      rejectRun(new Error('Interrupted'))
    }, { once: true })
    queueMicrotask(() => {
      if (handle.abortController.signal.aborted) return
      handle.agentSessionId = sessionId
      this.pendingHandles.delete(handle)
      this.handles.set(sessionId, handle)
      this.running.add(sessionId)
      this.emit('normalized', sessionId, {
        type: 'session_init',
        sessionId,
        model: input.model ?? '',
        skills: [],
      } satisfies NormalizedEvent)
    })
    return handle
  }

  complete(sessionId: string, result: string): void {
    const handle = this.handles.get(sessionId)
    if (!handle) throw new Error(`Unknown session ${sessionId}`)
    this.emit('normalized', sessionId, {
      type: 'task_complete',
      result,
      costUsd: 0,
      durationMs: 1,
      numTurns: 1,
      usage: {},
      sessionId,
    } satisfies NormalizedEvent)
    handle._resolveRun()
    this.running.delete(sessionId)
    this.emit('exit', sessionId, 0, null)
  }

  rateLimit(sessionId: string): void {
    const handle = this.handles.get(sessionId)
    if (!handle) throw new Error(`Unknown session ${sessionId}`)
    this.emit('normalized', sessionId, {
      type: 'rate_limit',
      status: 'limited',
      resetsAt: Math.ceil(Date.now() / 1000) + 3_600,
      rateLimitType: 'test-limit',
      isUsingOverage: false,
    } satisfies NormalizedEvent)
    handle._rejectRun(new Error('Provider rate limited'))
    this.running.delete(sessionId)
    this.emit('error', sessionId, new Error('Provider rate limited'))
  }

  cancelSession(sessionId: string): boolean {
    if (!this.running.delete(sessionId)) return false
    this.handles.get(sessionId)?.abortController.abort()
    return true
  }

  isSessionRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  getSessionHandle(sessionId: string): RunHandle | undefined {
    return this.handles.get(sessionId)
  }

  getPendingHandles(): RunHandle[] {
    return [...this.pendingHandles]
  }

  getEnrichedError() {
    return { message: 'error', isError: true, stderrTail: [] }
  }

  async listSessions() { return [] }
  async loadSession() { return [] }
  async listPlans() { return [] }
  async loadPlanContent() { return null }
  async listPluginCommands() { return { commands: [] } }
  async refreshPluginCommands() {}
}

function runInput(agentSessionId: string): SessionRunInput {
  return {
    provider: 'codex',
    agentSessionId,
    forked: false,
    workingDirectory: process.cwd(),
    projectPath: process.cwd(),
    additionalDirs: [],
    gitContext: null,
    worktreeBaseBranch: null,
    sessionChangedFiles: [],
    contextWindow: null,
    model: 'test-model',
    preferredModel: 'test-model',
    reasoningEffort: 'medium',
    fastMode: false,
    permissionMode: 'ask',
    rateLimitBehavior: 'queue',
    extraInstructions: '',
  }
}

async function startSession(
  plane: ControlPlaneInstance,
  agentSessionId: string,
  sourceClientId?: string,
) {
  const lifecycle = await plane.runTurn({
    input: runInput(agentSessionId),
    target: { kind: 'session', sessionId: agentSessionId },
    sessionId: agentSessionId,
    tools: [],
    sourceClientId,
    options: { prompt: `Start ${agentSessionId}`, clientPromptId: `turn-${agentSessionId}` },
  })
  await lifecycle.agentSessionId
  return lifecycle
}

function setup() {
  const backend = new FakeBackend()
  const plane = new ControlPlane(new Map([['codex', backend]]))
  const events: Array<{ sessionId: string; event: NormalizedEvent }> = []
  const statuses: Array<{ sessionId: string; status: SessionStatus }> = []
  plane.on('event', (sessionId: string, event: NormalizedEvent) => events.push({ sessionId, event }))
  plane.on('session-status', (event: { sessionId: string; status: SessionStatus }) => statuses.push(event))
  return { backend, plane, events, statuses }
}

function watchCount(plane: ControlPlaneInstance, callerSessionId: string): number {
  const watches = (plane as unknown as {
    agentConversationWatches: Map<string, Map<string, unknown[]>>
  }).agentConversationWatches
  let count = 0
  for (const callers of watches.values()) count += callers.get(callerSessionId)?.length ?? 0
  return count
}

const planes: ControlPlaneInstance[] = []

afterEach(() => {
  for (const plane of planes.splice(0)) plane.shutdown()
})

describe('ControlPlane agent reply hold', () => {
  test('publishes one identified settlement after the provider result', async () => {
    // WHY: clients must never infer the real turn boundary from provider result
    // ordering, status transitions, or rendered subagent cards.
    const env = setup()
    planes.push(env.plane)
    env.plane.watchSession({ sessionId: 'ordered' }, 'test')
    const lifecycle = await startSession(env.plane, 'ordered', 'test')
    env.events.splice(0, env.events.length)

    env.backend.complete('ordered', 'Done')
    await lifecycle.done
    await Promise.resolve()

    const turnEvents = env.events
      .filter(({ sessionId }) => sessionId === 'ordered')
      .map(({ event }) => event)
    const resultIndex = turnEvents.findIndex((event) => event.type === 'task_complete')
    const settlements = turnEvents.filter((event) => event.type === 'turn_settled')
    const settlementIndex = turnEvents.findIndex((event) => event.type === 'turn_settled')

    expect(resultIndex).toBeGreaterThanOrEqual(0)
    expect(settlementIndex).toBeGreaterThan(resultIndex)
    expect(settlements).toEqual([{
      type: 'turn_settled',
      turnId: 'turn-ordered',
      outcome: 'completed',
      settledAt: expect.any(Number),
    }])
  })

  test('does not settle while background work is still owned by the turn', async () => {
    // WHY: provider task_complete can precede the last subagent by minutes. The
    // Solus boundary must stay absent until the control plane releases the hold.
    const env = setup()
    planes.push(env.plane)
    env.plane.watchSession({ sessionId: 'background' }, 'test')
    const lifecycle = await startSession(env.plane, 'background', 'test')
    env.events.splice(0, env.events.length)

    env.backend.emit('normalized', 'background', {
      type: 'background_task_started',
      taskId: 'child-1',
    } satisfies NormalizedEvent)
    env.backend.emit('normalized', 'background', {
      type: 'task_complete',
      result: 'Parent result',
      costUsd: 0,
      durationMs: 1,
      numTurns: 1,
      usage: {},
      sessionId: 'background',
    } satisfies NormalizedEvent)
    await Promise.resolve()

    expect(env.events.some(({ event }) => event.type === 'turn_settled')).toBe(false)
    expect(env.statuses.filter(({ sessionId }) => sessionId === 'background').at(-1)?.status).toBe('running')

    env.backend.emit('normalized', 'background', {
      type: 'background_task_settled',
      taskId: 'child-1',
      status: 'completed',
    } satisfies NormalizedEvent)
    env.backend.complete('background', 'Final result')
    await lifecycle.done
    await Promise.resolve()

    expect(env.events.filter(({ event }) => event.type === 'turn_settled')).toHaveLength(1)
  })

  test('keeps a caller running when its run exits while a notifying watch is armed', async () => {
    // WHY: a peer conversation will resume automatically, so the tab must not
    // look finished during the gap between the caller's runs.
    const env = setup()
    planes.push(env.plane)
    env.plane.watchSession({ sessionId: 'caller' }, 'test')
    const caller = await startSession(env.plane, 'caller', 'test')
    const peer = await startSession(env.plane, 'peer')
    env.plane.watchSessionSettled('peer', 'caller', {
      exchangeId: 'exchange-1',
      dispatchedAt: Date.now(),
      notifyModel: true,
      runKey: 'active',
    })

    env.backend.complete('caller', 'Waiting for peer')
    await caller.done
    expect(env.statuses.filter((event) => event.sessionId === 'caller').at(-1)?.status).toBe('running')
  })

  test('releases the hold after the peer settles and the report run completes', async () => {
    // WHY: the hold is temporary; consuming the peer reply must not strand the
    // caller in the Running section forever.
    const env = setup()
    planes.push(env.plane)
    env.plane.watchSession({ sessionId: 'caller' }, 'test')
    const caller = await startSession(env.plane, 'caller', 'test')
    const peer = await startSession(env.plane, 'peer')
    env.plane.watchSessionSettled('peer', 'caller', {
      exchangeId: 'exchange-1',
      dispatchedAt: Date.now(),
      notifyModel: true,
      runKey: 'active',
    })
    env.backend.complete('caller', 'Waiting for peer')
    await caller.done

    const reportRunStarted = new Promise<AgentRunRequest>((resolve) => {
      env.backend.once('run-started', resolve)
    })
    env.backend.complete('peer', 'Peer reply')
    await peer.done
    expect((await reportRunStarted).sessionId).toBe('caller')

    // The report run resumes the caller from disk now that its record is gone,
    // so let its handle register before completing it.
    for (let i = 0; i < 5; i++) await Promise.resolve()
    env.backend.complete('caller', 'Conversation finished')
    expect(env.statuses.filter((event) => event.sessionId === 'caller').at(-1)?.status).toBe('completed')
  })

  test('does not hold a fire-and-forget caller', async () => {
    // WHY: notify_on_completion=false has no future model turn to wait for.
    const env = setup()
    planes.push(env.plane)
    env.plane.watchSession({ sessionId: 'caller' }, 'test')
    const caller = await startSession(env.plane, 'caller', 'test')
    const peer = await startSession(env.plane, 'peer')
    env.plane.watchSessionSettled('peer', 'caller', {
      exchangeId: 'exchange-1',
      dispatchedAt: Date.now(),
      notifyModel: false,
      runKey: 'active',
    })

    env.backend.complete('caller', 'Dispatched')
    await caller.done
    expect(env.statuses.filter((event) => event.sessionId === 'caller').at(-1)?.status).toBe('completed')
  })

  test('keeps a peer watch parked when the provider rate limits its run', async () => {
    // WHY: a rate-limited attempt is still pending work. Reporting its rejected
    // provider call as a failed peer makes the caller session look errored while
    // Solus is waiting to retry the same prompt.
    const env = setup()
    planes.push(env.plane)
    await startSession(env.plane, 'caller', 'test')
    const peer = await startSession(env.plane, 'peer')
    env.plane.watchSessionSettled('peer', 'caller', {
      exchangeId: 'exchange-1',
      dispatchedAt: Date.now(),
      notifyModel: true,
      runKey: 'active',
    })

    env.backend.rateLimit('peer')
    await peer.done.catch(() => {})
    await Promise.resolve()

    Reflect.get(env.plane, '_checkActiveRuns').call(env.plane)

    expect(env.statuses.filter((event) => event.sessionId === 'peer').at(-1)?.status).toBe('rate_limited')
    expect(env.events.some(({ sessionId, event }) =>
      sessionId === 'peer' && event.type === 'session_dead'
    )).toBe(false)
    expect(watchCount(env.plane, 'caller')).toBe(1)
    expect(env.events.some(({ event }) =>
      event.type === 'agent_conversation_update'
      && event.update.phase === 'settled'
      && event.update.status === 'failed'
    )).toBe(false)
  })

  test('the tab Stop action disarms a held reply and settles its exchange card', async () => {
    // WHY: Stop must cancel the parked continuation so a late peer reply cannot
    // resurrect the caller, and its card must not shimmer forever.
    const env = setup()
    planes.push(env.plane)
    env.plane.watchSession({ sessionId: 'caller' }, 'test')
    const caller = await startSession(env.plane, 'caller', 'test')
    const peer = await startSession(env.plane, 'peer')
    env.plane.watchSessionSettled('peer', 'caller', {
      exchangeId: 'exchange-1',
      dispatchedAt: Date.now(),
      notifyModel: true,
      runKey: 'active',
    })
    env.backend.complete('caller', 'Waiting for peer')
    await caller.done

    const stopped = env.plane.stopSession('caller')

    expect(stopped).toBe(true)
    expect(env.statuses.filter((event) => event.sessionId === 'caller').at(-1)?.status).toBe('interrupted')
    expect(watchCount(env.plane, 'caller')).toBe(0)
    expect(env.events.at(-1)).toMatchObject({
      sessionId: 'caller',
      event: {
        type: 'status_change',
        status: 'interrupted',
      },
    })
    expect(env.events.some(({ event }) =>
      event.type === 'agent_conversation_update'
      && event.update.phase === 'settled'
      && event.update.status === 'interrupted'
      && event.update.replyText === ''
    )).toBe(true)
  })

  test('stopSession also disarms a held reply for tool-driven stops', async () => {
    const env = setup()
    planes.push(env.plane)
    env.plane.watchSession({ sessionId: 'caller' }, 'test')
    const caller = await startSession(env.plane, 'caller', 'test')
    const peer = await startSession(env.plane, 'peer')
    env.plane.watchSessionSettled('peer', 'caller', {
      exchangeId: 'exchange-1',
      dispatchedAt: Date.now(),
      notifyModel: true,
      runKey: 'active',
    })
    env.backend.complete('caller', 'Waiting for peer')
    await caller.done

    expect(env.plane.stopSession('caller')).toBe(true)
    expect(env.statuses.filter((event) => event.sessionId === 'caller').at(-1)?.status).toBe('interrupted')
    expect(watchCount(env.plane, 'caller')).toBe(0)
  })

  test('stopping a target settles watches attached to prompts still in its queue', async () => {
    // WHY: a queued peer prompt never reaches the normal run-settlement path
    // when Stop drains it, so its caller must not remain held forever.
    const env = setup()
    planes.push(env.plane)
    env.plane.watchSession({ sessionId: 'caller' }, 'test')
    await startSession(env.plane, 'caller', 'test')
    const peer = await startSession(env.plane, 'peer')
    const queued = await env.plane.runTurn({
      input: runInput('peer'),
      target: { kind: 'session', sessionId: 'peer' },
      sessionId: 'peer',
      tools: [],
      options: { prompt: 'Queued peer work', delivery: 'queue' },
    })
    expect(queued.disposition).toBe('queued')
    expect(queued.queueId).toBeString()
    env.plane.watchSessionSettled('peer', 'caller', {
      exchangeId: 'queued-exchange',
      dispatchedAt: Date.now(),
      notifyModel: true,
      runKey: queued.queueId!,
    })

    const queuedDone = queued.done.catch((error) => error)
    const peerDone = peer.done.catch((error) => error)
    expect(env.plane.stopSession('peer')).toBe(true)
    await Promise.all([queuedDone, peerDone])

    expect(watchCount(env.plane, 'caller')).toBe(0)
    expect(env.events.some(({ event }) =>
      event.type === 'agent_conversation_update'
      && event.update.phase === 'settled'
      && event.update.exchangeId === 'queued-exchange'
      && event.update.status === 'interrupted'
    )).toBe(true)
  })
})
