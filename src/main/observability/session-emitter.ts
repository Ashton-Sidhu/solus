import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { NormalizedEvent, PromptSource, UsageData } from '../../shared/types'
import { createLogger } from '../logger'
import { writeSpan, type SpanAttributes, type SpanStatus } from './facade'
import { codexTokenCostUsd } from './model-pricing'
import { SPAN_KINDS, SPAN_SERVICES, type SpanKind } from './registries'
import {
  applyTaskCompleteAttrs,
  capped,
  copyUsage,
  setUsageAttrs,
  spanStatusForToolOutcome,
  terminalOutcome,
  usageDelta,
  type TurnOutcome,
} from './session-emitter-support'
export type { TurnOutcome } from './session-emitter-support'

const PROMPT_LIMIT = 4 * 1024
const TOOL_INPUT_LIMIT = 8 * 1024

const log = createLogger('SessionEmitter', 'session-emitter.ts')

export interface TurnDimensions {
  provider: string
  model: string
  projectRoot: string
  origin: PromptSource
  reasoningEffort?: string
  taskId?: string
  automationId?: string
  /** Display names snapshotted at dispatch — what a user recognizes the ids by
   *  in queries. Point-in-time by design: telemetry records what a thing was
   *  called when the turn ran, and stays queryable if it is later renamed. */
  automationName?: string
  taskTitle?: string
  branch?: string
  isResume: boolean
}

interface BufferedSpan {
  spanId: string
  parentSpanId: string
  kind: SpanKind
  name: string
  startedAt: number
  endedAt?: number
  status?: SpanStatus
  attrs: SpanAttributes
}

interface TurnState {
  sessionId: string
  traceId: string
  startedAt: number
  setupEndedAt?: number
  dimensions?: TurnDimensions
  observedModel?: string
  rootAttrs: SpanAttributes
  completedSpans: BufferedSpan[]
  openSpans: Map<string, BufferedSpan>
  toolSpans: Map<string, BufferedSpan>
  toolKeyByIndex: Map<number, string>
  permissionOptions: Map<string, Set<string>>
  rateLimitKey?: string
  terminalStatus?: SpanStatus
  terminalAt?: number
  latestCodexUsage?: UsageData
  codexUsageBaseline?: UsageData
  taskComplete?: Extract<NormalizedEvent, { type: 'task_complete' }>
  firstProviderEventAt?: number
  lastProviderEventAt?: number
  providerCompletedAt?: number
}

/** Records one bounded trace per turn. `sessionId` groups a session's turn traces. */
export class SessionEmitter {
  private turns = new Map<string, TurnState>()
  private settlingTurns = new Map<string, TurnState>()
  private lastSettledAt = new Map<string, number>()
  private codexUsageBaselines = new Map<string, UsageData>()

  beginTurn(input: {
    sessionId: string
    prompt: string
    promptSource: PromptSource
    startedAt: number
    dispatchedAt?: number
  }): string {
    let traceId = ''
    this.safe(input.sessionId, () => {
      const existing = this.turns.get(input.sessionId)
      if (existing) this.settlingTurns.set(existing.traceId, existing)
      const prompt = capped(input.prompt, PROMPT_LIMIT)
      const previousSettledAt = this.lastSettledAt.get(input.sessionId)
      const dispatchedAt = input.dispatchedAt ?? input.startedAt
      traceId = randomUUID()
      this.turns.set(input.sessionId, {
        sessionId: input.sessionId,
        traceId,
        startedAt: input.startedAt,
        rootAttrs: {
          prompt: prompt.value,
          promptChars: input.prompt.length,
          promptSource: input.promptSource,
          ...(prompt.truncated ? { promptTruncated: true } : {}),
          ...(existing
            ? { interTurnIdleMs: 0 }
            : previousSettledAt === undefined
              ? {}
              : { interTurnIdleMs: Math.max(0, dispatchedAt - previousSettledAt) }),
        },
        completedSpans: [],
        openSpans: new Map(),
        toolSpans: new Map(),
        toolKeyByIndex: new Map(),
        permissionOptions: new Map(),
      })
    })
    return traceId
  }

