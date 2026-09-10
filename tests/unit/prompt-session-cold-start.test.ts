import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/agents/agent-runner'
import type { AgentMetadata, NormalizedEvent, SessionRunInput } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type ControlPlaneModule = typeof import('@solus/server/control-plane')
type DbModule = typeof import('@solus/server/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let controlPlaneModule: ControlPlaneModule
let db: DbModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-prompt-session-cold-start-'))
  process.env.SOLUS_DATA_DIR = dataDir
  controlPlaneModule = await import('@solus/server/control-plane')
  db = await import('@solus/server/db')
})

afterEach(() => {
  db.closeDb()
  for (const file of ['solus.db', 'solus.db-wal', 'solus.db-shm']) rmSync(join(dataDir, file), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

class Permissions implements PermissionResponder {
  getPendingInfo(): undefined { return undefined }
  respondToPermission(): boolean { return false }
  respondToQuestion(): boolean { return false }
  clearPendingForSession(): void {}
  setCurrentSessionId(): void {}
}

class Backend extends EventEmitter implements AgentBackend {
  readonly id = 'codex' as const
  readonly metadata: AgentMetadata = { id: 'codex', label: 'Codex', models: [], defaultModel: 'gpt-test' }
  readonly permissions = new Permissions()
  readonly handles = new Map<string, RunHandle>()
  readonly pending = new Set<RunHandle>()
  readonly requests: AgentRunRequest[] = []
  starts = 0

  startRun(request: AgentRunRequest): RunHandle {
    this.requests.push(request)
    const resumedThreadId = request.conversation?.kind === 'resume' ? request.conversation.threadId : null
    const threadId = resumedThreadId ?? `thread-${this.starts + 1}`
    let resolve!: () => void
    let reject!: (error: Error) => void
    const handle: RunHandle = {
      agentSessionId: resumedThreadId ?? null,
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
    this.pending.add(handle)
    this.starts++
    queueMicrotask(() => {
      handle.agentSessionId = threadId
      this.pending.delete(handle)
      this.handles.set(threadId, handle)
      this.emit('normalized', threadId, {
        type: 'session_init', sessionId: threadId, model: 'gpt-executed', skills: [],
      } satisfies NormalizedEvent)
    })
    return handle
  }

  complete(threadId: string): void {
    const handle = this.handles.get(threadId)!
    this.emit('normalized', threadId, {
      type: 'task_complete', result: 'done', costUsd: 0, durationMs: 1, numTurns: 1, usage: {}, sessionId: threadId,
    } satisfies NormalizedEvent)
    handle._resolveRun()
    this.handles.delete(threadId)
    this.emit('exit', threadId, 0, null)
  }

  send(threadId: string, event: NormalizedEvent): void { this.emit('normalized', threadId, event) }
  getSessionHandle(sessionId: string): RunHandle | undefined { return this.handles.get(sessionId) }
  getPendingHandles(): RunHandle[] { return [...this.pending] }
  cancelSession(): boolean { return false }
  isSessionRunning(sessionId: string): boolean { return this.handles.has(sessionId) }
  async steerSession(): Promise<null> { return null }
  loadSession(): Promise<never[]> { return Promise.resolve([]) }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 } }
  listSessions(): Promise<never[]> { return Promise.resolve([]) }
  listPlans(): Promise<never[]> { return Promise.resolve([]) }
  loadPlanContent(): Promise<null> { return Promise.resolve(null) }
  listPluginCommands(): Promise<{ global: never[]; project: never[] }> { return Promise.resolve({ global: [], project: [] }) }
  refreshPluginCommands(): Promise<void> { return Promise.resolve() }
  shutdown(): void {}
}

function input(): SessionRunInput {
  return {
    provider: 'codex', agentSessionId: null, forked: false, workingDirectory: process.cwd(), projectPath: process.cwd(),
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null,
    model: 'gpt-requested', preferredModel: 'gpt-requested', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'auto', rateLimitBehavior: 'queue', extraInstructions: '',
  }
}

describe.serial('ControlPlane.promptSession cold start', () => {
  for (const targetId of ['solus-target', 'thread-1']) {
    test(`resumes the same provider thread after restart when addressed as ${targetId}`, async () => {
      const backend = new Backend()
      const original = new controlPlaneModule.ControlPlane(new Map([['codex', backend]]))
      original.on('error', () => {})
      const created = await original.runTurn({
        target: { kind: 'new-session' }, sessionId: 'solus-target', input: input(), tools: [],
        options: { prompt: 'start', promptSource: 'agent', skipTaskCreation: true },
      })
      await created.agentSessionId
      backend.complete('thread-1')
      await created.done
      original.shutdown()

      const resumedBackend = new Backend()
      const resumed = new controlPlaneModule.ControlPlane(new Map([['codex', resumedBackend]]))
      resumed.on('error', () => {})
      try {
        await resumed.promptSession(targetId, 'continue')
        expect(resumedBackend.requests).toHaveLength(1)
        expect(resumedBackend.requests[0].conversation).toEqual({ kind: 'resume', threadId: 'thread-1' })
        expect((await resumed.getSessionInfo('solus-target'))?.status).toBe('running')
        const caller = await resumed.runTurn({
          target: { kind: 'new-session' }, sessionId: 'solus-caller', input: input(), tools: [],
          options: { prompt: 'coordinate', promptSource: 'agent', skipTaskCreation: true },
        })
        await caller.agentSessionId
        const settled = new Promise<NormalizedEvent>((resolve) => {
          resumed.on('event', (sessionId: string, event: NormalizedEvent) => {
            if (sessionId === 'solus-caller' && event.type === 'agent_conversation_update'
              && event.update.phase === 'settled') resolve(event)
          })
        })
        resumed.watchSessionSettled(targetId, 'thread-2', {
          exchangeId: 'cold-exchange', dispatchedAt: Date.now(), notifyModel: false, runKey: 'active',
        })
        resumedBackend.complete('thread-1')
        expect(await settled).toMatchObject({
          type: 'agent_conversation_update',
          update: { phase: 'settled', agentSessionId: targetId, status: 'completed', replyText: 'done' },
        })
      } finally {
        resumed.shutdown()
      }
    })

    test(`queues on the active session and attaches its completion watcher using ${targetId}`, async () => {
      const backend = new Backend()
      const plane = new controlPlaneModule.ControlPlane(new Map([['codex', backend]]))
      plane.on('error', () => {})
      try {
        const target = await plane.runTurn({
          target: { kind: 'new-session' }, sessionId: 'solus-target', input: input(), tools: [],
          options: { prompt: 'start', promptSource: 'agent', skipTaskCreation: true },
        })
        await target.agentSessionId
        const caller = await plane.runTurn({
          target: { kind: 'new-session' }, sessionId: 'solus-caller', input: input(), tools: [],
          options: { prompt: 'coordinate', promptSource: 'agent', skipTaskCreation: true },
        })
        await caller.agentSessionId

        const result = await plane.promptSession(targetId, 'follow up', 'queue')
        expect(result.disposition).toBe('queued')
        expect(backend.requests).toHaveLength(2)
        expect(result.queueId).toBeDefined()
        expect(() => plane.watchSessionSettled(targetId, 'solus-caller', {
          exchangeId: 'exchange', dispatchedAt: Date.now(), notifyModel: false, runKey: result.queueId!,
        })).not.toThrow()
        expect(() => plane.watchSessionSettled('solus-target', 'thread-1', {
          exchangeId: 'self', dispatchedAt: Date.now(), notifyModel: false, runKey: 'active',
        })).toThrow('Cannot watch your own session.')
      } finally {
        plane.shutdown()
      }
    })
  }

  // WHY: a settled turn drops its run record, so a session an agent created in
  // auto rebuilds its run input from the index on the next peer prompt or
  // session report. Rebuilding it as 'ask' parked those unattended sessions on
  // permission prompts nobody asked for.
  test('rebuilds a settled session in auto permission mode', async () => {
    const backend = new Backend()
    const plane = new controlPlaneModule.ControlPlane(new Map([['codex', backend]]))
    plane.on('error', () => {})
    try {
      const created = await plane.runTurn({
        target: { kind: 'new-session' }, sessionId: 'solus-created', input: input(), tools: [],
        options: { prompt: 'start the work', promptSource: 'agent', skipTaskCreation: true },
      })
      await created.agentSessionId
      backend.complete('thread-1')
      await created.done

      await plane.promptSession('thread-1', 'follow up on that')

      expect(backend.requests).toHaveLength(2)
      expect(backend.requests[1].permissionMode).toBe('auto')
    } finally {
      plane.shutdown()
    }
  })

  // The review surface still dispatches its own mode, and it must survive the
  // rebuild — a review peer is answering a human, not running unattended.
  test('an explicit permission mode still wins over the rebuilt default', async () => {
    const backend = new Backend()
    const plane = new controlPlaneModule.ControlPlane(new Map([['codex', backend]]))
    plane.on('error', () => {})
    try {
      const created = await plane.runTurn({
        target: { kind: 'new-session' }, sessionId: 'solus-created-2', input: input(), tools: [],
        options: { prompt: 'start the work', promptSource: 'agent', skipTaskCreation: true },
      })
      await created.agentSessionId
      backend.complete('thread-1')
      await created.done

      await plane.promptSession('thread-1', 'review this', 'queue', { permissionMode: 'plan' })

      expect(backend.requests[1].permissionMode).toBe('plan')
    } finally {
      plane.shutdown()
    }
  })
})
