import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { ControlPlane } from '../../src/main/control-plane'
import type { AgentBackend, PermissionResponder, RunHandle } from '../../src/main/agents/agent-backend'
import type { AgentMetadata, BackendSession, IpcContext, NormalizedEvent, PromptOptions, SessionRunInput } from '../../src/shared/types'

const GRACE_MS = 5 * 60_000

class ManualTimers {
  timers: Array<{ callback: () => void; delay: number; cleared: boolean; unref(): void }> = []

  setTimeout = ((callback: () => void, delay?: number) => {
    const timer = {
      callback,
      delay: delay ?? 0,
      cleared: false,
      unref() {},
    }
    this.timers.push(timer)
    return timer
  }) as unknown as typeof setTimeout

  clearTimeout = ((timer: { cleared?: boolean }) => {
    timer.cleared = true
  }) as unknown as typeof clearTimeout

  runNext(): void {
    const timer = this.timers.find((t) => !t.cleared)
    if (!timer) return
    timer.cleared = true
    timer.callback()
  }
}

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
  running = new Set<string>()

  startRun(_input: SessionRunInput, _options: PromptOptions): RunHandle {
    throw new Error('not used')
  }
  cancelSession(sessionId: string): boolean {
    this.running.delete(sessionId)
    return true
  }
  isSessionRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }
  getSessionHandle(): RunHandle | undefined {
    return undefined
  }
  getPendingHandles(): RunHandle[] {
    return []
  }
  getEnrichedError() {
    return { message: 'error', isError: true, stderrTail: [] }
  }
  async listSessions() {
    return []
  }
  async loadSession() {
    return []
  }
  async listPlans() {
    return []
  }
  async loadPlanContent() {
    return null
  }
  async listPluginCommands() {
    return { commands: [] }
  }
  async refreshPluginCommands() {}
}

function setup() {
  let now = 0
  const timers = new ManualTimers()
  const backend = new FakeBackend()
  const controlPlane = new ControlPlane(new Map([[backend.id, backend]]), {
    tabDisconnectGraceMs: GRACE_MS,
    now: () => now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  })
  const events: Array<{ tabId: string; event: NormalizedEvent }> = []
  controlPlane.on('event', (tabId: string, event: NormalizedEvent) => {
    events.push({ tabId, event })
  })

  function seedSession(sessionId: string): void {
    backend.running.add(sessionId)
    const session: BackendSession = {
      sessionId,
      backendId: backend.id,
      status: 'running',
      pendingInputEvents: [],
      lastActivityAt: now,
      promptCount: 1,
    }
    ;(controlPlane as unknown as { activeSessions: Map<string, BackendSession> }).activeSessions.set(sessionId, session)
  }

  function registerWatch(tabId: string, clientId: string, deviceId: string, sessionId: string): void {
    controlPlane.createTab(tabId, { clientId, deviceId })
    controlPlane.bindRuntimeSession(tabId, sessionId, { clientId, deviceId })
  }

  function emitAssistant(sessionId: string, text: string): void {
    backend.emit('normalized', sessionId, { type: 'assistant_message', text } satisfies NormalizedEvent)
  }

  return {
    backend,
    controlPlane,
    events,
    timers,
    seedSession,
    registerWatch,
    emitAssistant,
    seedActiveRun: (sessionId: string, rateLimitBehavior: 'ask' | 'queue' | 'stop' | 'continue') => {
      const activeRuns = (controlPlane as unknown as {
        activeRunRequests: Map<string, { input: { rateLimitBehavior: string }; options: Record<string, never> }>
      }).activeRunRequests
      activeRuns.set(sessionId, { input: { rateLimitBehavior }, options: {} })
    },
    advanceTo: (value: number) => { now = value },
  }
}

const planes: ControlPlane[] = []

afterEach(() => {
  for (const plane of planes.splice(0)) plane.shutdown()
})

