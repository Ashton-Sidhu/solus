import { randomUUID } from 'node:crypto'
import { BaseAgentBackend } from '../base-backend'
import { resolveHomePath } from '../../../platform/paths'
import { createLogger } from '../../../logger'
import type { ProviderHistoryPage, SessionLoadMessage } from '@solus/contracts/session-history'
import type { AgentId, AgentMetadata, NormalizedEvent, PermissionOption, PlanDescriptor, PluginCommandsResult } from '@solus/contracts/types'
import type { AgentBackend, PermissionResponder, RunHandle } from '../agent-backend'
import type { AgentRunRequest, AgentRunSessionState } from '../agent-runner'
import { KeptHistory, TurnHistory } from '../kept-history'
import { materializeEvent, streamChunks, type ReplayLive, type ReplayScenario, type ReplayStep } from './replay-scenario'

const log = createLogger('ReplayBackend', 'replay-backend.ts')

/** Pace of the simulated stream (docs/replay-provider.md). */
export const REPLAY_CHUNK_DELAY_MS = 30
export const REPLAY_EVENT_DELAY_MS = 250
export const REPLAY_MAX_RECORDED_DELAY_MS = 2_000

/** How the backend waits. Tests pass one that does not. */
export interface ReplayClock {
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

const realClock: ReplayClock = {
  sleep: (ms, signal) => new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  }),
}

export interface ReplayBackendOptions {
  scenarios: ReplayScenario[]
  /** Where each replayed session keeps its history, so a reopened session shows it. */
  historyDirectory: string
  clock?: ReplayClock
}

type Answer = 'allow' | 'deny' | 'answered' | 'cancelled'

interface PendingAnswer {
  nativeSessionId: string
  toolName: string
  kind: 'permission' | 'question'
  options: PermissionOption[]
  finish(answer: Answer): void
}

/** How a played turn ended. */
type TurnEnd =
  | { kind: 'completed' }
  | { kind: 'denied'; toolName: string; toolUseId: string }
  | { kind: 'cancelled' }

type HeldRequest = Extract<NormalizedEvent, { type: 'permission_request' | 'question_request' | 'plan' }>

/** A request holds the turn until it is answered. A plan with no options
 *  (Codex) and a question answered by a message do not. */
function holdsTurn(event: NormalizedEvent): event is HeldRequest {
  return event.type === 'permission_request'
    || (event.type === 'question_request' && event.responseMode !== 'message')
    || (event.type === 'plan' && event.options.length > 0)
}

/**
 * A free agent for development. It plays recorded turns through the real
 * session runtime, transcript, and clients, so a turn renders without a model.
 * Each scenario is a model; each prompt plays the scenario's next turn and wraps
 * around. Runs in the server process (docs/replay-provider.md).
 */
export class ReplayBackend extends BaseAgentBackend implements AgentBackend {
  readonly id: AgentId = 'replay'
  readonly permissions: PermissionResponder

  private readonly scenarios: Map<string, ReplayScenario>
  private readonly history: KeptHistory
  private readonly clock: ReplayClock
  /** Per provider session: the scenario it plays and the turn it plays next. */
  private readonly sessions = new Map<string, { scenarioId: string; nextTurn: number }>()
  private readonly pending = new Map<string, PendingAnswer>()

  constructor(options: ReplayBackendOptions) {
    super()
    if (options.scenarios.length === 0) throw new Error('The replay backend needs at least one scenario')
    this.scenarios = new Map(options.scenarios.map((scenario) => [scenario.id, scenario]))
    this.history = new KeptHistory(options.historyDirectory)
    this.clock = options.clock ?? realClock
    this.permissions = {
      getPendingInfo: (questionId) => {
        const pending = this.pending.get(questionId)
        return pending ? { toolName: pending.toolName, sessionId: pending.nativeSessionId } : undefined
      },
      respondToPermission: (questionId, decision) => {
        const pending = this.pending.get(questionId)
        if (!pending || pending.kind !== 'permission') return false
        const allowed = decision === 'allow' || decision === 'allow-session'
          || pending.options.find((option) => option.id === decision)?.kind === 'allow'
        pending.finish(allowed ? 'allow' : 'deny')
        return true
      },
      respondToQuestion: (questionId) => {
        const pending = this.pending.get(questionId)
        if (!pending || pending.kind !== 'question') return false
        pending.finish('answered')
        return true
      },
      clearPendingForSession: (nativeSessionId) => {
        for (const pending of this.pending.values()) {
          if (pending.nativeSessionId === nativeSessionId) pending.finish('cancelled')
        }
      },
      setCurrentSessionId: () => {},
    }
  }

