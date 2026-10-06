import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import type { AgentTool } from '@solus/server/execution/agents/tools/agent-tool'
import type { AgentId, AgentMetadata, NormalizedEvent, PermissionMode, SessionRunInput } from '@solus/contracts/types'
import type { ExecutionPreferences } from '@solus/contracts/settings'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// plans/018 §3.1: a host runs work with the preferences of the person it works
// for, captured with the work, never with its own config. A child session
// belongs to the organization of the session it came from, and its own record
// says so, so a host restart does not turn it into Local work. Organizations
// enforce no settings on the host; only Insights sync is theirs to require.

type SessionRuntimeModule = typeof import('@solus/server/execution/session-runtime')
type SessionSettingsModule = typeof import('@solus/server/execution/sessions/session-settings')
type RecordsModule = typeof import('@solus/server/data/sessions/session-records')
type AgentToolModule = typeof import('@solus/server/execution/agents/tools/agent-tool')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let runtimeModule: SessionRuntimeModule
let sessionSettings: SessionSettingsModule
let records: RecordsModule
let agentTool: AgentToolModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-execution-preferences-'))
  process.env.SOLUS_DATA_DIR = dataDir
  runtimeModule = await import('@solus/server/execution/session-runtime')
  sessionSettings = await import('@solus/server/execution/sessions/session-settings')
  records = await import('@solus/server/data/sessions/session-records')
  agentTool = await import('@solus/server/execution/agents/tools/agent-tool')
})

/**
 * A session whose durable record names `organizationId`. The record is keyed by
 * the Solus id until the provider answers, then by its thread id, as on a host;
 * the fake provider names the thread after the prompt, which is the session id.
 */
async function sessionIn(organizationId: string, name: string): Promise<string> {
  for (const sessionId of [name, `thread-${name}`]) {
    await records.upsertSessionRecord(organizationId, { sessionId, provider: 'codex', projectPath: '-repo', title: name, lastActivityAt: 1 })
  }
  return name
}

afterEach(() => {
  sessionSettings.resetSessionSettingsForTests()
})

afterAll(async () => {
  const db = await import('@solus/server/db')
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

// ─── A provider that records what it was asked to run ───

class Permissions implements PermissionResponder {
  getPendingInfo(): undefined { return undefined }
  respondToPermission(): boolean { return false }
  respondToQuestion(): boolean { return false }
  clearPendingForSession(): void {}
  setCurrentSessionId(): void {}
}

class Backend extends EventEmitter implements AgentBackend {
  readonly metadata: AgentMetadata
  readonly permissions = new Permissions()
  readonly handles = new Map<string, RunHandle>()
  readonly requests: AgentRunRequest[] = []
  readonly cancelled: string[] = []
  constructor(readonly id: AgentId) {
    super()
    this.metadata = { id, label: id, models: [], defaultModel: 'model-test' }
  }

  startRun(request: AgentRunRequest): RunHandle {
    this.requests.push(request)
    const threadId = (request.conversation?.kind === 'resume' ? request.conversation.threadId : null) ?? `thread-${request.prompt}`
    let resolve!: () => void
    let reject!: (error: Error) => void
    const handle: RunHandle = {
      agentSessionId: request.conversation?.kind === 'resume' ? request.conversation.threadId : null,
      persistence: request.persistence,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController: new AbortController(),
      runPromise: new Promise<void>((res, rej) => { resolve = res; reject = rej }),
      _resolveRun: resolve,
      _rejectRun: reject,
    }
    queueMicrotask(() => {
      handle.agentSessionId = threadId
      this.handles.set(threadId, handle)
      this.emit('normalized', threadId, { type: 'session_init', sessionId: threadId, model: 'model-test', skills: [] } satisfies NormalizedEvent)
    })
    return handle
  }

  getSessionHandle(sessionId: string): RunHandle | undefined { return this.handles.get(sessionId) }
  getPendingHandles(): RunHandle[] { return [] }
  cancelSession(threadId: string): boolean {
    const handle = this.handles.get(threadId)
    if (!handle) return false
    this.cancelled.push(threadId)
    handle.abortController.abort()
    queueMicrotask(() => { this.handles.delete(threadId); handle._resolveRun(); this.emit('exit', threadId, null, 'SIGINT') })
    return true
  }

  isSessionRunning(threadId: string): boolean { return this.handles.has(threadId) }
  async steerSession(): Promise<null> { return null }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [] } }
}

