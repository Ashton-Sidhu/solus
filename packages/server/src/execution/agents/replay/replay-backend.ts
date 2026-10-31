import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { BaseAgentBackend } from '../base-backend'
import { resolveHomePath } from '../../../platform/paths'
import { createLogger } from '../../../logger'
import { startsHistoryTurn, type ProviderHistoryPage, type SessionLoadMessage } from '@solus/contracts/session-history'
import type { AgentId, AgentMetadata, NormalizedEvent, PermissionOption, PlanDescriptor, PluginCommandsResult } from '@solus/contracts/types'
import type { AgentBackend, PermissionResponder, RunHandle } from '../agent-backend'
import type { AgentRunRequest, AgentRunSessionState } from '../agent-runner'
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

const historySchema = z.array(z.object({
  role: z.string(),
  content: z.string(),
  timestamp: z.number(),
  toolName: z.string().optional(),
  toolId: z.string().optional(),
  toolInput: z.string().optional(),
  toolStatus: z.enum(['running', 'completed', 'error']).optional(),
  isSubagent: z.boolean().optional(),
  subagentType: z.string().optional(),
  parentToolUseId: z.string().optional(),
  planContent: z.string().optional(),
  planToolUseId: z.string().optional(),
}))

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
  private readonly historyDirectory: string
  private readonly clock: ReplayClock
  /** Per provider session: the scenario it plays and the turn it plays next. */
  private readonly sessions = new Map<string, { scenarioId: string; nextTurn: number }>()
  private readonly pending = new Map<string, PendingAnswer>()

  constructor(options: ReplayBackendOptions) {
    super()
    if (options.scenarios.length === 0) throw new Error('The replay backend needs at least one scenario')
    this.scenarios = new Map(options.scenarios.map((scenario) => [scenario.id, scenario]))
    this.historyDirectory = options.historyDirectory
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
      this.emit('error', handle.agentSessionId, err)
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
    if (request.persistence === 'session') this.appendHistory(nativeSessionId, history.rows())

    this.finishRun(handle)
    handle._resolveRun()
    if (end.kind === 'cancelled') {
      // As a stopped Claude run reports it: no result, an interrupt signal.
      this.emit('exit', nativeSessionId, null, 'SIGINT')
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
    this.emit('exit', nativeSessionId, 0, null)
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

  private historyFile(nativeSessionId: string): string {
    return join(this.historyDirectory, `${nativeSessionId.replace(/[^\w-]/g, '_')}.json`)
  }

  private readHistory(nativeSessionId: string): SessionLoadMessage[] {
    const file = this.historyFile(nativeSessionId)
    if (!existsSync(file)) return []
    try {
      return historySchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    } catch (error) {
      log.warn('replay_history_unreadable', { file, error: error instanceof Error ? error.message : String(error) })
      return []
    }
  }

  private appendHistory(nativeSessionId: string, rows: SessionLoadMessage[]): void {
    try {
      mkdirSync(this.historyDirectory, { recursive: true })
      writeFileSync(this.historyFile(nativeSessionId), JSON.stringify([...this.readHistory(nativeSessionId), ...rows]))
    } catch (error) {
      log.warn('replay_history_write_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  async loadSession(nativeSessionId: string, _projectPath?: string, limit?: number): Promise<SessionLoadMessage[]> {
    const rows = this.readHistory(nativeSessionId)
    return limit === undefined ? rows : rows.slice(-limit)
  }

  async loadSessionFirstTurn(nativeSessionId: string): Promise<SessionLoadMessage[]> {
    const rows = this.readHistory(nativeSessionId)
    const first = rows.findIndex(startsHistoryTurn)
    const second = first < 0 ? -1 : rows.findIndex((row, index) => index > first && startsHistoryTurn(row))
    return second < 0 ? rows : rows.slice(0, second)
  }

  /** `before` is the index of the first row of the page after this one. */
  async loadSessionPage(nativeSessionId: string, _projectPath: string | undefined, turnLimit: number, before?: string): Promise<ProviderHistoryPage> {
    const rows = this.readHistory(nativeSessionId)
    const end = before === undefined ? rows.length : Math.max(0, Math.min(rows.length, Number(before)))
    let start = end
    let turns = 0
    while (start > 0 && turns < turnLimit) {
      start -= 1
      if (startsHistoryTurn(rows[start]!)) turns += 1
    }
    return { messages: rows.slice(start, end), before: start > 0 ? String(start) : null }
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

/** The rows one played turn adds to its session's history. */
class TurnHistory {
  private readonly messages: SessionLoadMessage[] = []
  private readonly tools = new Map<string, SessionLoadMessage>()
  private text: SessionLoadMessage | null = null
  /** The turn's own prose, which is its result. */
  resultText = ''

  constructor(prompt: string) {
    this.messages.push({ role: 'user', content: prompt, timestamp: Date.now() })
  }

  record(event: NormalizedEvent): void {
    if (event.type === 'text_chunk') this.recordText(event)
    else if (event.type === 'tool_call') this.recordToolCall(event)
    else if (event.type === 'tool_call_update' || event.type === 'tool_call_complete' || event.type === 'tool_result') this.recordToolProgress(event)
    else if (event.type === 'thinking' && event.state === 'stop' && event.text) this.push({ role: 'reasoning', content: event.text, timestamp: Date.now() })
    else if (event.type === 'plan' && event.planContent.trim()) {
      const row: SessionLoadMessage = { role: 'plan', content: '', planContent: event.planContent, timestamp: Date.now() }
      if (event.planToolUseId) row.planToolUseId = event.planToolUseId
      this.push(row)
    }
  }

  /** A row that is not prose: the prose after it starts a new row. */
  private push(row: SessionLoadMessage): void {
    this.text = null
    this.messages.push(row)
  }

  private recordText(event: Extract<NormalizedEvent, { type: 'text_chunk' }>): void {
    // A sub-agent's prose belongs to its own transcript, not this turn's answer.
    if (event.parentToolUseId) return
    this.resultText += event.text
    if (!this.text) {
      this.text = { role: 'assistant', content: '', timestamp: Date.now() }
      this.messages.push(this.text)
    }
    this.text.content += event.text
  }

  private recordToolCall(event: Extract<NormalizedEvent, { type: 'tool_call' }>): void {
    const row: SessionLoadMessage = { role: 'tool', content: event.content ?? '', toolName: event.toolName, toolId: event.toolId, toolStatus: 'running', timestamp: Date.now() }
    if (event.toolInput !== undefined) row.toolInput = event.toolInput
    if (event.parentToolUseId) row.parentToolUseId = event.parentToolUseId
    if (event.isSubagent) row.isSubagent = true
    if (event.subagentType) row.subagentType = event.subagentType
    this.tools.set(event.toolId, row)
    this.push(row)
  }

  private recordToolProgress(event: Extract<NormalizedEvent, { type: 'tool_call_update' | 'tool_call_complete' | 'tool_result' }>): void {
    const toolId = event.type === 'tool_result' ? event.toolUseId : event.toolId
    const row = toolId ? this.tools.get(toolId) : undefined
    if (!row) return
    if (event.type === 'tool_result') {
      row.content = event.content
      row.toolStatus = event.isError ? 'error' : 'completed'
      return
    }
    if (event.toolInput !== undefined) row.toolInput = event.toolInput
    if (event.type === 'tool_call_update' && event.content !== undefined) row.content += event.content
    if (event.type === 'tool_call_complete' && event.outcome) row.toolStatus = event.outcome.status === 'failed' ? 'error' : 'completed'
  }

  rows(): SessionLoadMessage[] {
    // A tool the turn never finished reads as finished once the turn is over.
    for (const row of this.tools.values()) if (row.toolStatus === 'running') row.toolStatus = 'completed'
    return this.messages
  }
}