  get metadata(): AgentMetadata {
    const scenarios = [...this.scenarios.values()]
    return {
      id: 'replay',
      label: 'Replay (dev)',
      models: scenarios.map((scenario) => ({ id: scenario.id, label: scenario.label })),
      defaultModel: scenarios[0]!.id,
      available: true,
      // A replay always asks what its recording asked: the modes change nothing.
      capabilities: { planMode: false, permissions: false },
    }
  }

  startRun(request: AgentRunRequest, sessionState?: AgentRunSessionState): RunHandle {
    const conversation = request.conversation ?? { kind: 'start' }
    // A resumed session keeps its id; a new or forked one gets a fresh random id,
    // so ids never repeat across sessions or restarts.
    const nativeSessionId = conversation.kind === 'resume' ? conversation.threadId : randomUUID()
    let resolveRun!: () => void
    let rejectRun!: (err: Error) => void
    const runPromise = new Promise<void>((resolve, reject) => { resolveRun = resolve; rejectRun = reject })
    const handle: RunHandle = {
      agentSessionId: conversation.kind === 'resume' ? nativeSessionId : null,
      sessionId: sessionState?.sessionId,
      persistence: request.persistence,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController: new AbortController(),
      runPromise,
      _resolveRun: resolveRun,
      _rejectRun: rejectRun,
    }
    this.pendingRuns.push(handle)
    // After this returns, so the caller has registered the run before its first event.
    setImmediate(() => void this.playOrFail(handle, request, nativeSessionId))
    return handle
  }

  private async playOrFail(handle: RunHandle, request: AgentRunRequest, nativeSessionId: string): Promise<void> {
    try {
      await this.play(handle, request, nativeSessionId)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      log.error('replay_run_failed', { sessionId: handle.sessionId ?? null, error: err.message })
      this.emit('error', handle.agentSessionId, err, handle)
      this.finishRun(handle)
      handle._rejectRun(err)
    }
  }

  private async play(handle: RunHandle, request: AgentRunRequest, nativeSessionId: string): Promise<void> {
    const scenarioId = request.model || this.metadata.defaultModel
    const scenario = this.scenarios.get(scenarioId)
    if (!scenario) {
      throw new Error(`Unknown replay scenario "${scenarioId}". The replay scenarios are: ${[...this.scenarios.keys()].join(', ')}.`)
    }
    this.promoteToActive(handle, nativeSessionId)
    this.emit('normalized', nativeSessionId, { type: 'session_init', sessionId: nativeSessionId, model: scenario.id, skills: [] } satisfies NormalizedEvent)

    let state = this.sessions.get(nativeSessionId)
    if (!state || state.scenarioId !== scenario.id) {
      state = { scenarioId: scenario.id, nextTurn: 0 }
      this.sessions.set(nativeSessionId, state)
    }
    const turn = scenario.turns[state.nextTurn % scenario.turns.length]!
    state.nextTurn += 1

    const history = new TurnHistory(request.prompt)
    const live: ReplayLive = { workspace: resolveHomePath(request.cwd), turnKey: randomUUID().slice(0, 8) }
    const end = await this.playTurn(handle, nativeSessionId, turn, live, history)
    if (request.persistence === 'session') this.history.append(nativeSessionId, history.rows())

    this.finishRun(handle)
    handle._resolveRun()
    if (end.kind === 'cancelled') {
      // As a stopped Claude run reports it: no result, an interrupt signal.
      this.emit('exit', nativeSessionId, null, 'SIGINT', handle)
      return
    }
    const permissionDenials = end.kind === 'denied' ? [{ toolName: end.toolName, toolUseId: end.toolUseId }] : []
    this.emit('normalized', nativeSessionId, {
      type: 'task_complete',
      result: history.resultText,
      costUsd: 0,
      durationMs: Date.now() - handle.startedAt,
      numTurns: 1,
      usage: {},
      sessionId: nativeSessionId,
      permissionDenials,
    } satisfies NormalizedEvent)
    this.emit('exit', nativeSessionId, 0, null, handle)
  }