  completeSetup(sessionId: string, dimensions: TurnDimensions, endedAt = Date.now()): void {
    this.safe(sessionId, () => {
      const state = this.turns.get(sessionId)
      if (!state) return
      state.dimensions = { ...dimensions, model: state.observedModel ?? dimensions.model }
      state.setupEndedAt = Math.max(state.startedAt, endedAt)
      state.rootAttrs.reasoningEffort = dimensions.reasoningEffort ?? ''
      state.rootAttrs.isResume = dimensions.isResume
      if (dimensions.taskId) state.rootAttrs.taskId = dimensions.taskId
      if (dimensions.automationId) state.rootAttrs.automationId = dimensions.automationId
      if (dimensions.automationName) state.rootAttrs.automationName = dimensions.automationName
      if (dimensions.taskTitle) state.rootAttrs.taskTitle = dimensions.taskTitle
      if (dimensions.branch) state.rootAttrs.branch = dimensions.branch
      // The project's display name is its folder name, matching the projects
      // manifest's own `folder_name` convention.
      const projectName = basename(dimensions.projectRoot)
      if (projectName) state.rootAttrs.projectName = projectName
      if (dimensions.provider === 'codex') {
        state.codexUsageBaseline = this.codexUsageBaselines.get(sessionId)
          ?? (dimensions.isResume ? undefined : {})
      }
      if (state.taskComplete) applyTaskCompleteAttrs(state.rootAttrs, dimensions.provider, state.taskComplete)
      this.completeChild(state, {
        spanId: randomUUID(),
        parentSpanId: state.traceId,
        kind: SPAN_KINDS.setup,
        name: 'setup',
        startedAt: state.startedAt,
        endedAt: state.setupEndedAt,
        status: 'ok',
        attrs: {},
      }, state.setupEndedAt, 'ok')
    })
  }

  recordQueueWait(sessionId: string, enqueuedAt: number, runStartedAt: number): void {
    this.safe(sessionId, () => {
      const state = this.turns.get(sessionId)
      if (!state) return
      this.completeChild(state, {
        spanId: randomUUID(),
        parentSpanId: state.traceId,
        kind: SPAN_KINDS.queueWait,
        name: 'queue_wait',
        startedAt: Math.min(enqueuedAt, runStartedAt),
        attrs: {},
      }, runStartedAt, 'ok')
    })
  }

