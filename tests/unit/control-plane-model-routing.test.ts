import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { AgentBackend, RunHandle } from '@solus/server/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/agents/agent-runner'
import type { AgentMetadata, NormalizedEvent, SessionRunInput } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let module: typeof import('@solus/server/control-plane')
let routing: typeof import('@solus/server/agents/model-routing')

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-model-routing-'))
  process.env.SOLUS_DATA_DIR = dataDir
  module = await import('@solus/server/control-plane')
  routing = await import('@solus/server/agents/model-routing')
})
afterAll(async () => {
  ;(await import('@solus/server/db')).closeDb()
  ;(await import('@solus/server/observability/metrics-db')).closeMetricsDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

class Backend extends EventEmitter implements AgentBackend {
  readonly id = 'claude-code' as const
  readonly metadata: AgentMetadata = { id: 'claude-code', label: 'Claude', models: [{ id: 'claude-sonnet-5', label: 'Sonnet' }], defaultModel: 'claude-sonnet-5' }
  readonly permissions = {
    getPendingInfo: () => undefined,
    respondToPermission: () => false,
    respondToQuestion: () => false,
    clearPendingForSession: () => {},
    setCurrentSessionId: () => {},
  }
  requests: AgentRunRequest[] = []
  handle?: RunHandle
  /** Appended to the model the provider reports running, as Claude reports its
   *  long-context variant. */
  runtimeModelSuffix = ''
  startRun(request: AgentRunRequest): RunHandle {
    this.requests.push(request)
    let resolve!: () => void
    let reject!: (error: Error) => void
    const handle: RunHandle = {
      agentSessionId: null, persistence: 'session', startedAt: Date.now(), toolCallCount: 0,
      sawPermissionRequest: false, permissionDenials: [], abortController: new AbortController(),
      runPromise: new Promise<void>((res, rej) => { resolve = res; reject = rej }),
      _resolveRun: resolve, _rejectRun: reject,
    }
    this.handle = handle
    queueMicrotask(() => {
      handle.agentSessionId = 'routed-thread'
      this.emit('normalized', 'routed-thread', { type: 'session_init', sessionId: 'routed-thread', model: `${request.model}${this.runtimeModelSuffix}`, skills: [] })
    })
    return handle
  }
  finish() {
    this.handle?._resolveRun()
    this.handle = undefined
    this.emit('exit', 'routed-thread', 0, null)
  }
  cancelSession() { this.handle?._resolveRun(); return true }
  isSessionRunning() { return !!this.handle }
  getSessionHandle() { return this.handle }
  getPendingHandles() { return this.handle && !this.handle.agentSessionId ? [this.handle] : [] }
  async steerSession() { return null }
  getEnrichedError() { return { message: 'failed', stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 } }
  async listSessions() { return [] }
  async loadSession() { return [] }
  async listPlans() { return [] }
  async loadPlanContent() { return null }
  async listPluginCommands() { return { global: [], project: [] } }
  async refreshPluginCommands() {}
  invalidatePlanCache() {}
}

function input(): SessionRunInput {
  return {
    provider: 'codex', agentSessionId: null, forked: false, workingDirectory: dataDir, projectPath: dataDir,
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null,
    model: 'auto', preferredModel: 'auto', reasoningEffort: 'high', fastMode: true,
    permissionMode: 'ask', rateLimitBehavior: 'ask', extraInstructions: '',
  }
}

describe('Auto session dispatch', () => {
  test('Stop during routing prevents a provider run', async () => {
    const backend = new Backend()
    const installed = spyOn(routing, 'installedRoutingProviders').mockResolvedValue([backend.metadata])
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const route = spyOn(routing, 'routeModelPrompt').mockImplementation((_prompt, _config, _agents, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      started()
    }))
    const plane = new module.ControlPlane(new Map([['claude-code', backend]]))
    plane.on('error', () => {})
    try {
      const pending = plane.runTurn({ sessionId: 'cancel-auto', input: input(), target: { kind: 'new-session' }, tools: [], options: { prompt: 'Help me', skipTaskCreation: true } })
      void pending.catch(() => {})
      await ready
      expect(plane.stopSession('cancel-auto')).toBe(true)
      await expect(pending).rejects.toThrow('Interrupted')
      expect(backend.requests).toHaveLength(0)
    } finally {
      plane.shutdown()
      installed.mockRestore()
      route.mockRestore()
    }
  })

  test('publishes and persists the resolved provider and model, then continues without routing again', async () => {
    const backend = new Backend()
    const installed = spyOn(routing, 'installedRoutingProviders').mockResolvedValue([backend.metadata])
    const route = spyOn(routing, 'routeModelPrompt').mockResolvedValue({ provider: 'claude-code', modelId: 'claude-sonnet-5', category: 'general', usedFallback: false })
    const plane = new module.ControlPlane(new Map([['claude-code', backend]]))
    const events: NormalizedEvent[] = []
    plane.on('event', (_id, event) => { events.push(event) })
    plane.on('error', () => {})
    try {
      const runInput = input()
      const first = await plane.runTurn({ sessionId: 'auto-session', input: runInput, target: { kind: 'new-session' }, tools: [], options: { prompt: 'Help me', skipTaskCreation: true } })
      await first.agentSessionId
      expect(backend.requests[0]).toMatchObject({ provider: 'claude-code', model: 'claude-sonnet-5', reasoningEffort: 'medium', fastMode: false })
      expect(events.find(event => event.type === 'model_routed')).toMatchObject({ provider: 'claude-code', modelConfig: { modelId: 'claude-sonnet-5', reasoningEffort: 'medium' } })
      const { getIndexedSession } = await import('@solus/server/db/session-indexer')
      expect(getIndexedSession('routed-thread')).toMatchObject({ provider: 'claude-code', model: 'claude-sonnet-5', reasoningEffort: 'medium' })
      backend.finish()
      await first.done
      // Auto's selection is the turn's own setup work: the insights waterfall
      // must show it as a step under setup, with what it chose and why.
      const { getMetricsDb } = await import('@solus/server/observability/metrics-db')
      const spans = getMetricsDb().prepare('SELECT kind, name, parent_span_id, span_id, attrs FROM spans WHERE session_id = ?').all('auto-session') as Array<{ kind: string; name: string; parent_span_id: string | null; span_id: string; attrs: string }>
      const step = spans.find(span => span.kind === 'internal.dispatch_step' && span.name === 'model_route')!
      expect(step).toBeDefined()
      expect(step.parent_span_id).toBe(spans.find(span => span.kind === 'internal.dispatch_step' && span.name === 'launch_run')!.span_id)
      expect(JSON.parse(step.attrs)).toMatchObject({
        step: 'launch_run.model_route', requestedModel: 'auto', provider: 'claude-code', modelId: 'claude-sonnet-5', category: 'general', usedFallback: false,
      })
      // The turn itself says how its model was chosen, so `turns` can be
      // sliced by Auto with no join — even though routing has since replaced
      // `preferredModel` on the input with the model it picked.
      const turn = getMetricsDb().prepare('SELECT model, requested_model FROM turns WHERE session_id = ?').get('auto-session')
      expect(turn).toEqual({ model: 'claude-sonnet-5', requested_model: 'auto' })
      const next = await plane.runTurn({ sessionId: 'auto-session', input: { ...runInput, agentSessionId: 'routed-thread' }, target: { kind: 'session', sessionId: 'auto-session' }, tools: [], options: { prompt: 'Continue', skipTaskCreation: true } })
      await next.agentSessionId
      expect(route).toHaveBeenCalledTimes(1)
      expect(backend.requests[1]).toMatchObject({ provider: 'claude-code', model: 'claude-sonnet-5', reasoningEffort: 'medium', conversation: { kind: 'resume', threadId: 'routed-thread' } })
      backend.finish()
      await next.done
    } finally {
      plane.shutdown()
      installed.mockRestore()
      route.mockRestore()
    }
  })
})

describe('turn model dimensions', () => {
  test('records the model resolved for this provider and the window its variant ran at', async () => {
    const backend = new Backend()
    backend.runtimeModelSuffix = '[1m]'
    const plane = new module.ControlPlane(new Map([['claude-code', backend]]))
    plane.on('error', () => {})
    try {
      // The session was handed off from Codex: its stored preference still
      // names the Codex model, while the turn runs the Claude model resolved
      // for it. A turn that says "asked for a Codex model, ran Opus" would
      // make a requested-versus-ran comparison report a reroute that never
      // happened.
      const run = await plane.runTurn({
        sessionId: 'handed-off',
        input: { ...input(), provider: 'claude-code', model: 'claude-sonnet-5', preferredModel: 'gpt-6-astra', contextWindow: 1_000_000 },
        target: { kind: 'new-session' },
        tools: [],
        options: { prompt: 'Help me', skipTaskCreation: true },
      })
      await run.agentSessionId
      backend.finish()
      await run.done
      const { getMetricsDb } = await import('@solus/server/observability/metrics-db')
      const turn = getMetricsDb().prepare('SELECT model, requested_model, context_window FROM turns WHERE session_id = ?').get('handed-off')
      // One model is one `model` value, so a median by model compares models,
      // not context-window variants of one model.
      expect(turn).toEqual({ model: 'claude-sonnet-5', requested_model: 'claude-sonnet-5', context_window: 1_000_000 })
    } finally {
      plane.shutdown()
    }
  })
})