  private async playTurn(handle: RunHandle, nativeSessionId: string, turn: ReplayStep[], live: ReplayLive, history: TurnHistory): Promise<TurnEnd> {
    const signal = handle.abortController.signal
    const emit = (event: NormalizedEvent) => {
      history.record(event)
      this.emit('normalized', nativeSessionId, event)
    }
    const toolIndexes = new Map<string, number>()
    for (const step of turn) {
      const event = materializeEvent(step.event, live)
      const recordedDelay = step.afterMs === undefined ? undefined : Math.min(step.afterMs, REPLAY_MAX_RECORDED_DELAY_MS)

      if (event.type === 'text_chunk') {
        if (!await this.streamText(event, recordedDelay, signal, emit)) return { kind: 'cancelled' }
        continue
      }

      await this.clock.sleep(recordedDelay ?? REPLAY_EVENT_DELAY_MS, signal)
      if (signal.aborted) return { kind: 'cancelled' }

      if (event.type === 'tool_call') {
        toolIndexes.set(event.toolId, event.index)
        handle.toolCallCount += 1
      }

      if (!holdsTurn(event)) {
        emit(event)
        continue
      }
      history.record(event)
      const answer = await this.ask(handle, nativeSessionId, event)
      if (answer === 'cancelled' || signal.aborted) return { kind: 'cancelled' }
      if (answer !== 'deny') continue
      // A denied plan is a stop: the session runtime cancels the run itself.
      if (event.type !== 'permission_request') return { kind: 'cancelled' }
      return this.denyTool(handle, event, toolIndexes, emit)
    }
    return { kind: 'completed' }
  }

  /** Streams recorded text in small chunks. False when the run stopped mid-stream. */
  private async streamText(
    event: Extract<NormalizedEvent, { type: 'text_chunk' }>,
    recordedDelay: number | undefined,
    signal: AbortSignal,
    emit: (event: NormalizedEvent) => void,
  ): Promise<boolean> {
    for (const [index, chunk] of streamChunks(event.text).entries()) {
      await this.clock.sleep(index === 0 ? recordedDelay ?? REPLAY_CHUNK_DELAY_MS : REPLAY_CHUNK_DELAY_MS, signal)
      if (signal.aborted) return false
      emit({ ...event, text: chunk })
    }
    return true
  }

  /** The recording holds only the approved path, so a denial ends the turn
   *  here, with the tool failed as a provider reports a declined call. */
  private denyTool(
    handle: RunHandle,
    event: Extract<NormalizedEvent, { type: 'permission_request' }>,
    toolIndexes: Map<string, number>,
    emit: (event: NormalizedEvent) => void,
  ): TurnEnd {
    const toolUseId = event.toolUseId ?? event.questionId
    if (event.toolUseId) {
      emit({ type: 'tool_call_complete', index: toolIndexes.get(event.toolUseId) ?? 0, toolId: event.toolUseId, outcome: { status: 'failed', declined: true } })
      emit({ type: 'tool_result', toolUseId: event.toolUseId, content: 'The user denied this action.', isError: true })
    }
    handle.permissionDenials.push({ tool_name: event.toolName, tool_use_id: toolUseId })
    return { kind: 'denied', toolName: event.toolName, toolUseId }
  }

  /** Shows a request and waits for its answer, or for the run to stop. */
  private ask(
    handle: RunHandle,
    nativeSessionId: string,
    event: HeldRequest,
  ): Promise<Answer> {
    const signal = handle.abortController.signal
    if (event.type !== 'question_request') handle.sawPermissionRequest = true
    return new Promise<Answer>((resolve) => {
      const finish = (answer: Answer) => {
        if (!this.pending.delete(event.questionId)) return
        signal.removeEventListener('abort', onAbort)
        resolve(answer)
      }
      const onAbort = () => finish('cancelled')
      this.pending.set(event.questionId, {
        nativeSessionId,
        toolName: event.type === 'permission_request' ? event.toolName : event.type === 'plan' ? 'ExitPlanMode' : 'AskUserQuestion',
        kind: event.type === 'question_request' ? 'question' : 'permission',
        options: event.type === 'question_request' ? [] : event.options,
        finish,
      })
      signal.addEventListener('abort', onAbort, { once: true })
      // Registered first, so an answer given while the event is delivered is not lost.
      this.emit('normalized', nativeSessionId, event)
    })
  }

  /** A turn the user sends while one plays waits for the next turn. */
  async steerSession(): Promise<RunHandle | null> {
    return null
  }

  async loadSession(nativeSessionId: string, _projectPath?: string, limit?: number): Promise<SessionLoadMessage[]> {
    return this.history.load(nativeSessionId, limit)
  }

  async loadSessionFirstTurn(nativeSessionId: string): Promise<SessionLoadMessage[]> {
    return this.history.firstTurn(nativeSessionId)
  }

  async loadSessionPage(nativeSessionId: string, _projectPath: string | undefined, turnLimit: number, before?: string): Promise<ProviderHistoryPage> {
    return this.history.page(nativeSessionId, turnLimit, before)
  }

  async listPlans(): Promise<PlanDescriptor[]> {
    return []
  }

  async loadPlanContent(): Promise<string | null> {
    return null
  }

  async listPluginCommands(): Promise<PluginCommandsResult> {
    return { global: [], project: [] }
  }

  async refreshPluginCommands(): Promise<void> {}

  protected override _errorMessage(): string {
    return 'The replay run failed'
  }
}
