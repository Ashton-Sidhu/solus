import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentBackend, PermissionResponder, RunHandle } from '../../src/main/agents/agent-backend'
import type { AgentRunRequest, AgentRunSessionState } from '../../src/main/agents/agent-runner'
import type { BuiltHandoff, BuildHandoffDeps } from '../../src/main/agents/session-handoff'
import type { AgentId, AgentMetadata, BackendSession, IpcContext, NormalizedEvent, PromptOptions, SessionRunInput, SessionStatus } from '../../src/shared/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let ControlPlane: typeof import('../../src/main/control-plane')['ControlPlane']
let solusToolbox: typeof import('../../src/main/agents/tools/solus-toolbox')['solusToolbox']
let closeDb: typeof import('../../src/main/db')['closeDb']
let listTasks: typeof import('../../src/main/tasks/task-store')['listTasks']
type ControlPlaneInstance = import('../../src/main/control-plane').ControlPlane
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-control-plane-device-tabs-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ ControlPlane } = await import('../../src/main/control-plane'))
  ;({ solusToolbox } = await import('../../src/main/agents/tools/solus-toolbox'))
  ;({ closeDb } = await import('../../src/main/db'))
  ;({ listTasks } = await import('../../src/main/tasks/task-store'))
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

class FakePermissions implements PermissionResponder {
  getPendingInfo(): undefined { return undefined }
  respondToPermission(): boolean { return false }
  respondToQuestion(): boolean { return false }
  clearPendingForSession(): void {}
  setCurrentSessionId(): void {}
}

class FakeBackend extends EventEmitter implements AgentBackend {
  readonly id: AgentId
  readonly metadata: AgentMetadata
  readonly permissions = new FakePermissions()
  running = new Set<string>()
  lastInput: AgentRunRequest | undefined
  lastSessionState: AgentRunSessionState | undefined
  inputs: AgentRunRequest[] = []
  steeredOptions: Array<Pick<PromptOptions, 'prompt' | 'imageAttachments'>> = []
  steerResult: 'accepted' | 'not-active' = 'accepted'
  onSteer: (() => void) | null = null
  /** When set, the next run dies before session_init instead of issuing one. */
  failNextRun: Error | null = null
  private nextSession = 1
  private handles = new Map<string, RunHandle>()
  private pendingHandles = new Set<RunHandle>()

  constructor(id: AgentId = 'codex') {
    super()
    this.id = id
    this.metadata = {
      id,
      label: id,
      models: [],
      defaultModel: '',
    }
  }

