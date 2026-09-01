import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/agents/agent-runner'
import type { AgentId, AgentMetadata } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type AgentRunnerModule = typeof import('@solus/server/agents/agent-runner')
type MetricsDbModule = typeof import('@solus/server/observability/metrics-db')
type RegistriesModule = typeof import('@solus/server/observability/registries')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let runnerModule: AgentRunnerModule
let metricsDb: MetricsDbModule
let registries: RegistriesModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-agent-runner-spans-'))
  process.env.SOLUS_DATA_DIR = dataDir
  runnerModule = await import('@solus/server/agents/agent-runner')
  metricsDb = await import('@solus/server/observability/metrics-db')
  registries = await import('@solus/server/observability/registries')
})

afterEach(() => {
  metricsDb.closeMetricsDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `metrics.db${suffix}`), { force: true })
})

afterAll(() => {
  metricsDb.closeMetricsDb()
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
  readonly id: AgentId = 'codex'
  readonly metadata: AgentMetadata = { id: 'codex', label: 'Codex', models: [], defaultModel: '' }
  readonly permissions = new Permissions()
  handle?: RunHandle
  throwOnStart = false

  startRun(request: AgentRunRequest): RunHandle {
    if (this.throwOnStart) throw new Error('start failed')
    let resolve!: () => void
    let reject!: (error: Error) => void
    const abortController = new AbortController()
    const runPromise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
    abortController.signal.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true })
    this.handle = {
      agentSessionId: request.sessionId ?? null,
      persistence: request.persistence,
      startedAt: Date.now(),
      toolCallCount: 2,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController,
      runPromise,
      _resolveRun: resolve,
      _rejectRun: reject,
    }
    return this.handle
  }

  complete(code = 0): void {
    this.handle?._resolveRun()
    this.emit('exit', this.handle?.agentSessionId ?? null, code, null)
  }

  reject(error: Error): void {
    this.handle?._rejectRun(error)
  }

  cancelSession(): boolean {
    this.handle?.abortController.abort()
    return true
  }
  isSessionRunning(): boolean { return !!this.handle && !this.handle.abortController.signal.aborted }
  async steerSession(): Promise<null> { return null }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
}

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    provider: 'codex', prompt: 'summarize', cwd: '/repo', tools: [], permissionMode: 'plan',
    persistence: 'ephemeral', service: registries.SPAN_SERVICES.textGeneration, ...overrides,
  }
}

function row(): { status: string; attrs: string } {
  return metricsDb.getMetricsDb().prepare("SELECT status, attrs FROM spans WHERE kind = 'agent_run'").get() as { status: string; attrs: string }
}

describe.serial('AgentRunner observability', () => {
  test('records one coarse span for an ephemeral result', async () => {
    const backend = new Backend()
    const runner = new runnerModule.AgentRunner(new Map([['codex', backend]]))
    const run = runner.run(request())
    backend.complete(0)
    await run.done
    expect(row().status).toBe('ok')
    expect(JSON.parse(row().attrs)).toMatchObject({ promptChars: 9, toolCallCount: 2 })
  })

  test('closes the span when startRun throws synchronously', () => {
    const backend = new Backend()
    backend.throwOnStart = true
    const runner = new runnerModule.AgentRunner(new Map([['codex', backend]]))
    expect(() => runner.run(request())).toThrow('start failed')
    expect(row().status).toBe('error')
  })

  test('closes the span on provider rejection', async () => {
    const backend = new Backend()
    const runner = new runnerModule.AgentRunner(new Map([['codex', backend]]))
    const run = runner.run(request())
    backend.reject(new Error('provider rejected'))
    await expect(run.done).rejects.toThrow('provider rejected')
    expect(row().status).toBe('error')
  })

  test('records timeout as an error and closes the span', async () => {
    const backend = new Backend()
    const runner = new runnerModule.AgentRunner(new Map([['codex', backend]]))
    const run = runner.run(request({ timeoutMs: 5 }))
    await expect(run.done).rejects.toThrow('timed out after 5ms')
    expect(row().status).toBe('error')
    expect(JSON.parse(row().attrs)).toMatchObject({ timedOut: true })
  })
})
