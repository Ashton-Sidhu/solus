import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import { HOST_ACTOR } from '@solus/server/admission/actor'
import type { AgentMetadata, NormalizedEvent, SessionRunInput } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// The launch's last read before the provider spawns. The test holds it open,
// so Stop lands while the turn is set up but no provider runs yet.
let releaseKey: () => void = () => {}
let keyRequested: () => void = () => {}
let isKeyHeld = true
const keyRequestedOnce = new Promise<void>((resolve) => { keyRequested = resolve })
mock.module('@solus/server/typesafe/credentials', () => ({
  typeSafeKey: () => {
    if (!isKeyHeld) return Promise.resolve({ apiKey: null })
    keyRequested()
    return new Promise<{ apiKey: string | null }>((resolve) => { releaseKey = () => resolve({ apiKey: null }) })
  },
  typeSafeKeyStatus: () => Promise.reject(new Error('unavailable')),
  setTypeSafeApiKey: () => {},
}))

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let runtime: typeof import('@solus/server/execution/session-runtime')

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-run-launch-stop-'))
  process.env.SOLUS_DATA_DIR = dataDir
  runtime = await import('@solus/server/execution/session-runtime')
})

afterAll(async () => {
  ;(await import('@solus/server/data/insights/metrics-db')).closeMetricsDb()
  ;(await import('@solus/server/db')).closeDb()
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

/** A backend that keeps each run pending, as before `session_init`, until the test ends it. */
class RecordingBackend extends EventEmitter implements AgentBackend {
  readonly id = 'claude-code' as const
  readonly metadata: AgentMetadata = { id: 'claude-code', label: 'Claude Code', models: [], defaultModel: 'claude-sonnet-5' }
  readonly permissions = new Permissions()
  readonly runs: AgentRunRequest[] = []
  readonly handles: RunHandle[] = []
  readonly cancelledThreads: string[] = []
  /** Whether the provider still has work to stop for a thread. */
  hasWorkToCancel = false
  private readonly endRuns: Array<() => void> = []

  startRun(request: AgentRunRequest): RunHandle {
    this.runs.push(request)
    let endRun = () => {}
    const handle: RunHandle = {
      agentSessionId: null,
      persistence: request.persistence,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController: new AbortController(),
      runPromise: new Promise<void>((resolve) => { endRun = resolve }),
      _resolveRun: () => {},
      _rejectRun: () => {},
    }
    this.handles.push(handle)
    this.endRuns.push(() => {
      this.handles.splice(this.handles.indexOf(handle), 1)
      endRun()
    })
    return handle
  }

  /** The provider process exits. */
  async endRun(): Promise<void> {
    this.endRuns.shift()?.()
    await Promise.resolve()
  }

  getSessionHandle(): RunHandle | undefined { return undefined }
  getPendingHandles(): RunHandle[] { return [...this.handles] }
  cancelSession(threadId: string): boolean {
    this.cancelledThreads.push(threadId)
    return this.hasWorkToCancel
  }
  isSessionRunning(): boolean { return false }
  async steerSession(): Promise<null> { return null }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [] } }
}

function input(): SessionRunInput {
  return {
    provider: 'claude-code', agentSessionId: null, forked: false, workingDirectory: process.cwd(), projectPath: process.cwd(),
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, contextWindow: null,
    model: 'claude-opus-5', preferredModel: 'claude-opus-5', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'supervised', rateLimitBehavior: 'queue', extraInstructions: '',
  }
}

describe('Stop while a new session is set up', () => {
  test('ends the turn, and no provider starts for it', async () => {
    // WHY: a person who presses Ctrl-C right after Send has stopped the turn.
    // Setup that finishes after that must not start the agent, or the stopped
    // turn opens again on every client ("Picking this back up…") and runs.
    const backend = new RecordingBackend()
    const plane = new runtime.SessionRuntime(new Map([['claude-code', backend]]))
    plane.on('error', () => {})
    const statuses: string[] = []
    plane.on('event', (_sessionId: string, event: NormalizedEvent) => {
      if (event.type === 'status_change') statuses.push(event.status)
    })
    const sessionId = 'solus-stop-during-setup'

    const turn = plane.runTurn({
      target: { kind: 'new-session' }, sessionId, input: input(), tools: [],
      options: { prompt: 'do the work', promptSource: 'typed' },
    })
    await keyRequestedOnce
    expect(plane.stopSession(sessionId, HOST_ACTOR)).toBe(true)
    releaseKey()

    await expect(turn).rejects.toThrow('Interrupted')
    expect(backend.runs).toHaveLength(0)
    expect(statuses.at(-1)).toBe('interrupted')
    expect(plane.turnStops.has(sessionId)).toBe(false)
    isKeyHeld = false
    plane.shutdown()
  })
})