  startRun(input: AgentRunRequest, sessionState?: AgentRunSessionState): RunHandle {
    this.lastInput = input
    this.lastSessionState = sessionState
    this.inputs.push(input)
    const sessionId = input.sessionId ?? `headless-${this.nextSession++}`
    let resolveRun!: () => void
    let rejectRun!: (err: Error) => void
    const runPromise = new Promise<void>((resolve, reject) => {
      resolveRun = resolve
      rejectRun = reject
    })
    const handle: RunHandle = {
      agentSessionId: input.sessionId ?? null,
      persistence: input.persistence,
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
      const failure = this.failNextRun
      if (failure) {
        this.failNextRun = null
        // As the real backends do: the handle stays pending — only a
        // session_init that never arrives promotes it out — and the run itself
        // rejects alongside the error event.
        this.emit('error', null, failure)
        handle._rejectRun(failure)
        return
      }
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
  async steerSession(
    sessionId: string,
    options: Pick<PromptOptions, 'prompt' | 'imageAttachments'>,
  ): Promise<RunHandle | null> {
    if (!this.running.has(sessionId) || !this.handles.has(sessionId)) return null
    this.onSteer?.()
    if (this.steerResult === 'not-active') return null
    this.steeredOptions.push(options)
    return this.handles.get(sessionId) ?? null
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

type EmitTarget = { only?: string; except?: string } | undefined

function setup(options: {
  backendIds?: AgentId[]
  buildHandoff?: (
    oldSessionId: string,
    projectPath: string,
    deps: BuildHandoffDeps,
  ) => Promise<BuiltHandoff>
} = {}) {
  const backends = (options.backendIds ?? ['codex']).map((id) => new FakeBackend(id))
  const backend = backends[0]
  const controlPlane = new ControlPlane(new Map(backends.map((entry) => [entry.id, entry])), {
    buildHandoff: options.buildHandoff,
  })
  // The routing layer publishes to `clientsWatching` minus/only the named
  // client; recording it here is what lets a test assert fan-out by client.
  const events: Array<{ sessionId: string; event: NormalizedEvent; clients: string[] }> = []
  controlPlane.on('event', (sessionId: string, event: NormalizedEvent, to: EmitTarget) => {
    let clients = [...controlPlane.clientsWatching(sessionId)]
    if (to?.only) clients = clients.filter((clientId) => clientId === to.only)
    if (to?.except) clients = clients.filter((clientId) => clientId !== to.except)
    events.push({ sessionId, event, clients })
  })
  const errors: Array<{ sessionId: string; error: { message: string } }> = []
  controlPlane.on('error', (sessionId: string, error: { message: string }) => {
    errors.push({ sessionId, error })
  })
  const statuses: Array<{ sessionId: string; status: SessionStatus }> = []
  controlPlane.on('session-status', (event: { sessionId: string; status: SessionStatus }) => {
    statuses.push(event)
  })

  function seedSession(
    sessionId: string,
    options: {
      backendId?: AgentId
      status?: SessionStatus
      runInput?: SessionRunInput
    } = {},
  ): void {
    const sessionBackend = backends.find((entry) => entry.id === (options.backendId ?? backend.id))
    if (!sessionBackend) throw new Error(`Unknown fake backend ${options.backendId}`)
    sessionBackend.running.add(sessionId)
    const session: BackendSession = {
      sessionId,
      agentSessionId: sessionId,
      backendId: sessionBackend.id,
      status: options.status ?? 'running',
      pendingInputEvents: [],
      runInput: options.runInput,
      lastActivityAt: Date.now(),
      promptCount: 1,
    }
    const internals = controlPlane as unknown as {
      activeSessions: Map<string, BackendSession>
      agentSessionToSession: Map<string, string>
    }
    internals.activeSessions.set(sessionId, session)
    // A live session always has its provider thread translatable — session_init
    // and dispatch both write this — so a seeded one must too, or every seam
    // that resolves by provider id would silently mint a second session.
    internals.agentSessionToSession.set(sessionId, sessionId)
  }

  /** What a client does on open: resolve the session, then attach to its runtime. */
  function registerWatch(clientId: string, agentSessionId: string): string {
    const { sessionId } = controlPlane.watchSession({ agentSessionId }, clientId)
    controlPlane.bindRuntimeSession(promptContext(backend.id, agentSessionId, sessionId), clientId)
    return sessionId
  }

  function emitAssistant(sessionId: string, text: string): void {
    backend.emit('normalized', sessionId, { type: 'assistant_message', text } satisfies NormalizedEvent)
  }

  return {
    backend,
    backends,
    controlPlane,
    events,
    errors,
    statuses,
    seedSession,
    registerWatch,
    emitAssistant,
    seedActiveRun: (sessionId: string, rateLimitBehavior: 'ask' | 'queue' | 'stop' | 'continue') => {
      const activeRuns = (controlPlane as unknown as {
        activeRunRequests: Map<string, { input: { rateLimitBehavior: string }; options: Record<string, never> }>
      }).activeRunRequests
      activeRuns.set(sessionId, { input: { rateLimitBehavior }, options: {} })
    },
  }
}

const planes: ControlPlaneInstance[] = []

afterEach(() => {
  for (const plane of planes.splice(0)) plane.shutdown()
})

function sampleRunInput(provider: AgentId, agentSessionId: string | null): SessionRunInput {
  return {
    provider,
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

function promptContext(provider: AgentId, agentSessionId: string, sessionId = agentSessionId): IpcContext {
  return {
    session: {
      sessionId,
      provider,
      agentSessionId,
      status: 'completed',
      workingDirectory: process.cwd(),
      projectPath: process.cwd(),
      additionalDirs: [],
      preferredModel: 'test-model',
      reasoningEffort: 'medium',
      contextWindow: null,
      fastMode: false,
      permissionMode: 'ask',
      gitContext: null,
      worktreeBaseBranch: null,
      sessionChangedFiles: [],
      readOnlyReason: null,
      latestCheckpointId: null,
    },
    settings: {
      activeAgent: provider,
      rateLimitBehavior: 'queue',
      extraInstructions: '',
      modelInstructions: {},
    },
    statusBar: {
      model: 'test-model',
      reasoningEffort: 'medium',
      fastMode: false,
    },
  } as IpcContext
}

describe('ControlPlane subagent text routing', () => {
  test('preserves the parent tool id instead of batching child text into the main reply', () => {
    // WHY: cross-provider subagents stream through the parent backend. Dropping
    // this id turns their live report into an ordinary assistant message even
    // though the completed result still lands on the subagent card.
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1')
    const sessionUnderTest = env.registerWatch('ws:a', 'session-1')
    env.events.splice(0, env.events.length)

    env.backend.emit('normalized', 'session-1', {
      type: 'text_chunk',
      text: 'Child report',
      parentToolUseId: 'subagent-tool-1',
    } satisfies NormalizedEvent)

    expect(env.events).toEqual([{
      sessionId: sessionUnderTest,
      event: {
        type: 'text_chunk',
        text: 'Child report',
        parentToolUseId: 'subagent-tool-1',
      },
      clients: ['ws:a'],
    }])
  })
})

describe('ControlPlane headless sessions', () => {
  test('gives create_session the same tools as a normal new session', async () => {
    // WHY: create_session bypasses submitPrompt and has no tab. It must still
    // receive every provider-neutral Solus tool and the provider subagent tool
    // that an ordinary new session receives.
    const providerNeutralToolNames = Object.values(solusToolbox)
      .flatMap((group) => Object.values(group).map((tool) => tool.name))

    for (const [provider, subagentToolName] of [
      ['codex', 'claude_subagent'],
      ['claude-code', 'codex_subagent'],
    ] as const) {
      const env = setup({ backendIds: [provider] })
      planes.push(env.controlPlane)

      await env.controlPlane.createSession({
        prompt: 'Start through create_session',
        provider,
        modelId: 'test-model',
        reasoningEffort: 'medium',
        contextWindow: null,
        cwd: process.cwd(),
      })
      const createdToolNames = env.backend.lastInput?.tools.map((tool) => tool.name)

      expect(createdToolNames).toEqual([...providerNeutralToolNames, subagentToolName])
      expect(createdToolNames).toContain('create_session')
      expect(createdToolNames).toContain(subagentToolName)
    }
  })

  test('starts a headless session without creating client-scoped state', async () => {
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
      gitWatchKeys: Map<string, string>
    }
    expect(internals.activeSessions.get(result.agentSessionId)?.runInput).toMatchObject({
      provider: 'codex',
      agentSessionId: result.agentSessionId,
      workingDirectory: process.cwd(),
    })
    expect(env.backend.lastInput).toMatchObject({
      provider: 'codex',
      sessionId: null,
      cwd: process.cwd(),
      persistence: 'session',
    })
    expect(internals.gitWatchKeys.size).toBe(0)
  })

  test('resumes an explicit session target without client-scoped state', async () => {
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
      sessionId: 'cold-session',
      tools: [],
      options: {
        prompt: 'Continue in the background',
        displayPrompt: 'Continue in the background',
      },
    })
    const result = await lifecycle.agentSessionId

    expect(result.agentSessionId).toBe('cold-session')
    expect(lifecycle.disposition).toBe('started')
    expect(env.backend.lastInput).toMatchObject({
      provider: input.provider,
      sessionId: input.agentSessionId,
      cwd: input.workingDirectory,
      model: input.model,
      permissionMode: input.permissionMode,
      persistence: 'session',
    })
    expect(env.backend.lastInput?.tools.map((tool) => tool.name)).toEqual(['claude_subagent'])
    const gitWatchKeys = (env.controlPlane as unknown as { gitWatchKeys: Map<string, string> }).gitWatchKeys
    expect(gitWatchKeys.size).toBe(0)
  })

  test('runs an automation without minting a task while keeping task tools available to the agent', async () => {
    const env = setup()
    planes.push(env.controlPlane)
    const taskIdsBeforeRun = (await listTasks()).tasks.map((task) => task.id)

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
    const selectedNames = env.backend.lastInput?.tools.map((tool) => tool.name) ?? []
    expect(selectedNames).toContain('list_works')
    expect(selectedNames).toContain('create_session')
    expect(selectedNames).toContain('list_tasks')
    // WHY: firing an automation is not itself task creation. The unattended
    // agent may still decide its work merits a task and call the explicit tool.
    expect(selectedNames).toContain('create_task')
    expect((await listTasks()).tasks.map((task) => task.id)).toEqual(taskIdsBeforeRun)
    for (const automationToolName of [
      'create_automation',
      'list_automations',
      'read_automation',
      'update_automation',
      'delete_automation',
      'set_automation_enabled',
      'run_automation',
      'list_automation_runs',
      'read_automation_run',
    ]) {
      expect(selectedNames).not.toContain(automationToolName)
    }

    env.backend.complete(lifecycle.agentSessionId, 'Automation finished')
    await expect(lifecycle.done).resolves.toEqual({ output: 'Automation finished' })
  })

  test('keeps changed-file state in the control plane across session turns', async () => {
    const env = setup()
    planes.push(env.controlPlane)
    const input = sampleRunInput('codex', 'session-files')

    const first = await env.controlPlane.runTurn({
      input,
      target: { kind: 'session', sessionId: 'session-files' },
      sessionId: 'session-files',
      tools: [],
      options: { prompt: 'First turn' },
    })
    await first.agentSessionId
    env.backend.emit('normalized', 'session-files', {
      type: 'session_changed_files_updated',
      paths: ['src/changed.ts'],
    } satisfies NormalizedEvent)
    env.backend.complete('session-files', 'First complete')
    await first.done

    await env.controlPlane.runTurn({
      input: { ...input, sessionChangedFiles: [] },
      target: { kind: 'session', sessionId: 'session-files' },
      sessionId: 'session-files',
      tools: [],
      options: { prompt: 'Second turn' },
    })

    expect(env.backend.lastSessionState).toEqual({ changedFiles: ['src/changed.ts'] })
    expect('sessionChangedFiles' in (env.backend.lastInput ?? {})).toBe(false)
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
      sessionId: 'busy-session',
      tools: [],
      options: { prompt: 'Queue me', delivery: 'queue' },
    })

    expect(lifecycle.disposition).toBe('queued')
    expect(lifecycle.queueId).toBeString()
    await expect(lifecycle.agentSessionId).resolves.toEqual({ agentSessionId: 'busy-session' })
    expect(env.backend.inputs).toHaveLength(0)

    lifecycle.cancel()
    await expect(lifecycle.done).rejects.toThrow('Cancelled by user')
  })

  test('steers a running turn by default and shares its completion lifecycle', async () => {
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
    const sessionId = crypto.randomUUID()
    const active = await env.controlPlane.runTurn({
      input,
      target: { kind: 'new-session' },
      sessionId,
      tools: [],
      options: { prompt: 'Start working' },
    })
    const { agentSessionId } = await active.agentSessionId
    env.registerWatch('ws:a', agentSessionId)
    env.registerWatch('ws:b', agentSessionId)
    env.events.length = 0

    const steered = await env.controlPlane.runTurn({
      input: { ...input, agentSessionId },
      target: { kind: 'session', sessionId },
      sessionId,
      tools: [],
      sourceClientId: 'ws:a',
      options: { prompt: 'Change direction', imageAttachments: [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }] },
    })

    expect(steered.disposition).toBe('steered')
    expect(env.backend.inputs).toHaveLength(1)
    expect(env.backend.steeredOptions).toEqual([{
      prompt: 'Change direction',
      imageAttachments: [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }],
    }])
    // A steer's echo is one publish reaching both watching clients — not one
    // publish each.
    expect(env.events.filter(({ event }) => event.type === 'user_message')).toEqual([
      {
        sessionId,
        event: {
          type: 'user_message',
          text: 'Change direction',
          delivery: 'steer',
          imageAttachments: [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }],
        },
        clients: ['ws:a', 'ws:b'],
      },
    ])

    env.backend.complete(agentSessionId, 'Finished after steering')
    await expect(active.done).resolves.toEqual({ output: 'Finished after steering' })
    await expect(steered.done).resolves.toEqual({ output: 'Finished after steering' })
  })

  test('starts a fresh turn when the active turn completes during steering', async () => {
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
    const sessionId = crypto.randomUUID()
    const active = await env.controlPlane.runTurn({
      input,
      target: { kind: 'new-session' },
      sessionId,
      tools: [],
      options: { prompt: 'Start working' },
    })
    const { agentSessionId } = await active.agentSessionId
    env.backend.steerResult = 'not-active'
    env.backend.onSteer = () => env.backend.complete(agentSessionId, 'First turn finished')

    const followUp = await env.controlPlane.runTurn({
      input: { ...input, agentSessionId },
      target: { kind: 'session', sessionId },
      sessionId,
      tools: [],
      options: { prompt: 'Follow up at the boundary' },
    })

    expect(followUp.disposition).toBe('started')
    expect(env.backend.inputs).toHaveLength(2)
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
      sessionId: crypto.randomUUID(),
      tools: [],
      options: { prompt: 'Cancel before init' },
    })
    lifecycle.cancel()

    await expect(lifecycle.agentSessionId).rejects.toThrow('Interrupted')
    await expect(lifecycle.done).rejects.toThrow('Interrupted')
  })
})

