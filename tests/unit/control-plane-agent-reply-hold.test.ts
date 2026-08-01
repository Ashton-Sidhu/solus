import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import type { AgentBackend, PermissionResponder, RunHandle } from '../../src/main/agents/agent-backend'
import type { AgentRunRequest, AgentRunSessionState } from '../../src/main/agents/agent-runner'
import type {
  AgentMetadata,
  IpcContext,
  NormalizedEvent,
  SessionRunInput,
  SessionStatus,
} from '../../src/shared/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let ControlPlane: typeof import('../../src/main/control-plane')['ControlPlane']
type ControlPlaneInstance = import('../../src/main/control-plane').ControlPlane

beforeAll(async () => {
  ;({ ControlPlane } = await import('../../src/main/control-plane'))
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
      sessionId: input.sessionId ?? null,
      persistence: input.persistence,
      sourceTabId: input.sourceTabId,
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
      handle.sessionId = sessionId
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
  sourceTabId?: string,
) {
  const lifecycle = await plane.runTurn({
    input: runInput(agentSessionId),
    target: { kind: 'session', sessionId: agentSessionId },
    tools: [],
    sourceTabId,
    options: { prompt: `Start ${agentSessionId}` },
  })
  await lifecycle.agentSessionId
  return lifecycle
}

function setup() {
  const backend = new FakeBackend()
  const plane = new ControlPlane(new Map([['codex', backend]]))
  const events: Array<{ tabId: string; event: NormalizedEvent }> = []
  const statuses: Array<{ sessionId: string; status: SessionStatus }> = []
  plane.on('event', (tabId: string, event: NormalizedEvent) => events.push({ tabId, event }))
  plane.on('session-status', (event: { sessionId: string; status: SessionStatus }) => statuses.push(event))
  return { backend, plane, events, statuses }
}

function tabStatus(plane: ControlPlaneInstance, tabId: string): SessionStatus | undefined {
  return (plane as unknown as {
    tabs: Map<string, { status: SessionStatus }>
  }).tabs.get(tabId)?.status
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
  test('keeps a caller running when its run exits while a notifying watch is armed', async () => {
    // WHY: a peer conversation will resume automatically, so the tab must not
    // look finished during the gap between the caller's runs.
    const env = setup()
    planes.push(env.plane)
    env.plane.createTab('caller-tab', { clientId: 'test', deviceId: 'device' })
    const caller = await startSession(env.plane, 'caller', 'caller-tab')
    env.plane.watchSessionSettled('peer', 'caller', {
      exchangeId: 'exchange-1',
      dispatchedAt: Date.now(),
      notifyModel: true,
      runKey: 'active',
    })

    env.backend.complete('caller', 'Waiting for peer')
    await caller.done

    expect(tabStatus(env.plane, 'caller-tab')).toBe('running')
    expect(env.statuses.filter((event) => event.sessionId === 'caller').at(-1)?.status).toBe('running')
  })

  test('releases the hold after the peer settles and the report run completes', async () => {
    // WHY: the hold is temporary; consuming the peer reply must not strand the
    // caller in the Running section forever.
    const env = setup()
    planes.push(env.plane)
    env.plane.createTab('caller-tab', { clientId: 'test', deviceId: 'device' })
    const caller = await startSession(env.plane, 'caller', 'caller-tab')
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

    env.backend.complete('caller', 'Conversation finished')

    expect(tabStatus(env.plane, 'caller-tab')).toBe('completed')
    expect(env.statuses.filter((event) => event.sessionId === 'caller').at(-1)?.status).toBe('completed')
  })

  test('does not hold a fire-and-forget caller', async () => {
    // WHY: notify_on_completion=false has no future model turn to wait for.
    const env = setup()
    planes.push(env.plane)
    env.plane.createTab('caller-tab', { clientId: 'test', deviceId: 'device' })
    const caller = await startSession(env.plane, 'caller', 'caller-tab')
    env.plane.watchSessionSettled('peer', 'caller', {
      exchangeId: 'exchange-1',
      dispatchedAt: Date.now(),
      notifyModel: false,
      runKey: 'active',
    })

    env.backend.complete('caller', 'Dispatched')
    await caller.done

    expect(tabStatus(env.plane, 'caller-tab')).toBe('completed')
    expect(env.statuses.filter((event) => event.sessionId === 'caller').at(-1)?.status).toBe('completed')
  })

  test('the tab Stop action disarms a held reply and settles its exchange card', async () => {
    // WHY: Stop must cancel the parked continuation so a late peer reply cannot
    // resurrect the caller, and its card must not shimmer forever.
    const env = setup()
    planes.push(env.plane)
    env.plane.createTab('caller-tab', { clientId: 'test', deviceId: 'device' })
    const caller = await startSession(env.plane, 'caller', 'caller-tab')
    env.plane.watchSessionSettled('peer', 'caller', {
      exchangeId: 'exchange-1',
      dispatchedAt: Date.now(),
      notifyModel: true,
      runKey: 'active',
    })
    env.backend.complete('caller', 'Waiting for peer')
    await caller.done

    const stopped = env.plane.cancelTab({
      session: { tabId: 'caller-tab' },
    } as IpcContext)

    expect(stopped).toBe(true)
    expect(tabStatus(env.plane, 'caller-tab')).toBe('interrupted')
    expect(watchCount(env.plane, 'caller')).toBe(0)
    expect(env.events.at(-1)).toMatchObject({
      tabId: 'caller-tab',
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
    env.plane.createTab('caller-tab', { clientId: 'test', deviceId: 'device' })
    const caller = await startSession(env.plane, 'caller', 'caller-tab')
    env.plane.watchSessionSettled('peer', 'caller', {
      exchangeId: 'exchange-1',
      dispatchedAt: Date.now(),
      notifyModel: true,
      runKey: 'active',
    })
    env.backend.complete('caller', 'Waiting for peer')
    await caller.done

    expect(env.plane.stopSession('caller')).toBe(true)
    expect(tabStatus(env.plane, 'caller-tab')).toBe('interrupted')
    expect(watchCount(env.plane, 'caller')).toBe(0)
  })
})