  onEvent(sessionId: string, event: NormalizedEvent, arrivedAt = Date.now()): void {
    this.safe(sessionId, () => {
      const state = this.turns.get(sessionId)
      if (!state) return
      state.firstProviderEventAt ??= arrivedAt
      state.lastProviderEventAt = Math.max(state.lastProviderEventAt ?? arrivedAt, arrivedAt)
      if (event.type === 'task_complete') state.providerCompletedAt = arrivedAt
      this.observeFirstActivity(state, event, arrivedAt)
      if (event.type === 'session_init') {
        state.observedModel = event.model
        if (state.dimensions) state.dimensions.model = event.model
        return
      }
      if (event.type === 'model_rerouted') {
        state.observedModel = event.toModel
        if (state.dimensions) state.dimensions.model = event.toModel
        return
      }
      if (event.type === 'text_chunk') {
        if (!event.parentToolUseId) {
          const timeToFirstTextMs = Math.max(0, arrivedAt - state.startedAt)
          state.rootAttrs.timeToFirstTextMs ??= timeToFirstTextMs
        }
        this.observeResponseChunk(state, event.parentToolUseId, arrivedAt)
        return
      }
      if (event.type === 'thinking') {
        if (!event.parentToolUseId && event.state === 'start') state.rootAttrs.hasThinking = true
        if (event.state === 'start') this.startThinking(state, event.parentToolUseId, arrivedAt)
        else this.finishThinking(state, event.parentToolUseId, arrivedAt, 'ok')
        return
      }
      if (event.type === 'tool_call') {
        const startedAt = event.startedAtMs ?? arrivedAt
        this.finishResponseStream(state, event.parentToolUseId, 'ok')
        this.finishThinking(state, event.parentToolUseId, startedAt, 'ok')
        this.startTool(state, event, startedAt)
        return
      }
      if (event.type === 'tool_call_update') {
        const span = state.toolSpans.get(this.toolKey(event.toolId))
        if (span && event.toolInput) this.setToolInput(span, event.toolInput)
        return
      }
      if (event.type === 'tool_call_complete') {
        const key = event.toolId ? this.toolKey(event.toolId) : state.toolKeyByIndex.get(event.index)
        if (!key) return
        const span = state.openSpans.get(key)
        if (!span) return
        if (event.toolInput) this.setToolInput(span, event.toolInput)
        if (event.outcome) {
          if (event.outcome.status) span.attrs.outcomeStatus = event.outcome.status
          if (typeof event.outcome.exitCode === 'number') span.attrs.exitCode = event.outcome.exitCode
          if (event.outcome.error) span.attrs.error = capped(event.outcome.error, TOOL_INPUT_LIMIT).value
          if (event.outcome.declined !== undefined) span.attrs.declined = event.outcome.declined
          if (event.outcome.durationMs !== undefined) span.attrs.providerDurationMs = event.outcome.durationMs
        }
        // Codex item/completed is the execution boundary and carries an outcome
        // or provider timestamp. Claude content_block_stop only means that the
        // tool input finished streaming; its later tool_result closes the actual
        // execution interval.
        if (event.completedAtMs !== undefined || event.outcome !== undefined) {
          span.endedAt = Math.max(span.startedAt, event.completedAtMs ?? arrivedAt)
          span.status = spanStatusForToolOutcome(event.outcome)
          state.openSpans.delete(key)
        }
        return
      }
      if (event.type === 'tool_result') {
        const key = this.toolKey(event.toolUseId)
        const span = state.toolSpans.get(key)
        if (span) {
          span.status = event.isError ? 'error' : 'ok'
          span.attrs.outcomeStatus = event.isError ? 'error' : 'completed'
          if (state.openSpans.has(key)) {
            span.endedAt = Math.max(span.startedAt, arrivedAt)
            state.openSpans.delete(key)
          }
        }
        return
      }
      if (event.type === 'permission_request') {
        this.startPermission(state, event, event.startedAtMs ?? arrivedAt)
        return
      }
      if (event.type === 'background_task_started') {
        this.startBackgroundTask(state, event, arrivedAt)
        return
      }
      if (event.type === 'background_task_settled') {
        const key = this.backgroundKey(event.taskId)
        const span = state.openSpans.get(key)
        if (!span) return
        const status = event.status === 'completed'
          ? 'ok'
          : event.status === 'stopped' || event.status === 'killed'
            ? 'interrupted'
            : 'error'
        span.attrs.outcomeStatus = event.status
        state.openSpans.delete(key)
        this.completeChild(state, span, arrivedAt, status)
        return
      }
      if (event.type === 'usage' && event.run) {
        state.latestCodexUsage = copyUsage(event.run)
        return
      }
      if (event.type === 'task_complete') {
        this.finishResponseStream(state, undefined, 'ok')
        state.taskComplete = event
        if (state.dimensions) applyTaskCompleteAttrs(state.rootAttrs, state.dimensions.provider, event)
      }
    })
  }

  acceptRateLimit(sessionId: string, name: string, startedAt = Date.now()): void {
    this.safe(sessionId, () => {
      const state = this.turns.get(sessionId)
      if (!state || state.rateLimitKey) return
      const key = 'rate_limit'
      state.rateLimitKey = key
      state.openSpans.set(key, this.newChild(state, SPAN_KINDS.rateLimitWait, name, startedAt, {}))
    })
  }

  resolveRateLimit(sessionId: string, endedAt = Date.now()): void {
    this.safe(sessionId, () => {
      const state = this.turns.get(sessionId)
      if (!state?.rateLimitKey) return
      const span = state.openSpans.get(state.rateLimitKey)
      if (span) this.completeChild(state, span, endedAt, 'ok')
      state.openSpans.delete(state.rateLimitKey)
      state.rateLimitKey = undefined
    })
  }

