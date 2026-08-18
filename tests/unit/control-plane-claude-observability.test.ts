import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '../../src/main/agents/agent-backend'
import type { AgentRunRequest } from '../../src/main/agents/agent-runner'
import type { AgentMetadata, NormalizedEvent, SessionRunInput } from '../../src/shared/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type ControlPlaneModule = typeof import('../../src/main/control-plane')
type MetricsDbModule = typeof import('../../src/main/observability/metrics-db')
type DbModule = typeof import('../../src/main/db')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let controlPlaneModule: ControlPlaneModule
let metricsDb: MetricsDbModule
let db: DbModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-claude-observability-'))
  process.env.SOLUS_DATA_DIR = dataDir
  controlPlaneModule = await import('../../src/main/control-plane')
  metricsDb = await import('../../src/main/observability/metrics-db')
  db = await import('../../src/main/db')
})

afterEach(() => {
  metricsDb.closeMetricsDb()
  db.closeDb()
  for (const file of ['metrics.db', 'metrics.db-wal', 'metrics.db-shm', 'solus.db', 'solus.db-wal', 'solus.db-shm']) {
    rmSync(join(dataDir, file), { force: true })
  }
})

afterAll(() => {
  metricsDb.closeMetricsDb()
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

/** Claude-shaped backend: CLI stream events arrive via `normalized`; the run
 *  promise resolves and `exit` fires in the same synchronous stack, exactly the
 *  ordering claude-backend.ts produces. tool_call_complete carries only an
 *  index — Claude has no per-tool provider outcome. */
class ClaudeShapedBackend extends EventEmitter implements AgentBackend {
  readonly id = 'claude-code' as const
  readonly metadata: AgentMetadata = { id: 'claude-code', label: 'Claude Code', models: [], defaultModel: 'claude-sonnet-5' }
  readonly permissions = new Permissions()
  readonly handles = new Map<string, RunHandle>()
  readonly pending = new Set<RunHandle>()

  startRun(request: AgentRunRequest): RunHandle {
    const agentSessionId = request.sessionId ?? 'claude-session-1'
    let resolve!: () => void
    let reject!: (error: Error) => void
    const handle: RunHandle = {
      agentSessionId: request.sessionId ?? null,
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
    queueMicrotask(() => {
      handle.agentSessionId = agentSessionId
      this.pending.delete(handle)
      this.handles.set(agentSessionId, handle)
      this.emit('normalized', agentSessionId, {
        type: 'session_init', sessionId: agentSessionId, model: 'claude-sonnet-5', skills: [],
      } satisfies NormalizedEvent)
    })
    return handle
  }

  send(agentSessionId: string, event: NormalizedEvent): void {
    this.emit('normalized', agentSessionId, event)
  }

  settle(agentSessionId: string): void {
    const handle = this.handles.get(agentSessionId)!
    handle._resolveRun()
    this.handles.delete(agentSessionId)
    this.emit('exit', agentSessionId, 0, null)
  }

  getSessionHandle(sessionId: string): RunHandle | undefined { return this.handles.get(sessionId) }
  getPendingHandles(): RunHandle[] { return [...this.pending] }
  cancelSession(): boolean { return false }
  isSessionRunning(sessionId: string): boolean { return this.handles.has(sessionId) }
  async steerSession(): Promise<null> { return null }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [] } }
}

function input(agentSessionId: string | null): SessionRunInput {
  return {
    provider: 'claude-code', agentSessionId, forked: false, workingDirectory: process.cwd(), projectPath: process.cwd(),
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null,
    model: 'claude-opus-5', preferredModel: 'claude-opus-5', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'ask', rateLimitBehavior: 'queue', extraInstructions: '',
  }
}

interface SpanRow {
  span_id: string
  parent_span_id: string | null
  trace_id: string
  kind: string
  name: string
  provider: string | null
  model: string | null
  origin: string | null
  started_at: number
  ended_at: number
  status: string
  attrs: string
}

function spans(sessionId: string): SpanRow[] {
  return metricsDb.getMetricsDb()
    .prepare('SELECT * FROM spans WHERE session_id = ? ORDER BY started_at, kind')
    .all(sessionId) as SpanRow[]
}

describe.serial('Claude turn capture end to end', () => {
  test('a full Claude turn writes natural-duration child spans to metrics.db', async () => {
    const backend = new ClaudeShapedBackend()
    const plane = new controlPlaneModule.ControlPlane(new Map([['claude-code', backend]]))
    plane.on('error', () => {})

    const lifecycle = await plane.runTurn({
      target: { kind: 'new-session' }, sessionId: 'solus-claude', input: input(null), tools: [],
      options: { prompt: 'run the build', promptSource: 'typed', skipTaskCreation: true },
    })
    await lifecycle.agentSessionId
    await Promise.resolve()

    const id = 'claude-session-1'
    backend.send(id, { type: 'thinking', state: 'start' })
    backend.send(id, { type: 'thinking', state: 'stop' })
    backend.send(id, { type: 'text_chunk', text: 'Running the build now.' })
    backend.send(id, { type: 'tool_call', toolName: 'Bash', toolId: 'toolu_1', index: 0 })
    // Claude completes tools by index only; the assembled input rides the completion.
    backend.send(id, { type: 'tool_call_complete', index: 0, toolInput: '{"command":"bun run build"}' })
    backend.send(id, { type: 'tool_result', toolUseId: 'toolu_1', content: 'ok', isError: false })
    backend.send(id, {
      type: 'task_complete', result: 'built', costUsd: 0.42, durationMs: 40, numTurns: 1,
      usage: { inputTokens: 1200, outputTokens: 90, cacheReadTokens: 300 }, sessionId: id,
      permissionDenials: [],
    })
    backend.settle(id)
    await lifecycle.done

    const rows = spans('solus-claude')
    const turn = rows.find((row) => row.kind === 'turn')!
    expect(turn.status).toBe('ok')
    expect(turn.provider).toBe('claude-code')
    // Executed model is latched from session_init, not the requested model.
    expect(turn.model).toBe('claude-sonnet-5')
    expect(turn.origin).toBe('typed')
    expect(JSON.parse(turn.attrs)).toMatchObject({
      prompt: 'run the build', promptSource: 'typed', promptChars: 13,
      costUsd: 0.42, inputTokens: 1200, outputTokens: 90, cacheReadTokens: 300,
      toolCallCount: 1, permissionDenialCount: 0,
    })

    const children = rows.filter((row) => row.kind !== 'turn')
    expect(children.every((row) => row.trace_id === turn.trace_id)).toBe(true)
    expect(children.every((row) => row.ended_at >= row.started_at)).toBe(true)
    // The turn's own shape, without the dispatch steps: those are Solus's
    // interior and are counted separately below, so adding one does not
    // rewrite what a turn is made of.
    expect(rows
      .map((row) => row.kind)
      .filter((kind) => kind !== 'internal.dispatch_step')
      .sort(),
    ).toEqual([
      'response_stream', 'setup', 'thinking', 'tool_call', 'turn', 'turn_settlement',
    ])

    // Dispatch steps hang off setup, not off the turn: they measure the
    // interior of the setup bar, and a step reparented to the root would claim
    // to be a phase of the turn beside thinking and tools.
    const setup = rows.find((row) => row.kind === 'setup')!
    const dispatchSteps = rows.filter((row) => row.kind === 'internal.dispatch_step')
    expect(dispatchSteps.length).toBeGreaterThan(0)
    const dispatchSpanIds = new Set(dispatchSteps.map((row) => row.span_id))
    expect(dispatchSteps.every((row) =>
      row.parent_span_id === setup.span_id || dispatchSpanIds.has(row.parent_span_id!),
    )).toBe(true)

    const tool = rows.find((row) => row.kind === 'tool_call')!
    expect(tool.name).toBe('Bash')
    expect(tool.parent_span_id).toBe(turn.span_id)
    expect(tool.status).toBe('ok')
    expect(JSON.parse(tool.attrs)).toMatchObject({ input: '{"command":"bun run build"}' })

    expect(JSON.parse(turn.attrs)).toMatchObject({ hasThinking: true })

    plane.shutdown()
  })

  test('a second Claude turn records inter-turn idle time', async () => {
    const backend = new ClaudeShapedBackend()
    const plane = new controlPlaneModule.ControlPlane(new Map([['claude-code', backend]]))
    plane.on('error', () => {})

    const first = await plane.runTurn({
      target: { kind: 'new-session' }, sessionId: 'solus-claude-idle', input: input(null), tools: [],
      options: { prompt: 'first', promptSource: 'typed', skipTaskCreation: true },
    })
    await first.agentSessionId
    await Promise.resolve()
    backend.settle('claude-session-1')
    await first.done

    const second = await plane.runTurn({
      target: { kind: 'session', sessionId: 'solus-claude-idle' }, sessionId: 'solus-claude-idle',
      input: input('claude-session-1'), tools: [],
      options: { prompt: 'second', promptSource: 'typed', skipTaskCreation: true },
    })
    await second.agentSessionId
    await Promise.resolve()
    backend.settle('claude-session-1')
    await second.done

    const turns = spans('solus-claude-idle').filter((row) => row.kind === 'turn')
    expect(turns).toHaveLength(2)
    expect(JSON.parse(turns[0].attrs).interTurnIdleMs).toBeUndefined()
    expect(JSON.parse(turns[1].attrs).interTurnIdleMs).toBeGreaterThanOrEqual(0)

    plane.shutdown()
  })
})