function input(provider: AgentId, permissionMode: PermissionMode, preferences?: ExecutionPreferences): SessionRunInput {
  return {
    provider, agentSessionId: null, forked: false, workingDirectory: dataDir, projectPath: dataDir,
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null,
    model: 'model-test', preferredModel: 'model-test', reasoningEffort: 'medium', fastMode: false,
    permissionMode, rateLimitBehavior: 'ask', extraInstructions: '', executionPreferences: preferences,
  }
}

async function runtimeWith(queueDirectory?: string) {
  const backends = { codex: new Backend('codex'), claude: new Backend('claude-code') }
  const runtime = new runtimeModule.SessionRuntime(new Map<AgentId, AgentBackend>([['codex', backends.codex], ['claude-code', backends.claude]]), { queueDirectory })
  runtime.on('error', () => {})
  return { runtime, backends }
}

function turn(sessionId: string, runInput: SessionRunInput) {
  return {
    target: { kind: 'new-session' as const }, sessionId, input: runInput, tools: [namedTool('create_work'), namedTool('read_work')],
    options: { prompt: sessionId, promptSource: 'typed' as const },
  }
}

const PREFERENCES: ExecutionPreferences = { defaultPermissionMode: 'full-access', agentTaskLifecyclePolicy: 'autonomous' }

/** Lets the runtime's unawaited record writes and queued dispatches land. */
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100 && !(await condition()); i++) await new Promise((resolve) => setTimeout(resolve, 1))
}

/** A host restart in this process: the old runtime is gone, and so is every session's in-memory dispatch. */
function restart(runtime: { shutdown(): void }): void {
  runtime.shutdown()
  sessionSettings.resetSessionSettingsForTests()
}

describe('what a session works under survives a host restart', () => {
  test("a child's organization is in its own record, so after a restart it is not Local work", async () => {
    const first = await runtimeWith()
    const parent = await sessionIn('A', 'restart-parent')
    await (await first.runtime.runTurn(turn(parent, input('codex', 'full-access', PREFERENCES)))).agentSessionId
    const { sessionId: childId } = await first.runtime.dispatch.createSession({
      provider: 'codex', modelId: 'model-test', reasoningEffort: 'medium', contextWindow: null, cwd: dataDir, prompt: 'restart-child',
      delegation: { parentSessionId: parent, messageId: 'm2', intent: 'fire_and_forget', createdAt: 1 },
    })
    // The child's record, written Local by its first index row, takes its parent's organization once.
    await until(async () => (await records.getSessionRecord('A', childId))?.organizationId === 'A')
    expect((await records.getSessionRecord('A', childId))?.organizationId).toBe('A')
    restart(first.runtime)

    // A follow-up nobody typed, on a new runtime: the record answers, not memory.
    const second = await runtimeWith()
    await second.runtime.dispatch.promptSession(childId, 'after-restart', 'queue')
    await until(() => second.backends.codex.requests.length > 0)
    expect(sessionSettings.sessionSettings(childId)?.organizationId).toBe('A')
    restart(second.runtime)
  })

  test('a child whose record predates the inheritance answers through its parent link; an unknown origin leaves it Local', async () => {
    await sessionIn('A', 'legacy-parent')
    await records.upsertSessionRecord('local', { sessionId: 'thread-legacy-child', provider: 'codex', projectPath: '-repo', lastActivityAt: 1, parentSessionId: 'thread-legacy-parent' })
    await records.upsertSessionRecord('local', { sessionId: 'thread-legacy-grandchild', provider: 'codex', projectPath: '-repo', lastActivityAt: 1, parentSessionId: 'thread-legacy-child' })
    expect(await sessionSettings.inheritedOrganizationOf('legacy-grandchild', 'local', 'thread-legacy-child')).toBe('A')
    expect(await sessionSettings.inheritedOrganizationOf('orphan', 'local', 'thread-gone')).toBe('local')
    // A session nobody started stays Local work.
    expect(await sessionSettings.inheritedOrganizationOf('plain', 'local', undefined)).toBe('local')

    // A child whose origin is gone still runs, as Local work.
    const { runtime, backends } = await runtimeWith()
    await records.upsertSessionRecord('local', { sessionId: 'thread-orphan', provider: 'codex', projectPath: '-repo', lastActivityAt: 1, parentSessionId: 'thread-gone' })
    const orphan = { ...input('codex', 'full-access', PREFERENCES), agentSessionId: 'thread-orphan' }
    await (await runtime.runTurn({ ...turn('orphan', orphan), target: { kind: 'session' as const, sessionId: 'orphan' } })).agentSessionId
    expect(backends.codex.requests).toHaveLength(1)
    expect(sessionSettings.sessionSettings('orphan')?.organizationId).toBe('local')
    runtime.shutdown()
  })

  test("an idle session's unattended follow-up runs with its last run's preferences after a restart", async () => {
    const first = await runtimeWith()
    const preferences: ExecutionPreferences = { ...PREFERENCES, extraInstructions: 'Answer in French.' }
    await (await first.runtime.runTurn(turn('prefs-local', input('codex', 'full-access', preferences)))).agentSessionId
    restart(first.runtime)
    // The session's state row holds them, so the database answers after the restart, not memory.
    const states = await import('@solus/server/data/sessions/session-states')
    expect(await states.sessionExecutionPreferences('prefs-local')).toEqual(preferences)

    const second = await runtimeWith()
    await second.runtime.dispatch.promptSession('prefs-local', 'after-restart', 'queue')
    await until(() => second.backends.codex.requests.length > 0)
    expect(second.backends.codex.requests.at(-1)?.systemPrompt).toContain('Answer in French.')
    expect(sessionSettings.sessionSettings('prefs-local')?.preferences).toEqual(preferences)
    restart(second.runtime)
  })
})