  resolvePermission(sessionId: string, questionId: string, optionId: string, endedAt = Date.now()): void {
    this.safe(sessionId, () => {
      const state = this.turns.get(sessionId)
      if (!state) return
      const key = this.permissionKey(questionId)
      const span = state.openSpans.get(key)
      if (!span) return
      const granted = state.permissionOptions.get(key)?.has(optionId) === true
      span.attrs.decision = granted ? 'granted' : 'denied'
      if (!granted) {
        state.rootAttrs.permissionDenialCount = Number(state.rootAttrs.permissionDenialCount ?? 0) + 1
      }
      state.openSpans.delete(key)
      state.permissionOptions.delete(key)
      this.completeChild(state, span, endedAt, granted ? 'ok' : 'error')
    })
  }

  recordTerminal(sessionId: string, status: SpanStatus, at = Date.now()): void {
    this.safe(sessionId, () => {
      const state = this.turns.get(sessionId)
      if (!state) return
      state.terminalStatus = status
      state.terminalAt = at
    })
  }

  finishTurn(sessionId: string, fallback: TurnOutcome, endedAt = Date.now(), traceId?: string): TurnOutcome {
    let outcome = fallback
    this.safe(sessionId, () => {
      const active = this.turns.get(sessionId)
      const state = traceId && active?.traceId !== traceId ? this.settlingTurns.get(traceId) : active
      if (!state) return
      const status = state.terminalStatus
        ?? (fallback === 'completed' ? 'ok' : fallback === 'interrupted' ? 'interrupted' : 'error')
      const finalAt = Math.max(state.startedAt, state.terminalAt ?? endedAt)
      outcome = terminalOutcome(status)
      this.finish(state, status, finalAt)
    })
    return outcome
  }

  private finish(state: TurnState, status: SpanStatus, endedAt: number): void {
    if (!state.setupEndedAt) {
      state.setupEndedAt = endedAt
      this.completeChild(state, {
        spanId: randomUUID(),
        parentSpanId: state.traceId,
        kind: SPAN_KINDS.setup,
        name: 'setup',
        startedAt: state.startedAt,
        attrs: {},
      }, endedAt, status)
    }

    for (const [key, span] of state.openSpans) {
      if (span.kind === SPAN_KINDS.toolCall) {
        span.endedAt = Math.max(span.startedAt, endedAt)
        span.status = status
      } else if (span.kind === SPAN_KINDS.responseStream) {
        this.completeChild(state, span, span.endedAt ?? endedAt, status)
      } else {
        this.completeChild(state, span, endedAt, status)
      }
      state.openSpans.delete(key)
    }

    state.rootAttrs.toolCallCount = state.toolSpans.size
    if (state.rootAttrs.permissionDenialCount === undefined) state.rootAttrs.permissionDenialCount = 0
    if (state.firstProviderEventAt !== undefined) {
      state.rootAttrs.timeToFirstProviderEventMs = Math.max(0, state.firstProviderEventAt - state.startedAt)
    }
    if (state.lastProviderEventAt !== undefined) {
      state.rootAttrs.timeToLastProviderEventMs = Math.max(0, state.lastProviderEventAt - state.startedAt)
    }
    if (state.providerCompletedAt !== undefined) {
      state.rootAttrs.timeToProviderCompleteMs = Math.max(0, state.providerCompletedAt - state.startedAt)
      this.completeChild(state, {
        spanId: randomUUID(),
        parentSpanId: state.traceId,
        kind: SPAN_KINDS.turnSettlement,
        name: 'Solus settlement',
        startedAt: Math.min(state.providerCompletedAt, endedAt),
        attrs: {},
      }, endedAt, status)
    }

    if (state.dimensions?.provider === 'codex' && state.latestCodexUsage) {
      if (state.codexUsageBaseline) {
        const usage = usageDelta(state.latestCodexUsage, state.codexUsageBaseline)
        setUsageAttrs(state.rootAttrs, usage)
        const costUsd = codexTokenCostUsd(state.dimensions.model, usage)
        if (costUsd !== undefined) state.rootAttrs.costUsd = costUsd
      }
      this.codexUsageBaselines.set(state.sessionId, copyUsage(state.latestCodexUsage))
    }

    const dimensions = state.dimensions
    this.write({
      spanId: state.traceId,
      traceId: state.traceId,
      kind: SPAN_KINDS.turn,
      name: 'turn',
      service: SPAN_SERVICES.sessions,
      startedAt: state.startedAt,
      endedAt,
      status,
      sessionId: state.sessionId,
      provider: dimensions?.provider,
      model: dimensions?.model,
      projectRoot: dimensions?.projectRoot,
      origin: dimensions?.origin,
      attrs: state.rootAttrs,
    }, state.sessionId)

    for (const span of state.completedSpans) this.writeChild(state, span)
    for (const span of state.toolSpans.values()) {
      this.writeChild(state, span)
    }

    if (this.turns.get(state.sessionId) === state) this.turns.delete(state.sessionId)
    this.settlingTurns.delete(state.traceId)
    this.lastSettledAt.set(state.sessionId, endedAt)
  }