describe('Stop while a worktree is made', () => {
  test('cancels the setup and the prompts queued for that worktree', async () => {
    // WHY: the worktree is made before any provider runs. Stop must reach it,
    // and the prompts queued behind it were written for a folder that now never exists.
    const backend = new RecordingBackend()
    const plane = new runtime.SessionRuntime(new Map([['claude-code', backend]]))
    plane.on('error', () => {})
    const sessionId = 'solus-stop-during-worktree'
    let setupSignal: AbortSignal | undefined
    let setupStarted: () => void = () => {}
    const setupStartedOnce = new Promise<void>((resolve) => { setupStarted = resolve })
    plane.checkouts.create = (_root, _base, options) => new Promise((_resolve, reject) => {
      setupSignal = options?.signal
      setupStarted()
      setupSignal?.addEventListener('abort', () => reject(setupSignal?.reason), { once: true })
    })
    const drained: string[] = []
    plane.scheduler.drainQueue = (id: string) => { drained.push(id) }

    const turn = plane.runTurn({
      target: { kind: 'new-session' }, sessionId, input: { ...input(), worktreeBaseBranch: 'main' }, tools: [],
      options: { prompt: 'do the work', promptSource: 'typed' },
    })
    await setupStartedOnce
    expect(plane.stopSession(sessionId, HOST_ACTOR)).toBe(true)

    await expect(turn).rejects.toThrow('Interrupted')
    expect(setupSignal?.aborted).toBe(true)
    expect(drained).toEqual([sessionId])
    expect(backend.runs).toHaveLength(0)
    plane.shutdown()
  })
})

describe('Stop while a repository is copied', () => {
  test('cancels the copy, and no provider starts', async () => {
    // WHY: a Run on send copies the repository before anything else. Stop must
    // reach the copy, or the host goes on to clone and then start the agent.
    const backend = new RecordingBackend()
    const plane = new runtime.SessionRuntime(new Map([['claude-code', backend]]))
    plane.on('error', () => {})
    const sessionId = 'solus-stop-during-copy'
    let copySignal: AbortSignal | undefined
    let copyStarted: () => void = () => {}
    const copyStartedOnce = new Promise<void>((resolve) => { copyStarted = resolve })
    plane.launcher.prepareDispatchCheckout = (_repository, _caller, progress) => new Promise((_resolve, reject) => {
      copySignal = progress.signal
      copyStarted()
      copySignal?.addEventListener('abort', () => reject(copySignal?.reason), { once: true })
    })
    plane.scheduler.drainQueue = () => {}

    const turn = plane.runTurn({
      target: { kind: 'new-session' }, sessionId, input: input(), tools: [],
      repository: { repository: { cloneUrl: 'https://example.com/acme/app.git', worktreePath: '/tmp/acme-app' } },
      options: { prompt: 'do the work', promptSource: 'typed' },
    })
    await copyStartedOnce
    expect(plane.stopSession(sessionId, HOST_ACTOR)).toBe(true)

    await expect(turn).rejects.toThrow('Interrupted')
    expect(copySignal?.aborted).toBe(true)
    expect(backend.runs).toHaveLength(0)
    plane.shutdown()
  })
})

describe('Stop once the provider runs', () => {
  test('cancels the run before session_init', async () => {
    // WHY: until session_init the run has no thread to cancel by, only its handle.
    const backend = new RecordingBackend()
    const plane = new runtime.SessionRuntime(new Map([['claude-code', backend]]))
    plane.on('error', () => {})
    const sessionId = 'solus-stop-pending-run'

    const lifecycle = await plane.runTurn({
      target: { kind: 'new-session' }, sessionId, input: input(), tools: [],
      options: { prompt: 'do the work', promptSource: 'typed' },
    })
    void lifecycle.done.catch(() => {})
    expect(plane.stopSession(sessionId, HOST_ACTOR)).toBe(true)

    expect(backend.handles[0]?.abortController.signal.aborted).toBe(true)
    plane.shutdown()
  })

  test('cancels the background work the run left, and nothing once that work is gone', async () => {
    // WHY: Stop also ends the work the agent left running after its turn
    // (docs/background-work.md). A session with no work left has nothing to stop,
    // so Stop must not mark it interrupted.
    const backend = new RecordingBackend()
    const plane = new runtime.SessionRuntime(new Map([['claude-code', backend]]))
    plane.on('error', () => {})
    const sessionId = 'solus-stop-background'

    const lifecycle = await plane.runTurn({
      target: { kind: 'new-session' }, sessionId, input: input(), tools: [],
      options: { prompt: 'do the work', promptSource: 'typed' },
    })
    void lifecycle.done.catch(() => {})
    // The provider started its thread and left a background command when it exited.
    const session = plane.activeSessions.get(sessionId)!
    session.agentSessionId = 'thread-1'
    session.backgroundTaskIds = new Set(['command-1'])
    await backend.endRun()

    backend.hasWorkToCancel = true
    expect(plane.stopSession(sessionId, HOST_ACTOR)).toBe(true)
    expect(backend.cancelledThreads).toEqual(['thread-1'])

    // A later turn ends without background work: its stop closes with it.
    const next = await plane.runTurn({
      target: { kind: 'session', sessionId }, sessionId, input: input(), tools: [],
      options: { prompt: 'again', promptSource: 'typed' },
    })
    void next.done.catch(() => {})
    plane.activeSessions.get(sessionId)!.backgroundTaskIds = undefined
    await backend.endRun()
    expect(plane.turnStops.has(sessionId)).toBe(false)
    expect(plane.stopSession(sessionId, HOST_ACTOR)).toBe(false)
    plane.shutdown()
  })
})