describe('a task keeps the lead preferences it was first led with', () => {
  const worker = (model: string) => ({ provider: 'codex' as const, model, reasoningEffort: 'high' as const })
  const lead = (model: string) => ({ provider: 'claude-code' as const, model, reasoningEffort: 'high' as const })

  test('two people on one host keep different lead models, and a changed default does not reach an existing task', async () => {
    const { installTestWorkspaceTools } = await import('./helpers/workspace-tools')
    await installTestWorkspaceTools()
    const { createTask } = await import('@solus/server/data/tasks/task-store')
    const leadPreferences = await import('@solus/server/data/tasks/task-lead-preferences')
    const alice: ExecutionPreferences = { leadModel: lead('alice-lead'), workerModel: worker('alice-worker'), leadInstructions: 'Alice leads.', agentTaskLifecyclePolicy: 'autonomous' }
    const bob: ExecutionPreferences = { leadModel: lead('bob-lead'), workerModel: worker('bob-worker'), leadInstructions: 'Bob leads.', agentTaskLifecyclePolicy: 'none' }
    const aliceTask = await createTask('local', { title: 'Alice task', projectKey: '/p', body: '' })
    const bobTask = await createTask('local', { title: 'Bob task', projectKey: '/p', body: '' })
    const { runtime, backends } = await runtimeWith()
    const leadTurn = (sessionId: string, taskId: string, preferences: ExecutionPreferences) => ({
      ...turn(sessionId, input('codex', 'full-access', preferences)),
      options: { prompt: sessionId, promptSource: 'typed' as const, taskId, taskRole: 'lead' as const },
    })
    await (await runtime.runTurn(leadTurn('alice-lead-session', aliceTask.id, alice))).agentSessionId
    expect(backends.codex.requests.at(-1)?.systemPrompt).toContain("model_id 'alice-worker'")
    await (await runtime.runTurn(leadTurn('bob-lead-session', bobTask.id, bob))).agentSessionId
    expect(backends.codex.requests.at(-1)?.systemPrompt).toContain("model_id 'bob-worker'")
    expect((await leadPreferences.taskLeadPreferences(aliceTask.id))?.preferences).toEqual({ leadModel: alice.leadModel, workerModel: alice.workerModel, leadInstructions: 'Alice leads.', agentTaskLifecyclePolicy: 'autonomous' })
    expect((await leadPreferences.taskLeadPreferences(bobTask.id))?.preferences.leadModel).toEqual(bob.leadModel)

    // Alice changes her defaults. Her next turn to the lead — queued, then run
    // when the lead is free — still works from what her task captured.
    const changed: ExecutionPreferences = { leadModel: lead('alice-new-lead'), workerModel: worker('alice-new-worker'), leadInstructions: 'Changed.', agentTaskLifecyclePolicy: 'none' }
    const before = backends.codex.requests.length
    await runtime.runTurn({
      target: { kind: 'session', sessionId: 'alice-lead-session' }, sessionId: 'alice-lead-session', input: input('codex', 'full-access', changed),
      tools: [], options: { prompt: 'next', promptSource: 'typed', delivery: 'queue', taskId: aliceTask.id },
    })
    backends.codex.cancelSession('thread-alice-lead-session')
    await until(() => backends.codex.requests.length > before)
    const followUp = backends.codex.requests.at(-1)?.systemPrompt ?? ''
    expect(followUp).toContain("model_id 'alice-worker'")
    expect(followUp).toContain('Alice leads.')
    expect(followUp).not.toContain('alice-new-worker')
    expect(sessionSettings.sessionSettings('alice-lead-session')?.preferences?.agentTaskLifecyclePolicy).toBe('autonomous')
    expect((await leadPreferences.taskLeadPreferences(aliceTask.id))?.preferences.leadModel).toEqual(alice.leadModel)
    // Bob's task is not touched by either of Alice's choices.
    expect((await leadPreferences.taskLeadPreferences(bobTask.id))?.preferences.workerModel).toEqual(bob.workerModel)
    runtime.shutdown()
  })
})