describe('ControlPlane provider handoff', () => {
  for (const [originalProvider, temporaryProvider] of [
    ['codex', 'claude-code'],
    ['claude-code', 'codex'],
  ] as const) {
    test(`${originalProvider} → ${temporaryProvider} → ${originalProvider} restores the original session as a no-op`, async () => {
      const originalSessionId = `${originalProvider}-session`
      const buildCalls: string[] = []
      const env = setup({
        backendIds: ['codex', 'claude-code'],
        buildHandoff: async (sessionId) => {
          buildCalls.push(sessionId)
          return { transcriptFilePath: null, reasoningFilePath: null }
        },
      })
      planes.push(env.controlPlane)
      env.seedSession(originalSessionId, {
        backendId: originalProvider,
        status: 'completed',
        runInput: sampleRunInput(originalProvider, originalSessionId),
      })
      const sessionUnderTest = env.registerWatch('ws:a', originalSessionId)

      await env.controlPlane.switchSessionProvider(sessionUnderTest, temporaryProvider)
      await expect(env.controlPlane.switchSessionProvider(sessionUnderTest, originalProvider)).resolves.toMatchObject({
        fromProvider: temporaryProvider,
        fromSessionId: originalSessionId,
        restoredSessionId: originalSessionId,
      })

      const restored = (env.controlPlane as unknown as {
        activeSessions: Map<string, BackendSession>
      }).activeSessions.get(originalSessionId)
      expect(restored).toMatchObject({ backendId: originalProvider, agentSessionId: originalSessionId })

      await env.controlPlane.submitPrompt(
        promptContext(originalProvider, originalSessionId),
        { prompt: 'Keep going' },
      )

      const originalBackend = env.backends.find((backend) => backend.id === originalProvider)!
      expect(buildCalls).toEqual([])
      expect(originalBackend.lastInput?.sessionId).toBe(originalSessionId)
    })
  }

  test('switches an idle session that has no runtime record, using the thread the client holds', async () => {
    const buildCalls: string[] = []
    const env = setup({
      backendIds: ['codex', 'claude-code'],
      buildHandoff: async (sessionId) => {
        buildCalls.push(sessionId)
        return {
          transcriptFilePath: '/tmp/solus-handoffs/detached-session-transcript.md',
          reasoningFilePath: null,
        }
      },
    })
    planes.push(env.controlPlane)
    const sessionId = 'idle-session'
    const firstContext = promptContext('codex', '', sessionId)
    firstContext.session.agentSessionId = null
    await env.controlPlane.submitPrompt(firstContext, { prompt: 'Do a thing' })
    const codex = env.backends.find((backend) => backend.id === 'codex')!
    const agentSessionId = [...codex.running][0]

    // The runtime exits and the client reattaches: the control plane keeps a
    // record only while a runtime is attached, so an idle conversation — one
    // whose process ended, or one reopened after a restart — has none. That is
    // the ordinary state of a session a user comes back to.
    codex.running.delete(agentSessionId)
    env.controlPlane.bindRuntimeSession(promptContext('codex', agentSessionId, sessionId), 'ws:a')
    const internals = env.controlPlane as unknown as { activeSessions: Map<string, BackendSession> }
    expect(internals.activeSessions.get(sessionId)).toBeUndefined()

    await expect(
      env.controlPlane.switchSessionProvider(sessionId, 'claude-code', agentSessionId),
    ).resolves.toEqual({
      fromProvider: 'codex',
      fromSessionId: agentSessionId,
      handoffId: sessionId,
      taskSessionMove: { sourceSessionId: agentSessionId, targetSessionId: sessionId },
    })
    expect(buildCalls).toEqual([])

    const freshContext = promptContext('claude-code', agentSessionId, sessionId)
    freshContext.session.agentSessionId = null
    await env.controlPlane.submitPrompt(freshContext, { prompt: 'Continue from here' })

    const claude = env.backends.find((backend) => backend.id === 'claude-code')!
    expect(buildCalls).toEqual([agentSessionId])
    expect(claude.lastInput?.sessionId).toBeNull()
    expect(claude.lastInput?.systemPrompt).toContain('/tmp/solus-handoffs/detached-session-transcript.md')
  })

  test('resetting a tab cancels a pending provider handoff', async () => {
    const buildCalls: string[] = []
    const env = setup({
      backendIds: ['codex', 'claude-code'],
      buildHandoff: async (sessionId) => {
        buildCalls.push(sessionId)
        return {
          transcriptFilePath: '/tmp/solus-handoffs/old-session-transcript.md',
          reasoningFilePath: '/tmp/solus-handoffs/old-session-reasoning.md',
        }
      },
    })
    planes.push(env.controlPlane)
    env.seedSession('old-session', {
      backendId: 'codex',
      status: 'completed',
      runInput: sampleRunInput('codex', 'old-session'),
    })
    const sessionUnderTest = env.registerWatch('ws:a', 'old-session')
    const rebindContext = promptContext('codex', 'old-session')
    rebindContext.session.handoffFrom = { provider: 'claude-code', sessionId: 'earlier-session' }
    env.controlPlane.bindRuntimeSession(rebindContext, 'ws:a')

    await env.controlPlane.switchSessionProvider(sessionUnderTest, 'claude-code')
    env.controlPlane.resetSession(promptContext('codex', 'old-session'))
    const reset = (env.controlPlane as unknown as {
      activeSessions: Map<string, BackendSession>
    }).activeSessions.get('old-session')
    expect(reset?.handoffFrom).toBeUndefined()

    const freshContext = promptContext('claude-code', 'old-session')
    freshContext.session.agentSessionId = null
    await env.controlPlane.submitPrompt(freshContext, { prompt: 'Start fresh' })

    const claude = env.backends.find((backend) => backend.id === 'claude-code')!
    expect(buildCalls).toEqual([])
    expect(claude.lastInput?.sessionId).toBeNull()
    expect(claude.lastInput?.systemPrompt).not.toContain('/tmp/solus-handoffs/')
  })

  test('switches the tab instantly, without building the handoff, then builds it on the next prompt', async () => {
    const buildCalls: Array<{ sessionId: string; projectPath: string }> = []
    const env = setup({
      backendIds: ['codex', 'claude-code'],
      buildHandoff: async (sessionId, projectPath) => {
        buildCalls.push({ sessionId, projectPath })
        return {
          transcriptFilePath: '/tmp/solus-handoffs/old-session-transcript.md',
          reasoningFilePath: '/tmp/solus-handoffs/old-session-reasoning.md',
        }
      },
    })
    planes.push(env.controlPlane)
    env.seedSession('old-session', {
      backendId: 'codex',
      status: 'completed',
      runInput: sampleRunInput('codex', 'old-session'),
    })
    const sessionUnderTest = env.registerWatch('ws:a', 'old-session')

    await expect(env.controlPlane.switchSessionProvider(sessionUnderTest, 'claude-code')).resolves.toEqual({
      fromProvider: 'codex',
      fromSessionId: 'old-session',
      handoffId: sessionUnderTest,
    })
    // The switch itself never touches the handoff builder — it's deferred to
    // the first prompt sent to the new provider.
    expect(buildCalls).toEqual([])

    // Deliberately submit the renderer's stale pre-switch context. The pending
    // main-process handoff remains authoritative for the provider and session start.
    await env.controlPlane.submitPrompt(
      promptContext('codex', 'old-session'),
      { prompt: 'Continue from here' },
    )

    expect(buildCalls).toEqual([{
      sessionId: 'old-session',
      projectPath: process.cwd(),
    }])

    const claude = env.backends.find((backend) => backend.id === 'claude-code')!
    expect(claude.lastInput?.provider).toBe('claude-code')
    expect(claude.lastInput?.sessionId).toBeNull()
    expect(claude.lastInput?.systemPrompt).toContain('/tmp/solus-handoffs/old-session-transcript.md')
    expect(claude.lastInput?.systemPrompt).toContain('/tmp/solus-handoffs/old-session-reasoning.md')

    const init = env.events.find(({ event }) => event.type === 'session_init')
    expect(init?.event).toMatchObject({ type: 'session_init' })
    expect(init?.event.type === 'session_init' ? init.event.handoffFrom : undefined).toBeUndefined()
    const switched = (env.controlPlane as unknown as {
      activeSessions: Map<string, BackendSession>
    }).activeSessions.get('old-session')
    expect(switched?.handoffFrom).toBeUndefined()
  })

  test('rejects an idle provider mismatch that has no pending handoff', async () => {
    const env = setup({ backendIds: ['codex', 'claude-code'] })
    planes.push(env.controlPlane)
    env.seedSession('old-session', {
      backendId: 'codex',
      status: 'completed',
      runInput: sampleRunInput('codex', 'old-session'),
    })
    const sessionUnderTest = env.registerWatch('ws:a', 'old-session')

    await expect(env.controlPlane.submitPrompt(
      promptContext('claude-code', 'old-session'),
      { prompt: 'Continue from here' },
    )).rejects.toThrow('Provider changed without a handoff — this is a bug')

    const claude = env.backends.find((backend) => backend.id === 'claude-code')!
    expect(claude.inputs).toHaveLength(0)
  })

  test('rejects switching while the current session is busy', async () => {
    const env = setup({ backendIds: ['codex', 'claude-code'] })
    planes.push(env.controlPlane)
    env.seedSession('busy-session', {
      backendId: 'codex',
      status: 'running',
      runInput: sampleRunInput('codex', 'busy-session'),
    })
    const sessionUnderTest = env.registerWatch('ws:a', 'busy-session')

    await expect(
      env.controlPlane.switchSessionProvider(sessionUnderTest, 'claude-code'),
    ).rejects.toThrow('must be idle before switching providers')
  })

  test('allows switching away from a rate-limited provider and clears its parked prompt', async () => {
    const env = setup({ backendIds: ['codex', 'claude-code'] })
    planes.push(env.controlPlane)
    env.seedSession('limited-session', {
      backendId: 'codex',
      status: 'running',
      runInput: sampleRunInput('codex', 'limited-session'),
    })
    env.seedActiveRun('limited-session', 'queue')
    const sessionUnderTest = env.registerWatch('ws:a', 'limited-session')

    env.backend.emit('normalized', 'limited-session', {
      type: 'rate_limit',
      status: 'limited',
      resetsAt: Math.ceil(Date.now() / 1000) + 3_600,
      rateLimitType: 'Codex 5h',
      isUsingOverage: false,
    } satisfies NormalizedEvent)

    await expect(
      env.controlPlane.switchSessionProvider(sessionUnderTest, 'claude-code'),
    ).resolves.toEqual({
      fromProvider: 'codex',
      fromSessionId: 'limited-session',
      handoffId: sessionUnderTest,
    })

    const switched = (env.controlPlane as unknown as {
      activeSessions: Map<string, BackendSession>
    }).activeSessions.get('limited-session')
    expect(switched).toMatchObject({
      backendId: 'claude-code',
      agentSessionId: null,
      status: 'idle',
    })
    expect(env.controlPlane.liveSessionStatus('limited-session')).toBe('idle')
    expect(env.events.some(({ event }) => event.type === 'prompt_dequeued')).toBe(true)
    expect(env.events.some(({ event }) => event.type === 'rate_limit_resolved')).toBe(true)
  })
})

