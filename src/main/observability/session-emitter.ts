import { randomUUID } from 'node:crypto'
import type { NormalizedEvent, PromptSource, UsageData } from '../../shared/types'
import { createLogger } from '../logger'
import { writeSpan, type SpanAttributes, type SpanStatus } from './facade'
import { SPAN_KINDS, SPAN_SERVICES, type SpanKind } from './registries'
import {
  applyTaskCompleteAttrs,
  backgroundKey,
  capped,
  copyUsage,
  permissionKey,
  setUsageAttrs,
  spanStatusForToolOutcome,
  terminalOutcome,
  toolKey,
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
  spans: BufferedSpan[]
  blockingOpen: number
  blockingWaveEndAt: number
  modelWork?: BufferedSpan
  firstModelWork?: BufferedSpan
  thinkingDepth: number
  thinkingWithoutModel: boolean
  toolKeyByIndex: Map<number, string>
  toolKeys: Set<string>
  permissionKeys: Set<string>
  backgroundKeys: Set<string>
  rateLimitKey?: string
  terminalStatus?: SpanStatus
  terminalAt?: number
  latestCodexUsage?: UsageData
  codexUsageBaseline?: UsageData
  taskComplete?: Extract<NormalizedEvent, { type: 'task_complete' }>
}

/** Owns the in-memory state for complete, per-session turn traces. */
export class SessionEmitter {
  private turns = new Map<string, TurnState>()
  private settlingTurns = new Map<string, TurnState>()
  private lastSettledAt = new Map<string, number>()
  /** Composite keys are `${sessionId}\0${providerToolId}`. */
  private openTools = new Map<string, BufferedSpan>()
  private toolSpans = new Map<string, BufferedSpan>()
  private openPermissions = new Map<string, BufferedSpan & { grantedOptions: Set<string> }>()
  private openBackgroundTasks = new Map<string, BufferedSpan>()
  private openRateLimits = new Map<string, BufferedSpan>()
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
        spans: [],
        blockingOpen: 0,
        blockingWaveEndAt: input.startedAt,
        thinkingDepth: 0,
        thinkingWithoutModel: false,
        toolKeyByIndex: new Map(),
        toolKeys: new Set(),
        permissionKeys: new Set(),
        backgroundKeys: new Set(),
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
      state.spans.push({
        spanId: randomUUID(),
        parentSpanId: state.traceId,
        kind: SPAN_KINDS.setup,
        name: 'setup',
        startedAt: state.startedAt,
        endedAt: state.setupEndedAt,
        status: 'ok',
        attrs: {},
      })
      this.startModelWork(state, state.setupEndedAt)
    })
  }

  recordQueueWait(sessionId: string, enqueuedAt: number, runStartedAt: number): void {
    this.safe(sessionId, () => {
      const state = this.turns.get(sessionId)
      if (!state) return
      state.spans.push({
        spanId: randomUUID(),
        parentSpanId: state.traceId,
        kind: SPAN_KINDS.queueWait,
        name: 'queue_wait',
        startedAt: Math.min(enqueuedAt, runStartedAt),
        endedAt: runStartedAt,
        status: 'ok',
        attrs: {},
      })
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
        this.recordFirstToken(state, arrivedAt)
        return
      }
      if (event.type === 'thinking' && !event.parentToolUseId) {
        if (event.state === 'start') {
          state.thinkingDepth++
          if (state.modelWork) state.modelWork.attrs.hasThinking = true
          else state.thinkingWithoutModel = true
        } else {
          state.thinkingDepth = Math.max(0, state.thinkingDepth - 1)
        }
        return
      }
      if (event.type === 'tool_call') {
        this.startTool(state, event, event.startedAtMs ?? arrivedAt)
        return
      }
      if (event.type === 'tool_call_update') {
        const key = toolKey(sessionId, event.toolId)
        const span = this.toolSpans.get(key)
        if (span && event.toolInput) this.setToolInput(span, event.toolInput)
        return
      }
      if (event.type === 'tool_call_complete') {
        const key = event.toolId
          ? toolKey(sessionId, event.toolId)
          : state.toolKeyByIndex.get(event.index)
        if (!key) return
        const span = this.openTools.get(key)
        if (!span) return
        if (event.toolInput) this.setToolInput(span, event.toolInput)
        if (event.outcome) {
          if (event.outcome.status) span.attrs.outcomeStatus = event.outcome.status
          if (typeof event.outcome.exitCode === 'number') span.attrs.exitCode = event.outcome.exitCode
          if (event.outcome.error) span.attrs.error = capped(event.outcome.error, TOOL_INPUT_LIMIT).value
          if (event.outcome.declined !== undefined) span.attrs.declined = event.outcome.declined
          if (event.outcome.durationMs !== undefined) span.attrs.providerDurationMs = event.outcome.durationMs
        }
        this.endBlockingSpan(
          state,
          span,
          event.completedAtMs ?? arrivedAt,
          spanStatusForToolOutcome(event.outcome),
        )
        this.openTools.delete(key)
        return
      }
      if (event.type === 'tool_result') {
        const span = this.toolSpans.get(toolKey(sessionId, event.toolUseId))
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
        const key = backgroundKey(sessionId, event.taskId)
        const span = this.openBackgroundTasks.get(key)
        if (!span) return
        span.endedAt = Math.max(span.startedAt, arrivedAt)
        span.status = event.status === 'completed' ? 'ok' : event.status === 'stopped' || event.status === 'killed' ? 'interrupted' : 'error'
        span.attrs.outcomeStatus = event.status
        this.openBackgroundTasks.delete(key)
        state.backgroundKeys.delete(key)
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
      const key = `${sessionId}\0rate_limit`
      const span = this.startBlockingSpan(state, SPAN_KINDS.rateLimitWait, name, startedAt, {})
      state.rateLimitKey = key
      this.openRateLimits.set(key, span)
    })
  }

  resolveRateLimit(sessionId: string, endedAt = Date.now()): void {
    this.safe(sessionId, () => {
      const state = this.turns.get(sessionId)
      if (!state?.rateLimitKey) return
      const span = this.openRateLimits.get(state.rateLimitKey)
      if (span) this.endBlockingSpan(state, span, endedAt, 'ok')
      this.openRateLimits.delete(state.rateLimitKey)
      state.rateLimitKey = undefined
    })
  }

  resolvePermission(sessionId: string, questionId: string, optionId: string, endedAt = Date.now()): void {
    this.safe(sessionId, () => {
      const state = this.turns.get(sessionId)
      if (!state) return
      const key = permissionKey(sessionId, questionId)
      const span = this.openPermissions.get(key)
      if (!span) return
      const granted = span.grantedOptions.has(optionId)
      span.attrs.decision = granted ? 'granted' : 'denied'
      if (!granted) {
        state.rootAttrs.permissionDenialCount = Number(state.rootAttrs.permissionDenialCount ?? 0) + 1
      }
      this.endBlockingSpan(state, span, endedAt, granted ? 'ok' : 'error')
      this.openPermissions.delete(key)
      state.permissionKeys.delete(key)
    })
  }

  recordTerminal(sessionId: string, status: SpanStatus, at = Date.now()): void {
    this.safe(sessionId, () => {
      const state = this.turns.get(sessionId)
      if (!state) return
      state.terminalStatus = status
      state.terminalAt = at
      this.finalizeOpenChildren(state, status, at)
    })
  }

  finishTurn(sessionId: string, fallback: TurnOutcome, endedAt = Date.now(), traceId?: string): TurnOutcome {
    let outcome = fallback
    this.safe(sessionId, () => {
      const active = this.turns.get(sessionId)
      const state = traceId && active?.traceId !== traceId
        ? this.settlingTurns.get(traceId)
        : active
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
      state.spans.push({
        spanId: randomUUID(),
        parentSpanId: state.traceId,
        kind: SPAN_KINDS.setup,
        name: 'setup',
        startedAt: state.startedAt,
        endedAt,
        status,
        attrs: {},
      })
    }

    this.finalizeOpenChildren(state, status, endedAt)
    state.blockingOpen = 0
    this.closeModelWork(state, endedAt, status === 'ok' ? 'ok' : status)

    state.rootAttrs.toolCallCount = state.toolKeys.size
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
    for (const span of state.spans) {
      const spanEndedAt = Math.max(span.startedAt, span.endedAt ?? endedAt)
      this.write({
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        traceId: state.traceId,
        kind: span.kind,
        name: span.name,
        service: SPAN_SERVICES.sessions,
        startedAt: span.startedAt,
        endedAt: spanEndedAt,
        status: span.status ?? status,
        sessionId: state.sessionId,
        provider: dimensions?.provider,
        model: dimensions?.model,
        projectRoot: dimensions?.projectRoot,
        origin: dimensions?.origin,
        attrs: span.attrs,
      }, state.sessionId)
    }

    for (const key of state.toolKeys) this.toolSpans.delete(key)
    if (this.turns.get(state.sessionId) === state) this.turns.delete(state.sessionId)
    this.settlingTurns.delete(state.traceId)
    this.lastSettledAt.set(state.sessionId, endedAt)
  }

  private startTool(state: TurnState, event: Extract<NormalizedEvent, { type: 'tool_call' }>, startedAt: number): void {
    const key = toolKey(state.sessionId, event.toolId)
    if (this.openTools.has(key)) return
    const parent = event.parentToolUseId
      ? this.toolSpans.get(toolKey(state.sessionId, event.parentToolUseId))
      : undefined
    const attrs: SpanAttributes = {
      ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
      isSubagent: event.isSubagent === true,
    }
    const span = this.startBlockingSpan(
      state,
      SPAN_KINDS.toolCall,
      event.toolName,
      startedAt,
      attrs,
      parent?.spanId,
    )
    if (event.toolInput) this.setToolInput(span, event.toolInput)
    state.toolKeyByIndex.set(event.index, key)
    state.toolKeys.add(key)
    this.openTools.set(key, span)
    this.toolSpans.set(key, span)
  }

  private startPermission(
    state: TurnState,
    event: Extract<NormalizedEvent, { type: 'permission_request' }>,
    startedAt: number,
  ): void {
    const key = permissionKey(state.sessionId, event.questionId)
    if (this.openPermissions.has(key)) return
    const span = this.startBlockingSpan(state, SPAN_KINDS.permissionWait, event.toolName, startedAt, {}) as BufferedSpan & { grantedOptions: Set<string> }
    span.grantedOptions = new Set(event.options.filter((option) => option.kind === 'allow' || option.id === 'allow' || option.id === 'accept').map((option) => option.id))
    state.permissionKeys.add(key)
    this.openPermissions.set(key, span)
  }

  private startBackgroundTask(
    state: TurnState,
    event: Extract<NormalizedEvent, { type: 'background_task_started' }>,
    startedAt: number,
  ): void {
    const key = backgroundKey(state.sessionId, event.taskId)
    if (this.openBackgroundTasks.has(key)) return
    const parent = event.toolUseId
      ? this.toolSpans.get(toolKey(state.sessionId, event.toolUseId))
      : undefined
    const span: BufferedSpan = {
      spanId: randomUUID(),
      parentSpanId: parent?.spanId ?? state.traceId,
      kind: SPAN_KINDS.backgroundTask,
      name: event.taskId,
      startedAt: Math.max(state.startedAt, startedAt),
      attrs: { blocking: false, ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}) },
    }
    state.spans.push(span)
    state.backgroundKeys.add(key)
    this.openBackgroundTasks.set(key, span)
  }

  private startBlockingSpan(
    state: TurnState,
    kind: SpanKind,
    name: string,
    startedAt: number,
    attrs: SpanAttributes,
    parentSpanId?: string,
  ): BufferedSpan {
    const start = Math.max(state.setupEndedAt ?? state.startedAt, startedAt)
    if (state.blockingOpen === 0) {
      this.closeModelWork(state, start, 'ok')
      state.blockingWaveEndAt = start
    }
    state.blockingOpen++
    const span: BufferedSpan = {
      spanId: randomUUID(),
      parentSpanId: parentSpanId ?? state.traceId,
      kind,
      name,
      startedAt: start,
      attrs,
    }
    state.spans.push(span)
    return span
  }

  private endBlockingSpan(state: TurnState, span: BufferedSpan, endedAt: number, status: SpanStatus): void {
    span.endedAt = Math.max(span.startedAt, endedAt)
    span.status = status
    state.blockingWaveEndAt = Math.max(state.blockingWaveEndAt, span.endedAt)
    state.blockingOpen = Math.max(0, state.blockingOpen - 1)
    if (state.blockingOpen === 0) this.startModelWork(state, state.blockingWaveEndAt)
  }

  private finalizeOpenBlockingSpan(state: TurnState, span: BufferedSpan, endedAt: number, status: SpanStatus): void {
    span.endedAt = Math.max(span.startedAt, endedAt)
    span.status = status
    state.blockingWaveEndAt = Math.max(state.blockingWaveEndAt, span.endedAt)
  }

  private finalizeOpenChildren(state: TurnState, status: SpanStatus, endedAt: number): void {
    for (const key of state.toolKeys) {
      const span = this.openTools.get(key)
      if (span) this.finalizeOpenBlockingSpan(state, span, endedAt, status)
      this.openTools.delete(key)
    }
    for (const key of state.permissionKeys) {
      const span = this.openPermissions.get(key)
      if (span) this.finalizeOpenBlockingSpan(state, span, endedAt, status)
      this.openPermissions.delete(key)
    }
    for (const key of state.backgroundKeys) {
      const span = this.openBackgroundTasks.get(key)
      if (span) Object.assign(span, { endedAt: Math.max(span.startedAt, endedAt), status })
      this.openBackgroundTasks.delete(key)
    }
    if (!state.rateLimitKey) return
    const span = this.openRateLimits.get(state.rateLimitKey)
    if (span) this.finalizeOpenBlockingSpan(state, span, endedAt, status)
    this.openRateLimits.delete(state.rateLimitKey)
  }

  private startModelWork(state: TurnState, startedAt: number): void {
    if (state.modelWork || state.blockingOpen > 0) return
    const span: BufferedSpan = {
      spanId: randomUUID(),
      parentSpanId: state.traceId,
      kind: SPAN_KINDS.modelWork,
      name: 'model_work',
      startedAt: Math.max(state.setupEndedAt ?? state.startedAt, startedAt),
      attrs: {
        hasThinking: state.thinkingDepth > 0 || state.thinkingWithoutModel,
      },
    }
    state.thinkingWithoutModel = false
    state.modelWork = span
    state.firstModelWork ??= span
    state.spans.push(span)
  }

  private closeModelWork(state: TurnState, endedAt: number, status: SpanStatus): void {
    const span = state.modelWork
    if (!span) return
    span.endedAt = Math.max(span.startedAt, endedAt)
    span.status = status
    state.modelWork = undefined
  }

  private recordFirstToken(state: TurnState, at: number): void {
    const first = state.firstModelWork
    if (!first || first.attrs.timeToFirstTokenMs !== undefined) return
    first.attrs.timeToFirstTokenMs = Math.max(0, at - state.startedAt)
  }

  private setToolInput(span: BufferedSpan, input: string): void {
    const value = capped(input, TOOL_INPUT_LIMIT)
    span.attrs.input = value.value
    if (value.truncated) span.attrs.inputTruncated = true
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