// ─── Tools ───

function namedTool(name: string): AgentTool {
  return { name, description: name, inputFields: {}, requiresApproval: false, execute: async () => ({ ok: true, text: 'ran' }) }
}

function toolContext(sessionId: string | undefined) {
  return {
    provider: 'codex' as const, cwd: dataDir, sessionId: () => sessionId,
    abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => {},
  }
}

describe('Solus tools act on the person\'s preferences, not the host\'s', () => {
  test("an agent's task changes follow the lifecycle choice of the person its session works for", async () => {
    const { installTestWorkspaceTools } = await import('./helpers/workspace-tools')
    await installTestWorkspaceTools()
    const { createTask } = await import('@solus/server/data/tasks/task-store')
    const taskTools = await import('@solus/server/execution/agents/tools/task-tools')
    sessionSettings.recordSessionSettings('task-none', { organizationId: 'local', preferences: { agentTaskLifecyclePolicy: 'none' } })
    sessionSettings.recordSessionSettings('task-autonomous', { organizationId: 'local', preferences: PREFERENCES })
    const task = await createTask('local', { title: 'Lifecycle', projectKey: '/p', body: '' })
    const refused = await taskTools.updateTaskStatusAgentTool.execute({ task_id: task.id, status: 'in_progress' }, toolContext('task-none') as never)
    expect(refused.ok).toBe(false)
    const allowed = await taskTools.updateTaskStatusAgentTool.execute({ task_id: task.id, status: 'done' }, toolContext('task-autonomous') as never)
    expect(allowed.ok).toBe(true)
  })

  test('an agent cannot set a personal preference through the host', async () => {
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    const result = await agentTool.executeAgentTool(tools.updateConfigAgentTool, { patch: '{"defaultPermissionMode":"full-access"}' }, toolContext(undefined))
    expect(result.ok).toBe(false)
    expect(result.text).toContain('defaultPermissionMode')
  })
})

// ─── Strict preferences ───

describe('execution preferences are parsed strictly where a request carries them', () => {
  test('a key that is not an execution preference refuses the request and is named', async () => {
    const runInput = await import('@solus/server/execution/agents/run-input')
    expect(() => runInput.parseExecutionPreferences({ extraInstructions: 'Mine.', themeMode: 'dark' } as never)).toThrow('themeMode')
    expect(() => runInput.contextPreferences({ settings: { executionPreferences: { fontSize: 14 } } as never })).toThrow('Execution preferences refused')
  })

  test('a bad value refuses the request rather than running with a choice the person did not make', async () => {
    const runInput = await import('@solus/server/execution/agents/run-input')
    expect(() => runInput.parseExecutionPreferences({ agentTaskLifecyclePolicy: 'unrestricted' } as never)).toThrow('agentTaskLifecyclePolicy')
    expect(() => runInput.parseExecutionPreferences({ leadModel: { provider: 'codex', model: 'gpt-6', reasoningEffort: 'extreme' } } as never)).toThrow('Execution preferences refused')
  })

  test('valid preferences pass whole, and a request with none carries none', async () => {
    const runInput = await import('@solus/server/execution/agents/run-input')
    expect(runInput.parseExecutionPreferences(PREFERENCES)).toEqual(PREFERENCES)
    expect(runInput.parseExecutionPreferences(undefined)).toBeUndefined()
  })
})