describe('ControlPlane retry', () => {
  test('retries with the same interactive tools as a normal prompt', async () => {
    // WHY: retry builds a fresh SessionRunRequest. Omitting its tools crashes
    // before the backend starts and leaves a recoverable failed turn stuck.
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('retry-session', {
      status: 'completed',
      runInput: sampleRunInput('codex', 'retry-session'),
    })
    const sessionUnderTest = env.registerWatch('ws:a', 'retry-session')

    await env.controlPlane.retry(
      promptContext('codex', 'retry-session'),
      { prompt: 'Try this again' },
    )

    const toolNames = env.backend.lastInput?.tools.map((tool) => tool.name) ?? []
    expect(toolNames).toContain('list_works')
    expect(toolNames).toContain('create_automation')
    expect(toolNames).toContain('create_session')
    expect(toolNames).toContain('list_tasks')
    expect(toolNames).toContain('list_prs')
    expect(toolNames).toContain('claude_subagent')
  })
})

describe('ControlPlane idle-session Git environments', () => {
  test('broadcasts live Git state without requiring a backend session', async () => {
    const env = setup()
    planes.push(env.controlPlane)
    env.controlPlane.watchSession({ sessionId: 'idle-session' }, 'ws:a')
    env.controlPlane.setSessionGitEnvironment('idle-session', process.cwd(), {
      repoRoot: process.cwd(),
      branch: 'stale-branch',
      targetBranch: 'main',
    })

    await (env.controlPlane as unknown as { _onGitWatchFire(cwd: string): Promise<void> })._onGitWatchFire(process.cwd())

    const forIdle = env.events.filter(({ sessionId }) => sessionId === 'idle-session')
    expect(forIdle.some(({ event }) => event.type === 'git_status')).toBe(true)
    expect(forIdle.some(({ event }) => event.type === 'git_context')).toBe(true)
    expect(forIdle.every(({ clients }) => clients.includes('ws:a'))).toBe(true)
  })
})