  private startTool(state: TurnState, event: Extract<NormalizedEvent, { type: 'tool_call' }>, startedAt: number): void {
    const key = this.toolKey(event.toolId)
    if (state.toolSpans.has(key)) return
    const parent = event.parentToolUseId ? state.toolSpans.get(this.toolKey(event.parentToolUseId)) : undefined
    const span = this.newChild(
      state,
      SPAN_KINDS.toolCall,
      event.toolName,
      startedAt,
      {
        ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
        isSubagent: event.isSubagent === true,
      },
      parent?.spanId,
    )
    if (event.toolInput) this.setToolInput(span, event.toolInput)
    state.toolKeyByIndex.set(event.index, key)
    state.toolSpans.set(key, span)
    state.openSpans.set(key, span)
  }

  private startThinking(state: TurnState, parentToolUseId: string | undefined, startedAt: number): void {
    const key = this.thinkingKey(parentToolUseId)
    if (state.openSpans.has(key)) return
    this.finishResponseStream(state, parentToolUseId, 'ok')
    state.openSpans.set(key, this.newChild(
      state,
      SPAN_KINDS.thinking,
      'thinking',
      startedAt,
      {},
      this.activityParentSpanId(state, parentToolUseId),
    ))
  }

  private observeFirstActivity(state: TurnState, event: NormalizedEvent, arrivedAt: number): void {
    if (state.rootAttrs.timeToFirstActivityMs !== undefined) return
    let activityAt: number | null = null
    if (event.type === 'thinking' && event.state === 'start' && !event.parentToolUseId) {
      activityAt = arrivedAt
    } else if (event.type === 'text_chunk' && !event.parentToolUseId) {
      activityAt = arrivedAt
    } else if (event.type === 'tool_call' && !event.parentToolUseId) {
      activityAt = event.startedAtMs ?? arrivedAt
    } else if (event.type === 'assistant_message' && !event.parentToolUseId) {
      activityAt = arrivedAt
    }
    if (activityAt !== null) {
      state.rootAttrs.timeToFirstActivityMs = Math.max(0, activityAt - state.startedAt)
    }
  }

  private finishThinking(
    state: TurnState,
    parentToolUseId: string | undefined,
    endedAt: number,
    status: SpanStatus,
  ): void {
    const key = this.thinkingKey(parentToolUseId)
    const span = state.openSpans.get(key)
    if (!span) return
    state.openSpans.delete(key)
    this.completeChild(state, span, endedAt, status)
  }

  private observeResponseChunk(
    state: TurnState,
    parentToolUseId: string | undefined,
    arrivedAt: number,
  ): void {
    this.finishThinking(state, parentToolUseId, arrivedAt, 'ok')
    const key = this.responseStreamKey(parentToolUseId)
    let span = state.openSpans.get(key)
    if (!span) {
      span = this.newChild(
        state,
        SPAN_KINDS.responseStream,
        'response_stream',
        arrivedAt,
        {},
        this.activityParentSpanId(state, parentToolUseId),
      )
      state.openSpans.set(key, span)
    }
    span.endedAt = Math.max(span.startedAt, arrivedAt)
  }

