import { hostname } from 'node:os'
import { basename } from 'node:path'
import { ROOT_CONTEXT, context, createContextKey, trace, type Context, type Span } from '@opentelemetry/api'
import type { NormalizedEvent, PromptSource, UsageData } from '@solus/contracts/types'
import { createLogger } from '../logger'
import { hostOperatingSystem } from '../platform/host-operating-system'
import { codexTokenCostUsd } from './model-pricing'
import {
  SPAN_KINDS,
  SPAN_SERVICES,
  type SpanAttributes,
  type SpanDimensions,
  type SpanKind,
  type SpanStatus,
} from './registries'
import {
  applyTaskCompleteAttrs,
  capped,
  cappedAttrs,
  copyUsage,
  setUsageAttrs,
  spanStatusForToolOutcome,
  terminalOutcome,
  usageDelta,
  type TurnOutcome,
} from './session-emitter-support'
import { endSolusSpan, startSolusSpan } from './tracer'
export type { TurnOutcome } from './session-emitter-support'

const PROMPT_LIMIT = 4 * 1024
const TOOL_INPUT_LIMIT = 8 * 1024
/** The composed system prompt is the turn's instructions — base rules, task
 *  context, handoff seed. It is the largest text a turn carries and the one a
 *  reader most often needs whole, so it gets the widest cap. */
const SYSTEM_PROMPT_LIMIT = 16 * 1024
/** The agent's own answer, as the provider reported it. */
const RESPONSE_LIMIT = 8 * 1024

// Execution-host facts do not change during one Solus process. Read them once,
// then snapshot them onto every turn so exported metrics remain attributable.
const EXECUTION_HOSTNAME = hostname()
const EXECUTION_HOST_OS = hostOperatingSystem()

const log = createLogger('SessionEmitter', 'session-emitter.ts')

/** The dispatch a step opened here belongs to. It rides OTel's own context
 *  beside the active span, so a function being measured needs no parameter for
 *  it — the span's parent comes from the context, and this says which turn the
 *  step belongs to and where it sits in the step path. */
class DispatchScope {
  /** False once this scope's step has ended. A callback registered during
   *  dispatch and invoked after it keeps the context it captured, and must not
   *  date a new step against a finished parent. */
  open = true

  constructor(
    readonly emitter: SessionEmitter,
    readonly sessionId: string,
    readonly traceId: string,
    /** Dot path from the outermost step, e.g. `launch_run.worktree_create`. The
     *  tree is implicit in `parent_span_id`; this is what makes the flat
     *  `internal_events` view groupable without reconstructing it. */
    readonly step: string,
  ) {}
}

const DISPATCH_SCOPE = createContextKey('solus.dispatch_scope')

function activeDispatchScope(): DispatchScope | undefined {
  const scope = context.active().getValue(DISPATCH_SCOPE)
  return scope instanceof DispatchScope ? scope : undefined
}

/**
 * Records one step of the work Solus does before a turn reaches the provider.
 *
 * Nests automatically: the step becomes a child of whatever step is running
 * where this is called, at any depth and across any module boundary. Outside a
 * dispatch it is a straight pass-through, so a function can call it
 * unconditionally — `createWorktree` is also called from places that have no
 * turn to attribute the time to.
 *
 * `annotate` records what the step turned out to be doing — the branch it
 * created, the task it bound — once the step knows.
 *
 * Every step passes `fn` and `file` in `attrs`: the function it times and the
 * file it is measured from. A step is a piece of Solus's own code, and a reader
 * looking at one in the waterfall is on their way to that code. They are
 * written by hand rather than taken from a stack frame because the main process
 * ships bundled — a captured frame would name the bundle, confidently and
 * wrongly. Line numbers are left out for the same reason they would be wrong
 * within a week.
 */
export function dispatchStep<T>(
  name: string,
  attrs: SpanAttributes,
  run: (annotate: (extra: SpanAttributes) => void) => Promise<T>,
): Promise<T> {
  const scope = activeDispatchScope()
  if (!scope?.open) return run(() => {})
  return scope.emitter.withStep(scope, name, attrs, run)
}

/** Records facts about the step already running here — for a caller that learns
 *  them well after the point it could have taken an `annotate` callback. */