describe('ControlPlane device-scoped tab watches', () => {
  test('treats repeated session init as idempotent while background tasks are running', () => {
    const env = setup({ backendIds: ['claude-code'] })
    planes.push(env.controlPlane)
    env.seedSession('session-1', {
      runInput: sampleRunInput('claude-code', 'session-1'),
    })
    const sessionUnderTest = env.registerWatch('ws:a', 'session-1')

    const sessions = (env.controlPlane as unknown as {
      activeSessions: Map<string, BackendSession>
    }).activeSessions
    const session = sessions.get('session-1')!
    const pendingInputEvents = session.pendingInputEvents
    session.promptCount = 3
    session.backgroundTaskIds = new Set(['task-1', 'task-2'])

    env.backend.emit('normalized', 'session-1', {
      type: 'session_init',
      sessionId: 'session-1',
      model: 'claude-test',
      skills: [],
    } satisfies NormalizedEvent)

    expect(sessions.get('session-1')).toBe(session)
    expect(session.pendingInputEvents).toBe(pendingInputEvents)
    expect(session.promptCount).toBe(3)
    expect([...session.backgroundTaskIds]).toEqual(['task-1', 'task-2'])

    env.backend.emit('normalized', 'session-1', {
      type: 'task_complete',
      result: 'One explorer finished; two are still running.',
      costUsd: 0,
      durationMs: 1,
      numTurns: 1,
      usage: {},
      sessionId: 'session-1',
    } satisfies NormalizedEvent)

    expect(session.status).toBe('running')
  })

  test('reattaching reports running while a completed event still has a live runtime', () => {
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1', {
      status: 'completed',
      runInput: sampleRunInput('codex', 'session-1'),
    })
    env.controlPlane.watchSession({ agentSessionId: 'session-1' }, 'ws:new')

    const info = env.controlPlane.bindRuntimeSession(
      promptContext('codex', 'session-1'),
      'ws:new',
    )

    expect(info?.status).toBe('running')
  })

  // A stale exit can delete a session record that a newer run just installed; the
  // re-`session_init` then rebuilds it with no run contract. The run is still
  // alive, so refusing to reattach would strand the tab at 'idle' permanently —
  // the client would never learn the session is running.
  test('reattaching still reports running when the live session lost its run input', () => {
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1', { status: 'running', runInput: undefined })
    env.controlPlane.watchSession({ agentSessionId: 'session-1' }, 'ws:new')

    const info = env.controlPlane.bindRuntimeSession(
      promptContext('codex', 'session-1'),
      'ws:new',
    )

    expect(info).not.toBeNull()
    expect(info?.status).toBe('running')
    // Nothing to restore the config from, so the client keeps its own snapshot.
    expect(info?.modelConfig).toBeNull()
    expect(info?.permissionMode).toBeNull()
  })

  test('keeps a deferred Codex account limit hidden after the active turn settles', () => {
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1')
    env.seedActiveRun('session-1', 'queue')
    const sessionUnderTest = env.registerWatch('ws:a', 'session-1')
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

  test('a dropped socket drops only that client\'s watch', () => {
    // WHY: with no grace machinery left, a disconnect is immediate and total for
    // that connection and invisible to every other one.
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1')
    const sessionUnderTest = env.registerWatch('ws:a', 'session-1')
    env.registerWatch('ws:b', 'session-1')
    env.events.length = 0

    env.controlPlane.handleClientDisconnected('ws:a')
    env.emitAssistant('session-1', 'after disconnect')

    const delivered = env.events.filter((e) => e.event.type === 'assistant_message')
    expect(delivered).toHaveLength(1)
    expect(delivered[0].clients).toEqual(['ws:b'])
  })

  test('a dropped socket does not resolve the session\'s attention', () => {
    // WHY: a session awaiting input still needs you when your laptop is shut —
    // that is exactly what the offline push notification assumes. Only the user
    // closing the last view dismisses it.
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1')
    const sessionId = env.registerWatch('ws:a', 'session-1')
    env.controlPlane.attention.set({ sessionId: 'session-1', kind: 'question', summary: 'Question: choose one' })

    env.controlPlane.handleClientDisconnected('ws:a')
    expect(env.controlPlane.attention.get('session-1')).toBeDefined()

    env.controlPlane.unwatchSession(sessionId, 'ws:a')
    expect(env.controlPlane.attention.get('session-1')).toBeUndefined()
  })

  test('one session watched by two clients delivers one payload from one publish', () => {
    // WHY: this is the executable statement of the fan-out rule. Two panes on
    // one renderer are one client and get one payload; two clients get two, and
    // it is the same payload from the same publish.
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1')
    const sessionId = env.registerWatch('ws:a', 'session-1')
    expect(env.registerWatch('ws:b', 'session-1')).toBe(sessionId)
    env.events.length = 0

    env.emitAssistant('session-1', 'fan out')

    const delivered = env.events.filter((e) => e.event.type === 'assistant_message')
    expect(delivered).toHaveLength(1)
    expect(delivered[0].sessionId).toBe(sessionId)
    expect(delivered[0].clients).toEqual(['ws:a', 'ws:b'])
  })

  test('two clients resuming one provider thread land on one session id', () => {
    // WHY: the only assertion that separates this design from a per-client
    // correlation token, and the one thing a single-client test can never catch.
    // Each client read the same thread off disk and minted its own local id;
    // main resolves both to one, and one publish then reaches both.
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1')

    const first = env.controlPlane.watchSession(
      { sessionId: 'desktop-local-uuid', agentSessionId: 'session-1' },
      'ws:desktop',
    )
    const second = env.controlPlane.watchSession(
      { sessionId: 'web-local-uuid', agentSessionId: 'session-1' },
      'ws:web',
    )

    expect(second.sessionId).toBe(first.sessionId)
    expect(env.controlPlane.clientsWatching(first.sessionId)).toEqual(['ws:desktop', 'ws:web'])

    env.events.length = 0
    env.emitAssistant('session-1', 'one payload')

    const delivered = env.events.filter((e) => e.event.type === 'assistant_message')
    expect(delivered).toHaveLength(1)
    expect(delivered[0].sessionId).toBe(first.sessionId)
    expect(delivered[0].clients).toEqual(['ws:desktop', 'ws:web'])
  })

  test('a run that dies before session_init reports its error to whoever is watching', async () => {
    // WHY: this used to take an entirely different branch that deleted the
    // session and never built the enriched error at all, so a create_session
    // agent's failure was silently swallowed. There is one path now: set the
    // status, publish the error to the session's watchers — however many.
    const env = setup()
    planes.push(env.controlPlane)
    const { sessionId } = env.controlPlane.watchSession({ sessionId: 'pre-init-session' }, 'ws:a')
    env.backend.failNextRun = new Error('agent binary not found')

    const lifecycle = await env.controlPlane.runTurn({
      input: sampleRunInput('codex', null),
      target: { kind: 'new-session' },
      sessionId,
      tools: [],
      options: { prompt: 'Start something that cannot start' },
    })
    await expect(lifecycle.agentSessionId).rejects.toThrow('agent binary not found')

    const errors = env.errors.filter((entry) => entry.sessionId === sessionId)
    expect(errors).toHaveLength(1)
    expect(errors[0].error.message).toBe('agent binary not found')
    expect(env.statuses.filter((event) => event.sessionId === sessionId).at(-1)?.status).toBe('dead')
  })

  test('an interrupt hands the session to exactly one queued prompt', async () => {
    // WHY: the exit both settles the session and drains its queue, and those two
    // jobs each want to ask "is a queued prompt taking over?". Asking by
    // dispatching drains a prompt per question, so the second queued prompt
    // starts while the first is still running — FIFO order silently broken. And
    // no interrupted status may be published either: the session did not settle,
    // it changed hands.
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('queued-session', { runInput: sampleRunInput('codex', 'queued-session') })
    const sessionId = env.registerWatch('ws:a', 'queued-session')
    env.seedActiveRun('queued-session', 'queue')

    for (const prompt of ['Run me next', 'And me after that']) {
      const queued = await env.controlPlane.runTurn({
        input: sampleRunInput('codex', 'queued-session'),
        target: { kind: 'session', sessionId },
        sessionId,
        tools: [],
        options: { prompt, delivery: 'queue' },
      })
      expect(queued.disposition).toBe('queued')
    }
    const inputsBefore = env.backend.inputs.length
    env.statuses.length = 0

    env.backend.emit('exit', 'queued-session', null, 'SIGINT')
    // The drain's own run resolves its git environment before it reaches the
    // backend, so wait for the dispatch rather than counting microtasks.
    for (let i = 0; i < 200 && env.backend.inputs.length === inputsBefore; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    expect(env.backend.inputs.length).toBe(inputsBefore + 1)
    expect(env.backend.inputs.at(-1)?.prompt).toBe('Run me next')
    expect(env.statuses.map((event) => event.status)).not.toContain('interrupted')
  })

  test('closing the last session watch dismisses its pending attention', () => {
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1')
    const sessionId = env.registerWatch('ws:a', 'session-1')
    env.registerWatch('ws:b', 'session-1')
    env.controlPlane.attention.set({
      sessionId: 'session-1',
      kind: 'question',
      summary: 'Question: choose one',
    })

    env.controlPlane.unwatchSession(sessionId, 'ws:a')
    expect(env.controlPlane.attention.get('session-1')).toBeDefined()

    env.controlPlane.unwatchSession(sessionId, 'ws:b')
    expect(env.controlPlane.attention.get('session-1')).toBeUndefined()
  })

  test('unwatching the last view leaves a running provider session alive', () => {
    // WHY: Close unloads presentation state. It must not become an implicit
    // Stop action for work that should continue headlessly.
    const env = setup()
    planes.push(env.controlPlane)
    env.seedSession('session-1', { status: 'running' })
    const sessionId = env.registerWatch('ws:a', 'session-1')

    env.controlPlane.unwatchSession(sessionId, 'ws:a')

    expect(env.controlPlane.liveSessionStatus('session-1')).toBe('running')
    expect(env.backend.running.has('session-1')).toBe(true)
  })
})