  private finishResponseStream(
    state: TurnState,
    parentToolUseId: string | undefined,
    status: SpanStatus,
  ): void {
    const key = this.responseStreamKey(parentToolUseId)
    const span = state.openSpans.get(key)
    if (!span) return
    state.openSpans.delete(key)
    this.completeChild(state, span, span.endedAt ?? span.startedAt, status)
  }

  private activityParentSpanId(state: TurnState, parentToolUseId: string | undefined): string {
    if (!parentToolUseId) return state.traceId
    return state.toolSpans.get(this.toolKey(parentToolUseId))?.spanId ?? state.traceId
  }

  private startPermission(
    state: TurnState,
    event: Extract<NormalizedEvent, { type: 'permission_request' }>,
    startedAt: number,
  ): void {
    const key = this.permissionKey(event.questionId)
    if (state.openSpans.has(key)) return
    state.openSpans.set(key, this.newChild(state, SPAN_KINDS.permissionWait, event.toolName, startedAt, {}))
    state.permissionOptions.set(
      key,
      new Set(event.options
        .filter((option) => option.kind === 'allow' || option.id === 'allow' || option.id === 'accept')
        .map((option) => option.id)),
    )
  }

  private startBackgroundTask(
    state: TurnState,
    event: Extract<NormalizedEvent, { type: 'background_task_started' }>,
    startedAt: number,
  ): void {
    const key = this.backgroundKey(event.taskId)
    if (state.openSpans.has(key)) return
    const parent = event.toolUseId ? state.toolSpans.get(this.toolKey(event.toolUseId)) : undefined
    state.openSpans.set(key, this.newChild(
      state,
      SPAN_KINDS.backgroundTask,
      event.taskId,
      startedAt,
      { blocking: false, ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}) },
      parent?.spanId,
    ))
  }

  private newChild(
    state: TurnState,
    kind: SpanKind,
    name: string,
    startedAt: number,
    attrs: SpanAttributes,
    parentSpanId = state.traceId,
  ): BufferedSpan {
    return {
      spanId: randomUUID(),
      parentSpanId,
      kind,
      name,
      startedAt: Math.max(state.setupEndedAt ?? state.startedAt, startedAt),
      attrs,
    }
  }

  private completeChild(state: TurnState, span: BufferedSpan, endedAt: number, status: SpanStatus): void {
    span.endedAt = Math.max(span.startedAt, endedAt)
    span.status = status
    state.completedSpans.push(span)
  }

  private writeChild(state: TurnState, span: BufferedSpan): void {
    const dimensions = state.dimensions
    this.write({
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      traceId: state.traceId,
      kind: span.kind,
      name: span.name,
      service: SPAN_SERVICES.sessions,
      startedAt: span.startedAt,
      endedAt: span.endedAt ?? span.startedAt,
      status: span.status ?? 'unknown',
      sessionId: state.sessionId,
      provider: dimensions?.provider,
      model: dimensions?.model,
      projectRoot: dimensions?.projectRoot,
      origin: dimensions?.origin,
      attrs: span.attrs,
    }, state.sessionId)
  }

  private setToolInput(span: BufferedSpan, input: string): void {
    const value = capped(input, TOOL_INPUT_LIMIT)
    span.attrs.input = value.value
    if (value.truncated) span.attrs.inputTruncated = true
  }

  private toolKey(toolId: string): string {
    return `tool:${toolId}`
  }

  private thinkingKey(parentToolUseId: string | undefined): string {
    return `thinking:${parentToolUseId ?? 'root'}`
  }

  private responseStreamKey(parentToolUseId: string | undefined): string {
    return `response:${parentToolUseId ?? 'root'}`
  }

  private permissionKey(questionId: string): string {
    return `permission:${questionId}`
  }

  private backgroundKey(taskId: string): string {
    return `background:${taskId}`
  }

  private write(input: Parameters<typeof writeSpan>[0], sessionId: string): void {
    try {
      writeSpan(input)
    } catch (error) {
      log.warn('span_write_failed', {
        sessionId,
        spanId: input.spanId,
        kind: input.kind,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private safe(sessionId: string, action: () => void): void {
    try {
      action()
    } catch (error) {
      log.warn('span_write_failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
