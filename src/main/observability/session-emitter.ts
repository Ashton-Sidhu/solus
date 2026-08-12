import { randomUUID } from 'node:crypto'
import type { NormalizedEvent, PromptSource, UsageData } from '../../shared/types'
import { createLogger } from '../logger'
import { writeSpan, type SpanAttributes, type SpanStatus } from './facade'
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
      if (dimensions.taskId) state.rootAttrs.taskId = dimensions.taskId
      if (dimensions.automationId) state.rootAttrs.automationId = dimensions.automationId
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
      if (event.type === 'text_chunk' && !event.parentToolUseId) {
        state.rootAttrs.timeToFirstTokenMs ??= Math.max(0, arrivedAt - state.startedAt)
        return
      }
      if (event.type === 'thinking' && !event.parentToolUseId) {
        if (event.state === 'start') state.rootAttrs.hasThinking = true
        return
      }
      if (event.type === 'tool_call') {
        this.startTool(state, event, event.startedAtMs ?? arrivedAt)
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
        span.endedAt = Math.max(span.startedAt, event.completedAtMs ?? arrivedAt)
        span.status = spanStatusForToolOutcome(event.outcome)
        state.openSpans.delete(key)
        return
      }
      if (event.type === 'tool_result') {
        const span = state.toolSpans.get(this.toolKey(event.toolUseId))
        if (span && event.isError) {
          span.status = 'error'
          span.attrs.outcomeStatus = 'error'
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
      } else {
        this.completeChild(state, span, endedAt, status)
      }
      state.openSpans.delete(key)
    }

    state.rootAttrs.toolCallCount = state.toolSpans.size
    if (state.rootAttrs.permissionDenialCount === undefined) state.rootAttrs.permissionDenialCount = 0

    if (state.dimensions?.provider === 'codex' && state.latestCodexUsage) {
      if (state.codexUsageBaseline) {
        setUsageAttrs(state.rootAttrs, usageDelta(state.latestCodexUsage, state.codexUsageBaseline))
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