describe('ControlPlane device-scoped tab watches', () => {
  test('keeps a deferred Codex account limit hidden after the active turn settles', () => {
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1')
    env.seedActiveRun('session-1', 'queue')
    env.registerWatch('tab-a', 'ws:a', 'device-1', 'session-1')
    env.events.length = 0

    env.backend.emit('normalized', 'session-1', {
      type: 'rate_limit',
      status: 'limited',
      resetsAt: 4_000_000_000,
      rateLimitType: 'Codex 5h',
      isUsingOverage: false,
      deferCurrentRun: true,
    } satisfies NormalizedEvent)
    env.emitAssistant('session-1', 'still finishing')

    expect(env.events.map((entry) => entry.event.type)).toEqual(['assistant_message'])

    env.backend.emit('normalized', 'session-1', {
      type: 'task_complete',
      result: '',
      costUsd: 0,
      durationMs: 1,
      numTurns: 1,
      usage: {},
      sessionId: 'session-1',
    } satisfies NormalizedEvent)
    env.backend.emit('exit', 'session-1', 0, null)

    const terminalEvents = env.events.slice(1).map((entry) => entry.event)
    expect(terminalEvents.map((event) => event.type)).toEqual([
      'status_change',
      'task_complete',
      'status_change',
    ])
    expect(terminalEvents.some((event) => event.type === 'prompt_queued')).toBe(false)
  })

  test('disconnect GC removes only the dropped connection watches after the grace period', () => {
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1')
    env.registerWatch('tab-a', 'ws:a', 'device-1', 'session-1')
    env.registerWatch('tab-b', 'ws:b', 'device-1', 'session-1')
    env.events.length = 0

    env.controlPlane.handleClientDisconnected('ws:a')
    env.emitAssistant('session-1', 'during grace')
    expect(env.events.map((e) => e.tabId)).toEqual(['tab-a', 'tab-b'])

    env.events.length = 0
    env.advanceTo(GRACE_MS)
    env.timers.runNext()
    env.emitAssistant('session-1', 'after grace')

    expect(env.events.map((e) => e.tabId)).toEqual(['tab-b'])
  })

  test('the same logical client reconnect cancels its pending watch GC', () => {
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1')
    env.registerWatch('tab-a', 'ws:a', 'device-1', 'session-1')
    env.events.length = 0

    env.controlPlane.handleClientDisconnected('ws:a')
    env.controlPlane.handleClientConnected('ws:a')
    env.advanceTo(GRACE_MS)
    env.timers.runNext()
    env.emitAssistant('session-1', 'after reconnect')

    expect(env.events.map((e) => e.tabId)).toEqual(['tab-a'])
  })

  test('reconnect within grace replaces a stale same-device watch instead of duplicating it', () => {
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1')
    env.registerWatch('old-tab', 'ws:old', 'device-1', 'session-1')
    env.events.length = 0

    env.controlPlane.handleClientDisconnected('ws:old')
    env.registerWatch('new-tab', 'ws:new', 'device-1', 'session-1')
    env.advanceTo(GRACE_MS)
    env.timers.runNext()
    env.emitAssistant('session-1', 'after reconnect')

    expect(env.events.filter((e) => e.event.type === 'assistant_message').map((e) => e.tabId)).toEqual(['new-tab'])
  })

  test('session events still fan out to every active connection watching the session', () => {
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1')
    env.registerWatch('tab-a', 'ws:a', 'device-1', 'session-1')
    env.registerWatch('tab-b', 'ws:b', 'device-1', 'session-1')
    env.events.length = 0

    env.emitAssistant('session-1', 'fan out')

    expect(env.events.map((e) => e.tabId)).toEqual(['tab-a', 'tab-b'])
    expect(env.events.map((e) => env.controlPlane.getTabClientId(e.tabId))).toEqual(['ws:a', 'ws:b'])
  })

  test('closing the last session watch dismisses its pending attention', () => {
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1')
    env.registerWatch('tab-a', 'ws:a', 'device-1', 'session-1')
    env.registerWatch('tab-b', 'ws:b', 'device-1', 'session-1')
    env.controlPlane.attention.set({
      sessionId: 'session-1',
      kind: 'question',
      summary: 'Question: choose one',
    })

    env.controlPlane.closeTab(
      { session: { tabId: 'tab-a' } } as IpcContext,
      { clientId: 'ws:a', deviceId: 'device-1' },
    )
    expect(env.controlPlane.attention.get('session-1')).toBeDefined()

    env.controlPlane.closeTab(
      { session: { tabId: 'tab-b' } } as IpcContext,
      { clientId: 'ws:b', deviceId: 'device-1' },
    )
    expect(env.controlPlane.attention.get('session-1')).toBeUndefined()
  })
})