export function annotateDispatch(attrs: SpanAttributes): void {
  const scope = activeDispatchScope()
  // The outermost scope's span is `setup` itself, which is the turn's, not a
  // step's: there is nothing of the caller's to annotate there.
  if (!scope?.open || !scope.step) return
  trace.getSpan(context.active())?.setAttributes(cappedAttrs(attrs))
}

/** The synchronous form. Timing something synchronous with `dispatchStep`
 *  would suspend it into a later microtask, and a caller whose ordering
 *  depends on the call completing in this tick would quietly change behaviour
 *  by being measured. */
export function dispatchStepSync<T>(name: string, attrs: SpanAttributes, run: () => T): T {
  const scope = activeDispatchScope()
  if (!scope?.open) return run()
  return scope.emitter.withStepSync(scope, name, attrs, run)
}

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

/** A span Solus is still deciding the end of: a streaming interval whose end
 *  moves with every chunk, a tool whose result arrives after its call, a step
 *  a crash may leave open. The span itself is the record; this is the policy
 *  around it. */
interface OpenSpan {
  span: Span
  /** Epoch milliseconds, as clamped when the span was started. */
  startedAt: number
  /** The latest end observed so far, for a span whose end keeps moving. */
  endedAt?: number
}

interface TurnState {
  sessionId: string
  traceId: string
  startedAt: number
  root: Span
  /** What a span of this turn hangs off. */
  rootContext: Context
  setup: OpenSpan
  /** What a dispatch step hangs off: setup is the turn's pre-provider window,
   *  and a step is its interior. */
  setupContext: Context
  setupEndedAt?: number
  dimensions?: TurnDimensions
  /** The dimensions every span of this turn is stamped with as it ends —
   *  refined as the turn learns them, so a span records what was known when it
   *  finished. */
  spanDimensions: SpanDimensions
  observedModel?: string
  rootAttrs: SpanAttributes
  openSpans: Map<string, OpenSpan>
  toolSpans: Map<string, OpenSpan>
  toolKeyByIndex: Map<number, string>
  permissionOptions: Map<string, Set<string>>
  rateLimitKey?: string
  terminalStatus?: SpanStatus
  terminalAt?: number
  latestCodexUsage?: UsageData
  codexUsageBaseline?: UsageData
  taskComplete?: Extract<NormalizedEvent, { type: 'task_complete' }>
  /** The last top-level assistant message observed. A turn the user stopped, or
   *  one that failed, never reaches `task_complete`, and its answer so far is
   *  still what the reader is looking at in the transcript. */
  lastAssistantText?: string
  /** Top-level streamed text, retained only up to the response attribute cap.
   *  Codex reports an empty task-complete result in regular mode, so its
   *  visible answer must be reconstructed from these deltas. */
  streamedAssistantText?: string
  streamedAssistantChars?: number
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
    /** The backend and project the run was dispatched to. Known before the
     *  provider answers, so the dispatch's own steps record them; the executed
     *  model is not, and arrives with `completeSetup`. */
    provider?: string
    projectRoot?: string
  }): string {
    let traceId = ''
    this.safe(input.sessionId, () => {
      const existing = this.turns.get(input.sessionId)
      if (existing) this.settlingTurns.set(existing.traceId, existing)
      const prompt = capped(input.prompt, PROMPT_LIMIT)
      const previousSettledAt = this.lastSettledAt.get(input.sessionId)
      const dispatchedAt = input.dispatchedAt ?? input.startedAt
      const rootAttrs: SpanAttributes = {
        prompt: prompt.value,
        promptChars: input.prompt.length,
        promptSource: input.promptSource,
      }
      if (EXECUTION_HOSTNAME) rootAttrs.hostname = EXECUTION_HOSTNAME
      if (EXECUTION_HOST_OS) rootAttrs.hostOs = EXECUTION_HOST_OS
      if (prompt.truncated) rootAttrs.promptTruncated = true
      if (existing) rootAttrs.interTurnIdleMs = 0
      else if (previousSettledAt !== undefined) {
        rootAttrs.interTurnIdleMs = Math.max(0, dispatchedAt - previousSettledAt)
      }
      const spanDimensions: SpanDimensions = {
        sessionId: input.sessionId,
        origin: input.promptSource,
        provider: input.provider,
        projectRoot: input.projectRoot,
      }
      // A turn is a trace of its own: it is started from an empty context so a
      // dispatch made from inside somebody else's span — an agent tool, an
      // automation run — does not adopt it as a parent.
      const root = startSolusSpan({
        kind: SPAN_KINDS.turn,
        name: 'turn',
        service: SPAN_SERVICES.sessions,
        startedAt: input.startedAt,
        parent: ROOT_CONTEXT,
      })
      traceId = root.spanContext().traceId
      const rootContext = trace.setSpan(ROOT_CONTEXT, root)
      // Opened with the turn so dispatch steps have a parent while it runs;
      // closed by `completeSetup`, or by the turn if dispatch never got there.
      const setup: OpenSpan = {
        span: startSolusSpan({
          kind: SPAN_KINDS.setup,
          name: 'setup',
          service: SPAN_SERVICES.sessions,
          startedAt: input.startedAt,
          parent: rootContext,
        }),
        startedAt: input.startedAt,
      }
      this.turns.set(input.sessionId, {
        sessionId: input.sessionId,
        traceId,
        startedAt: input.startedAt,
        root,
        rootContext,
        setup,
        setupContext: trace.setSpan(rootContext, setup.span),
        spanDimensions,
        rootAttrs,
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
      state.spanDimensions = {
        sessionId: state.sessionId,
        provider: state.dimensions.provider,
        model: state.dimensions.model,
        projectRoot: state.dimensions.projectRoot,
        origin: state.dimensions.origin,
      }
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
      this.endChild(state, state.setup, state.setupEndedAt, 'ok')
    })
  }

  /** The instructions the turn actually ran under, composed at dispatch.
   *  Recorded per turn rather than per session because it is rebuilt on every
   *  dispatch: the task context inside it moves as the task does. */
  recordSystemPrompt(sessionId: string, systemPrompt: string): void {
    this.safe(sessionId, () => {
      const state = this.turns.get(sessionId)
      if (!state || !systemPrompt) return
      const text = capped(systemPrompt, SYSTEM_PROMPT_LIMIT)
      state.rootAttrs.systemPrompt = text.value
      state.rootAttrs.systemPromptChars = systemPrompt.length
      if (text.truncated) state.rootAttrs.systemPromptTruncated = true
    })
  }

  // ─── Dispatch steps ───
  //
  // The work Solus does before a turn reaches the provider: resolving git
  // context, building a worktree, preparing the task, composing instructions,
  // launching the agent. It is the setup span's interior, and on a cold
  // dispatch it is the largest thing in the turn that nothing could explain.
  //
  // `runDispatch` opens the scope; every step inside it — at any depth, in any
  // module — is recorded by the free `dispatchStep` above, which finds its
  // parent in the ambient context rather than in an argument. That is what
  // keeps telemetry out of the signatures of the functions being measured:
  // `createWorktree` times four git commands of its own without taking a
  // parameter for it, or knowing that a turn exists.

  /** Opens the dispatch scope for one turn and runs `run` inside it. The step
   *  it opens is a child of the turn's setup span. */
  runDispatch<T>(
    sessionId: string,
    name: string,
    attrs: SpanAttributes,
    run: (annotate: (extra: SpanAttributes) => void) => Promise<T>,
  ): Promise<T> {
    const state = this.turns.get(sessionId)
    if (!state) return run(() => {})
    const scope = new DispatchScope(this, sessionId, state.traceId, '')
    return context.with(
      state.setupContext.setValue(DISPATCH_SCOPE, scope),
      () => this.withStep(scope, name, attrs, run),
    )
  }

  /** @internal — reached through `dispatchStep`, never called directly. */
  withStep<T>(
    scope: DispatchScope,
    name: string,
    attrs: SpanAttributes,
    run: (annotate: (extra: SpanAttributes) => void) => T | Promise<T>,
  ): Promise<T> {
    const step = this.openStep(scope, name, attrs)
    if (!step) return Promise.resolve(run(() => {})) as Promise<T>
    const annotate = (extra: SpanAttributes): void => {
      if (step.scope.open) step.open.span.setAttributes(cappedAttrs(extra))
    }
    // A step that throws is still recorded — the failure is the measurement a
    // reader most needs — and the error is rethrown untouched, so control flow
    // is never changed by being observed.
    return context.with(step.context, async () => {
      try {
        const result = await run(annotate)
        this.closeStep(step.scope, step.open, 'ok')
        return result
      } catch (error) {
        annotate({ error: error instanceof Error ? error.message : String(error) })
        this.closeStep(
          step.scope,
          step.open,
          error instanceof Error && error.message === 'Interrupted' ? 'interrupted' : 'error',
        )
        throw error
      }
    })
  }

  /** @internal — the synchronous form, for a call that must not be moved into a
   *  later microtask by being timed. */
  withStepSync<T>(scope: DispatchScope, name: string, attrs: SpanAttributes, run: () => T): T {
    const step = this.openStep(scope, name, attrs)
    if (!step) return run()
    return context.with(step.context, () => {
      try {
        const result = run()
        this.closeStep(step.scope, step.open, 'ok')
        return result
      } catch (error) {
        step.open.span.setAttributes(cappedAttrs({
          error: error instanceof Error ? error.message : String(error),
        }))
        this.closeStep(step.scope, step.open, 'error')
        throw error
      }
    })
  }

  private openStep(
    scope: DispatchScope,
    name: string,
    attrs: SpanAttributes,
  ): { open: OpenSpan; scope: DispatchScope; context: Context } | null {
    const state = this.turns.get(scope.sessionId)
    // A scope whose turn has moved on means the context outlived it — a
    // callback registered during dispatch and invoked after it. Attaching to a
    // finished turn would date the step wrongly, so it goes untraced.
    if (!state || state.traceId !== scope.traceId) return null
    const step = scope.step ? `${scope.step}.${name}` : name
    const startedAt = Date.now()
    const open: OpenSpan = {
      span: startSolusSpan({
        kind: SPAN_KINDS.internalDispatchStep,
        name,
        service: SPAN_SERVICES.sessions,
        startedAt,
        attrs: { step, ...cappedAttrs(attrs) },
      }),
      startedAt,
    }
    state.openSpans.set(this.dispatchKey(open.span), open)
    const child = new DispatchScope(this, scope.sessionId, scope.traceId, step)
    return {
      open,
      scope: child,
      context: trace.setSpan(context.active(), open.span).setValue(DISPATCH_SCOPE, child),
    }
  }

  private closeStep(scope: DispatchScope, open: OpenSpan, status: SpanStatus): void {
    scope.open = false
    this.safe(scope.sessionId, () => {
      const state = this.turns.get(scope.sessionId)
      // Already gone means the turn settled first and closed it there.
      if (!state || !state.openSpans.delete(this.dispatchKey(open.span))) return
      this.endChild(state, open, Date.now(), status)
    })
  }

  private dispatchKey(span: Span): string {
    return `dispatch:${span.spanContext().spanId}`
  }

  recordQueueWait(sessionId: string, enqueuedAt: number, runStartedAt: number): void {
    this.safe(sessionId, () => {
      const state = this.turns.get(sessionId)
      if (!state) return
      // The wait precedes the turn, so it is the one child not clamped into it.
      const wait = this.startChild(
        state,
        SPAN_KINDS.queueWait,
        'queue_wait',
        Math.min(enqueuedAt, runStartedAt),
        {},
      )
      this.endChild(state, wait, runStartedAt, 'ok')
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
        this.observeModel(state, event.model)
        return
      }
      if (event.type === 'model_rerouted') {
        this.observeModel(state, event.toModel)
        return
      }
      if (event.type === 'text_chunk') {
        if (!event.parentToolUseId) {
          const timeToFirstTextMs = Math.max(0, arrivedAt - state.startedAt)
          state.rootAttrs.timeToFirstTextMs ??= timeToFirstTextMs
          state.streamedAssistantChars = (state.streamedAssistantChars ?? 0) + event.text.length
          const retained = state.streamedAssistantText ?? ''
          if (retained.length < RESPONSE_LIMIT) {
            state.streamedAssistantText = retained + event.text.slice(0, RESPONSE_LIMIT - retained.length)
          }
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
        const open = state.toolSpans.get(this.toolKey(event.toolId))
        if (open && event.toolInput) this.setToolInput(open, event.toolInput)
        return
      }
      if (event.type === 'tool_call_complete') {
        const key = event.toolId ? this.toolKey(event.toolId) : state.toolKeyByIndex.get(event.index)
        if (!key) return
        const open = state.openSpans.get(key)
        if (!open) return
        if (event.toolInput) this.setToolInput(open, event.toolInput)
        const outcome = event.outcome
        if (outcome) {
          const attrs: SpanAttributes = {}
          if (outcome.status) attrs.outcomeStatus = outcome.status
          if (typeof outcome.exitCode === 'number') attrs.exitCode = outcome.exitCode
          if (outcome.error) attrs.error = capped(outcome.error, TOOL_INPUT_LIMIT).value
          if (outcome.declined !== undefined) attrs.declined = outcome.declined
          if (outcome.durationMs !== undefined) attrs.providerDurationMs = outcome.durationMs
          open.span.setAttributes(attrs)
        }
        // Codex item/completed is the execution boundary and carries an outcome
        // or provider timestamp. Claude content_block_stop only means that the
        // tool input finished streaming; its later tool_result closes the actual
        // execution interval.
        if (event.completedAtMs !== undefined || outcome !== undefined) {
          state.openSpans.delete(key)
          this.endChild(state, open, event.completedAtMs ?? arrivedAt, spanStatusForToolOutcome(outcome))
        }
        return
      }
      if (event.type === 'tool_result') {
        const key = this.toolKey(event.toolUseId)
        const open = state.openSpans.get(key)
        if (!open) return
        state.openSpans.delete(key)
        this.endChild(state, open, arrivedAt, event.isError ? 'error' : 'ok', {
          outcomeStatus: event.isError ? 'error' : 'completed',
        })
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
        const open = state.openSpans.get(key)
        if (!open) return
        const status = event.status === 'completed'
          ? 'ok'
          : event.status === 'stopped' || event.status === 'killed'
            ? 'interrupted'
            : 'error'
        state.openSpans.delete(key)
        this.endChild(state, open, arrivedAt, status, { outcomeStatus: event.status })
        return
      }
      if (event.type === 'assistant_message') {
        if (!event.parentToolUseId && event.text) state.lastAssistantText = event.text
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
      const open = state.openSpans.get(state.rateLimitKey)
      state.openSpans.delete(state.rateLimitKey)
      state.rateLimitKey = undefined
      if (open) this.endChild(state, open, endedAt, 'ok')
    })
  }

  resolvePermission(sessionId: string, questionId: string, optionId: string, endedAt = Date.now()): void {
    this.safe(sessionId, () => {
      const state = this.turns.get(sessionId)
      if (!state) return
      const key = this.permissionKey(questionId)
      const open = state.openSpans.get(key)
      if (!open) return
      const granted = state.permissionOptions.get(key)?.has(optionId) === true
      if (!granted) {
        state.rootAttrs.permissionDenialCount = Number(state.rootAttrs.permissionDenialCount ?? 0) + 1
      }
      state.openSpans.delete(key)
      state.permissionOptions.delete(key)
      this.endChild(state, open, endedAt, granted ? 'ok' : 'error', {
        decision: granted ? 'granted' : 'denied',
      })
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
      this.endChild(state, state.setup, endedAt, status)
    }

    // A span still open at settlement ends where it was last observed — the
    // last chunk of a stream — or with the turn.
    for (const [key, open] of state.openSpans) {
      state.openSpans.delete(key)
      this.endChild(state, open, open.endedAt ?? endedAt, status)
    }

    // The provider's own final result is the answer when the turn reached one;
    // otherwise the last message it streamed is what the user is looking at.
    const response = state.taskComplete?.result || state.lastAssistantText || state.streamedAssistantText
    if (response) {
      const text = capped(response, RESPONSE_LIMIT)
      state.rootAttrs.response = text.value
      const responseChars = state.taskComplete?.result || state.lastAssistantText
        ? response.length
        : state.streamedAssistantChars ?? response.length
      state.rootAttrs.responseChars = responseChars
      if (text.truncated || responseChars > text.value.length) state.rootAttrs.responseTruncated = true
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
      const settlement = this.startChild(
        state,
        SPAN_KINDS.turnSettlement,
        'Solus settlement',
        Math.min(state.providerCompletedAt, endedAt),
        {},
      )
      this.endChild(state, settlement, endedAt, status)
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

    // The root ends last: every child of the turn is already recorded, and a
    // trace whose root is still open is a turn that has not settled.
    endSolusSpan(state.root, {
      endedAt: Math.max(state.startedAt, endedAt),
      status,
      attrs: state.rootAttrs,
      dimensions: state.spanDimensions,
    })

    if (this.turns.get(state.sessionId) === state) this.turns.delete(state.sessionId)
    this.settlingTurns.delete(state.traceId)
    this.lastSettledAt.set(state.sessionId, endedAt)
  }

  private observeModel(state: TurnState, model: string): void {
    state.observedModel = model
    state.spanDimensions.model = model
    if (state.dimensions) state.dimensions.model = model
  }

  private startTool(state: TurnState, event: Extract<NormalizedEvent, { type: 'tool_call' }>, startedAt: number): void {
    const key = this.toolKey(event.toolId)
    if (state.toolSpans.has(key)) return
    const parent = event.parentToolUseId ? state.toolSpans.get(this.toolKey(event.parentToolUseId)) : undefined
    const open = this.newChild(
      state,
      SPAN_KINDS.toolCall,
      event.toolName,
      startedAt,
      {
        ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
        isSubagent: event.isSubagent === true,
      },
      parent && trace.setSpan(state.rootContext, parent.span),
    )
    if (event.toolInput) this.setToolInput(open, event.toolInput)
    state.toolKeyByIndex.set(event.index, key)
    state.toolSpans.set(key, open)
    state.openSpans.set(key, open)
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
      this.activityContext(state, parentToolUseId),
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
    const open = state.openSpans.get(key)
    if (!open) return
    state.openSpans.delete(key)
    this.endChild(state, open, endedAt, status)
  }

  private observeResponseChunk(
    state: TurnState,
    parentToolUseId: string | undefined,
    arrivedAt: number,
  ): void {
    this.finishThinking(state, parentToolUseId, arrivedAt, 'ok')
    const key = this.responseStreamKey(parentToolUseId)
    let open = state.openSpans.get(key)
    if (!open) {
      open = this.newChild(
        state,
        SPAN_KINDS.responseStream,
        'response_stream',
        arrivedAt,
        {},
        this.activityContext(state, parentToolUseId),
      )
      state.openSpans.set(key, open)
    }
    open.endedAt = Math.max(open.startedAt, arrivedAt)
  }

  private finishResponseStream(
    state: TurnState,
    parentToolUseId: string | undefined,
    status: SpanStatus,
  ): void {
    const key = this.responseStreamKey(parentToolUseId)
    const open = state.openSpans.get(key)
    if (!open) return
    state.openSpans.delete(key)
    this.endChild(state, open, open.endedAt ?? open.startedAt, status)
  }

  private activityContext(state: TurnState, parentToolUseId: string | undefined): Context {
    if (!parentToolUseId) return state.rootContext
    const parent = state.toolSpans.get(this.toolKey(parentToolUseId))
    return parent ? trace.setSpan(state.rootContext, parent.span) : state.rootContext
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
      parent && trace.setSpan(state.rootContext, parent.span),
    ))
  }

  /** A child of the turn, starting no earlier than the provider could have been
   *  reached: a provider timestamp taken before setup finished would draw the
   *  work as having overlapped the dispatch that had not launched it yet. */
  private newChild(
    state: TurnState,
    kind: SpanKind,
    name: string,
    startedAt: number,
    attrs: SpanAttributes,
    parent?: Context,
  ): OpenSpan {
    const clamped = Math.max(state.setupEndedAt ?? state.startedAt, startedAt)
    return this.startChild(state, kind, name, clamped, attrs, parent)
  }

  private startChild(
    state: TurnState,
    kind: SpanKind,
    name: string,
    startedAt: number,
    attrs: SpanAttributes,
    parent: Context = state.rootContext,
  ): OpenSpan {
    return {
      span: startSolusSpan({
        kind,
        name,
        service: SPAN_SERVICES.sessions,
        startedAt,
        attrs,
        parent,
      }),
      startedAt,
    }
  }

  /** Ends a span with the turn's dimensions as they stand — the executed model
   *  a provider reported, the project the run resolved. */
  private endChild(
    state: TurnState,
    open: OpenSpan,
    endedAt: number,
    status: SpanStatus,
    attrs?: SpanAttributes,
  ): void {
    endSolusSpan(open.span, {
      endedAt: Math.max(open.startedAt, endedAt),
      status,
      attrs,
      dimensions: state.spanDimensions,
    })
  }

  private setToolInput(open: OpenSpan, input: string): void {
    const value = capped(input, TOOL_INPUT_LIMIT)
    open.span.setAttribute('input', value.value)
    if (value.truncated) open.span.setAttribute('inputTruncated', true)
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
