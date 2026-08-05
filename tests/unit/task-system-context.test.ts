import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentBackend, PermissionResponder, RunHandle } from '../../src/main/agents/agent-backend'
import type { AgentRunRequest } from '../../src/main/agents/agent-runner'
import type { AgentId, AgentMetadata, IpcContext, NormalizedEvent } from '../../src/shared/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let ControlPlane: typeof import('../../src/main/control-plane')['ControlPlane']
let createTask: typeof import('../../src/main/tasks/task-store')['createTask']
let closeDb: typeof import('../../src/main/db')['closeDb']

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-task-system-context-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ ControlPlane } = await import('../../src/main/control-plane'))
  ;({ createTask } = await import('../../src/main/tasks/task-store'))
  ;({ closeDb } = await import('../../src/main/db'))
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
  readonly id: AgentId = 'codex'
  readonly metadata: AgentMetadata = { id: 'codex', label: 'Codex', models: [], defaultModel: '' }
  readonly permissions = new FakePermissions()
  inputs: AgentRunRequest[] = []
  private running = new Set<string>()
  private handles = new Map<string, RunHandle>()
  private nextSession = 1

  startRun(input: AgentRunRequest): RunHandle {
    this.inputs.push(input)
    const sessionId = input.sessionId ?? `session-${this.nextSession++}`
    let resolveRun!: () => void
    const handle: RunHandle = {
      sessionId: input.sessionId ?? null,
      persistence: input.persistence,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController: new AbortController(),
      runPromise: new Promise<void>((resolve) => { resolveRun = resolve }),
      _resolveRun: () => resolveRun(),
      _rejectRun: () => {},
    }
    queueMicrotask(() => {
      handle.sessionId = sessionId
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
  async steerSession(): Promise<RunHandle | null> { return null }
  cancelSession(): boolean { return true }
  isSessionRunning(sessionId: string): boolean { return this.running.has(sessionId) }
  getSessionHandle(sessionId: string): RunHandle | undefined { return this.handles.get(sessionId) }
  getPendingHandles(): RunHandle[] { return [] }
  getEnrichedError() { return { message: 'error', isError: true, stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 } }
  async listSessions() { return [] }
  async loadSession() { return [] }
  async listPlans() { return [] }
  async loadPlanContent() { return null }
  async listPluginCommands() { return { commands: [], global: [], project: [] } }
  async refreshPluginCommands() {}
  shutdown(): void {}
}

function promptContext(tabId: string): IpcContext {
  return {
    session: {
      tabId,
      provider: 'codex',
      agentSessionId: null,
      status: 'idle',
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
      activeAgent: 'codex',
      rateLimitBehavior: 'queue',
      extraInstructions: '',
      modelInstructions: {},
    },
    statusBar: { model: 'test-model', reasoningEffort: 'medium', fastMode: false },
  } as unknown as IpcContext
}

const planes: Array<InstanceType<typeof ControlPlane>> = []
afterEach(() => {
  for (const plane of planes.splice(0)) plane.shutdown()
})

describe('task context on a task-bound dispatch', () => {
  test('reaches the agent through the system prompt, never the transcript', async () => {
    // WHY: the packet is scaffolding, not something the user typed. In the prompt
    // it was read back as their turn when the transcript reloaded, and a first
    // turn with no user message to lead it folds the whole session behind one row.
    const task = await createTask({
      title: 'Conversation Scroll Restoration',
      body: 'Restore scrollback after a refresh.',
      projectKey: process.cwd(),
    })
    const backend = new FakeBackend()
    const controlPlane = new ControlPlane(new Map<AgentId, AgentBackend>([['codex', backend]]))
    planes.push(controlPlane)
    controlPlane.createTab('tab-1', { clientId: 'ws:a', deviceId: 'device-1' })

    await controlPlane.submitPrompt(promptContext('tab-1'), {
      prompt: 'fix the scroll bug',
      taskId: task.id,
    })

    const run = backend.inputs[0]
    expect(run.prompt).toBe('fix the scroll bug')
    expect(run.systemPrompt).toContain(`[Working On Task — "${task.title}"`)
    expect(run.systemPrompt).toContain('Restore scrollback after a refresh.')
    // The base instructions still lead; the ticket is appended to them.
    expect(run.systemPrompt?.indexOf('[Working On Task')).toBeGreaterThan(0)
  })
})
