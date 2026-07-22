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
  lastInput: SessionRunInput | undefined
  inputs: SessionRunInput[] = []
  private nextSession = 1
  private handles = new Map<string, RunHandle>()
  private pendingHandles = new Set<RunHandle>()

  startRun(input: SessionRunInput, _options: PromptOptions): RunHandle {
    this.lastInput = input
    this.inputs.push(input)
    const sessionId = input.agentSessionId ?? `headless-${this.nextSession++}`
    let resolveRun!: () => void
    let rejectRun!: (err: Error) => void
    const runPromise = new Promise<void>((resolve, reject) => {
      resolveRun = resolve
      rejectRun = reject
    })
    const handle: RunHandle = {
      sessionId: input.agentSessionId,
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
        model: input.model,
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
    this.handles.get(sessionId)?.abortController.abort()
    this.running.delete(sessionId)
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

describe('ControlPlane headless sessions', () => {
  test('starts a headless session without creating tab-scoped state', async () => {
    const env = setup()
    planes.push(env.controlPlane)

    const result = await env.controlPlane.createSession({
      prompt: 'Run in the background',
      provider: 'codex',
      modelId: 'gpt-test',
      reasoningEffort: 'medium',
      contextWindow: null,
      cwd: process.cwd(),
    })

    expect(result.agentSessionId).toBe('headless-1')
    expect('tabId' in (env.backend.lastInput ?? {})).toBe(false)
    const internals = env.controlPlane as unknown as {
      activeSessions: Map<string, BackendSession>
      tabWatchKeys: Map<string, string>
    }
    expect(internals.activeSessions.get(result.agentSessionId)?.runInput).toEqual(env.backend.lastInput)
    expect(internals.tabWatchKeys.size).toBe(0)
  })

  test('resumes an explicit session target without tab routing state', async () => {
    const env = setup()
    planes.push(env.controlPlane)
    const input: SessionRunInput = {
      provider: 'codex',
      agentSessionId: 'cold-session',
      forked: false,
      workingDirectory: process.cwd(),
      projectPath: process.cwd(),
      additionalDirs: [],
      gitContext: null,
      worktreeBaseBranch: null,
      sessionChangedFiles: [],
      contextWindow: null,
      model: 'gpt-test',
      preferredModel: 'gpt-test',
      reasoningEffort: 'medium',
      fastMode: false,
      permissionMode: 'ask',
      rateLimitBehavior: 'queue',
      extraInstructions: '',
    }

    const lifecycle = await env.controlPlane.runTurn({
      input,
      target: { kind: 'session', sessionId: 'cold-session' },
      options: {
        prompt: 'Continue in the background',
        displayPrompt: 'Continue in the background',
      },
    })
    const result = await lifecycle.agentSessionId

    expect(result.agentSessionId).toBe('cold-session')
    expect(lifecycle.disposition).toBe('started')
    expect(env.backend.lastInput).toEqual(input)
    const tabWatchKeys = (env.controlPlane as unknown as { tabWatchKeys: Map<string, string> }).tabWatchKeys
    expect(tabWatchKeys.size).toBe(0)
  })

  test('exposes an automation session at init while completion stays attached to the same run', async () => {
    const env = setup()
    planes.push(env.controlPlane)

    const lifecycle = await env.controlPlane.startAutomationSession({
      prompt: 'Run unattended',
      automationId: 'automation-1',
      automationName: 'Nightly check',
      provider: 'codex',
      modelId: 'gpt-test',
      reasoningEffort: 'medium',
      cwd: process.cwd(),
    })

    expect(lifecycle.agentSessionId).toBe('headless-1')
    expect(env.backend.lastInput?.permissionMode).toBe('auto')
    expect(env.backend.lastInput?.toolProfile).toBe('automation')

    env.backend.complete(lifecycle.agentSessionId, 'Automation finished')
    await expect(lifecycle.done).resolves.toEqual({ output: 'Automation finished' })
  })

  test('returns the same lifecycle shape for a queued turn and cancels by queue id', async () => {
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('busy-session')
    const input: SessionRunInput = {
      provider: 'codex',
      agentSessionId: 'busy-session',
      forked: false,
      workingDirectory: process.cwd(),
      projectPath: process.cwd(),
      additionalDirs: [],
      gitContext: null,
      worktreeBaseBranch: null,
      sessionChangedFiles: [],
      contextWindow: null,
      model: 'gpt-test',
      preferredModel: 'gpt-test',
      reasoningEffort: 'medium',
      fastMode: false,
      permissionMode: 'ask',
      rateLimitBehavior: 'queue',
      extraInstructions: '',
    }

    const lifecycle = await env.controlPlane.runTurn({
      input,
      target: { kind: 'session', sessionId: 'busy-session' },
      options: { prompt: 'Queue me' },
    })

    expect(lifecycle.disposition).toBe('queued')
    await expect(lifecycle.agentSessionId).resolves.toEqual({ agentSessionId: 'busy-session' })
    expect(env.backend.inputs).toHaveLength(0)

    lifecycle.cancel()
    await expect(lifecycle.done).rejects.toThrow('Cancelled by user')
  })

  test('cancels a new run before session_init through the shared lifecycle', async () => {
    const env = setup()
    planes.push(env.controlPlane)
    const input: SessionRunInput = {
      provider: 'codex',
      agentSessionId: null,
      forked: false,
      workingDirectory: process.cwd(),
      projectPath: process.cwd(),
      additionalDirs: [],
      gitContext: null,
      worktreeBaseBranch: null,
      sessionChangedFiles: [],
      contextWindow: null,
      model: 'gpt-test',
      preferredModel: 'gpt-test',
      reasoningEffort: 'medium',
      fastMode: false,
      permissionMode: 'ask',
      rateLimitBehavior: 'queue',
      extraInstructions: '',
    }

    const lifecycle = await env.controlPlane.runTurn({
      input,
      target: { kind: 'new-session' },
      options: { prompt: 'Cancel before init' },
    })
    lifecycle.cancel()

    await expect(lifecycle.agentSessionId).rejects.toThrow('Interrupted')
    await expect(lifecycle.done).rejects.toThrow('Interrupted')
  })
})

describe('ControlPlane idle-tab Git environments', () => {
  test('broadcasts live Git state without requiring a backend session', async () => {
    const env = setup()
    planes.push(env.controlPlane)
    env.controlPlane.createTab('idle-tab', { clientId: 'ws:a', deviceId: 'device-1' })
    env.controlPlane.setTabGitEnvironment('idle-tab', process.cwd(), {
      repoRoot: process.cwd(),
      branch: 'stale-branch',
      targetBranch: 'main',
    })

    await (env.controlPlane as unknown as { _onGitWatchFire(cwd: string): Promise<void> })._onGitWatchFire(process.cwd())

    expect(env.events.some(({ tabId, event }) => tabId === 'idle-tab' && event.type === 'git_status')).toBe(true)
    expect(env.events.some(({ tabId, event }) => tabId === 'idle-tab' && event.type === 'git_context')).toBe(true)
  })
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
    ])
    expect(terminalEvents[0]).toMatchObject({
      type: 'status_change',
      status: 'completed',
    })
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
