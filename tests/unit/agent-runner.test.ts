import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { AgentBackend, PermissionResponder, RunHandle } from '../../src/main/agents/agent-backend'
import { AgentRunner, type AgentRunRequest } from '../../src/main/agents/agent-runner'
import type { AgentId, AgentMetadata, NormalizedEvent } from '../../src/shared/types'

class FakePermissions implements PermissionResponder {
  getPendingInfo(): undefined { return undefined }
  respondToPermission(): boolean { return false }
  respondToQuestion(): boolean { return false }
  clearPendingForSession(): void {}
  setCurrentSessionId(): void {}
}

class FakeBackend extends EventEmitter implements AgentBackend {
  readonly permissions = new FakePermissions()
  readonly metadata: AgentMetadata
  handle: RunHandle | null = null

  constructor(readonly id: AgentId) {
    super()
    this.metadata = { id, label: id, models: [], defaultModel: '' }
  }

  startRun(request: AgentRunRequest): RunHandle {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const abortController = new AbortController()
    const runPromise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    abortController.signal.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true })
    this.handle = {
      sessionId: request.sessionId ?? null,
      persistence: request.persistence,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController,
      runPromise,
      _resolveRun: resolve,
      _rejectRun: reject,
    }
    return this.handle
  }

  init(sessionId: string): void {
    if (!this.handle) throw new Error('No run')
    this.handle.sessionId = sessionId
    this.emit('normalized', sessionId, {
      type: 'session_init',
      sessionId,
      model: '',
      skills: [],
    } satisfies NormalizedEvent)
  }

  complete(output = ''): void {
    if (!this.handle) throw new Error('No run')
    if (output) {
      this.emit('normalized', this.handle.sessionId, {
        type: 'task_complete',
        result: output,
      } satisfies NormalizedEvent)
    }
    this.handle._resolveRun()
  }

  cancelSession(): boolean {
    this.handle?.abortController.abort()
    return true
  }
  isSessionRunning(): boolean { return !!this.handle && !this.handle.abortController.signal.aborted }
  async steerSession(): Promise<'accepted'> { return 'accepted' }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
}

function request(provider: AgentId, overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    provider,
    prompt: 'hello',
    cwd: '/tmp/project',
    tools: [],
    permissionMode: 'ask',
    persistence: 'ephemeral',
    ...overrides,
  }
}

describe('AgentRunner', () => {
  test('returns one result shape and the final assembled output', async () => {
    const backend = new FakeBackend('codex')
    const runner = new AgentRunner(new Map([['codex', backend]]))
    const events: NormalizedEvent[] = []
    const run = runner.run(request('codex', { onEvent: (event) => events.push(event) }))

    backend.init('session-1')
    backend.complete('final answer')

    await expect(run.sessionId).resolves.toBe('session-1')
    await expect(run.done).resolves.toMatchObject({
      sessionId: 'session-1',
      output: 'final answer',
      toolCallCount: 0,
      permissionDenials: [],
    })
    expect(events.map(({ type }) => type)).toEqual(['session_init', 'task_complete'])
    expect(backend.listenerCount('normalized')).toBe(0)
    expect(backend.listenerCount('exit')).toBe(0)
  })

  test('uses streamed top-level text when the provider has no assembled result', async () => {
    const backend = new FakeBackend('claude-code')
    const runner = new AgentRunner(new Map([['claude-code', backend]]))
    const run = runner.run(request('claude-code'))

    backend.init('session-2')
    backend.emit('normalized', 'session-2', { type: 'text_chunk', text: 'partial answer' } satisfies NormalizedEvent)
    backend.complete()

    await expect(run.done).resolves.toMatchObject({ output: 'partial answer' })
  })

  test('cancels before session initialization and propagates the error', async () => {
    const backend = new FakeBackend('claude-code')
    const runner = new AgentRunner(new Map([['claude-code', backend]]))
    const run = runner.run(request('claude-code'))

    run.cancel()

    await Promise.all([
      expect(run.done).rejects.toThrow('Interrupted'),
      expect(run.sessionId).rejects.toThrow('Interrupted'),
    ])
  })

  test('times out through the same cancellation path', async () => {
    const backend = new FakeBackend('codex')
    const runner = new AgentRunner(new Map([['codex', backend]]))
    const run = runner.run(request('codex', { timeoutMs: 5 }))

    await expect(run.done).rejects.toThrow('timed out after 5ms')
    expect(backend.handle?.abortController.signal.aborted).toBe(true)
    expect(backend.listenerCount('normalized')).toBe(0)
  })

  test('rejects an unavailable provider without starting a run', () => {
    const runner = new AgentRunner(new Map())
    expect(() => runner.run(request('codex'))).toThrow('Unknown agent provider: codex')
  })
})
