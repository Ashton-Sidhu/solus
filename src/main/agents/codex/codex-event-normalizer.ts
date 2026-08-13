import { z } from 'zod'
import type { ContextUsage, NormalizedEvent, ThreadGoal, UsageData } from '../../../shared/types'
import { findResetTimestamp } from '../../rate-limits'
import {
  codexImageArtifactPath,
  codexSpawnedThreadLinks,
  codexSubagentActivityInput,
  codexToolNameForItem,
  isInterruptedTurnStatus,
  planFromCompletedItem,
  planTextFromPlanUpdated,
} from './codex-utils'
import type { TurnNormalizer, TurnSummary } from '../turn-normalizer'
import type {
  JsonRpcId,
} from './codex-protocol'

const CODEX_RATE_LIMIT_WARNING_PERCENT = 80
const CODEX_RATE_LIMIT_SEND_BUFFER_SECONDS = 2 * 60

const stringValueSchema = z.string()
const finiteNumberSchema = z.number().finite()
const threadGoalSchema = z.object({
  threadId: z.string(),
  objective: z.string(),
  status: z.string().optional(),
  tokenBudget: finiteNumberSchema.optional().catch(undefined),
  tokensUsed: finiteNumberSchema.optional().catch(undefined),
  timeUsedSeconds: finiteNumberSchema.optional().catch(undefined),
  createdAt: finiteNumberSchema.optional().catch(undefined),
  updatedAt: finiteNumberSchema.optional().catch(undefined),
})
const planItemSchema = z.object({
  step: z.string().optional(),
  text: z.string().optional(),
  description: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
})
const tokenBreakdownSchema = z.object({
  totalTokens: finiteNumberSchema.optional(),
  total_tokens: finiteNumberSchema.optional(),
  inputTokens: finiteNumberSchema.optional(),
  input_tokens: finiteNumberSchema.optional(),
  cachedInputTokens: finiteNumberSchema.optional(),
  cached_input_tokens: finiteNumberSchema.optional(),
  outputTokens: finiteNumberSchema.optional(),
  output_tokens: finiteNumberSchema.optional(),
  reasoningOutputTokens: finiteNumberSchema.optional(),
  reasoning_output_tokens: finiteNumberSchema.optional(),
})
const rateLimitWindowSchema = z.object({
  usedPercent: finiteNumberSchema.optional(),
  resetsAt: z.union([z.string(), finiteNumberSchema]).optional(),
  windowDurationMins: finiteNumberSchema.optional(),
})
const rateLimitsSchema = z.object({
  rateLimitReachedType: z.string().optional(),
  primary: rateLimitWindowSchema.optional(),
  secondary: rateLimitWindowSchema.optional(),
  credits: z.object({ hasCredits: z.boolean().optional() }).optional(),
})
const contentPartSchema = z.union([
  z.string(),
  z.object({ text: z.string().optional() }),
])
const collabArgumentsSchema = z.object({
  settings: z.object({
    model: z.string().optional(),
    reasoning_effort: z.string().optional(),
    reasoningEffort: z.string().optional(),
  }).optional(),
  prompt: z.string().optional(),
  task: z.string().optional(),
  instructions: z.string().optional(),
  description: z.string().optional(),
  title: z.string().optional(),
  model: z.string().optional(),
  model_id: z.string().optional(),
  reasoning_effort: z.string().optional(),
  reasoningEffort: z.string().optional(),
})
const httpFailureSchema = z.object({ httpStatusCode: finiteNumberSchema.nullable() })
const codexErrorInfoSchema = z.union([
  z.enum([
    'contextWindowExceeded',
    'sessionBudgetExceeded',
    'usageLimitExceeded',
    'serverOverloaded',
    'cyberPolicy',
    'internalServerError',
    'unauthorized',
    'badRequest',
    'threadRollbackFailed',
    'sandboxError',
    'other',
  ]),
  z.object({ httpStatusCode: finiteNumberSchema.nullable() }),
  z.object({ httpConnectionFailed: httpFailureSchema }),
  z.object({ responseStreamConnectionFailed: httpFailureSchema }),
  z.object({ responseStreamDisconnected: httpFailureSchema }),
  z.object({ responseTooManyFailedAttempts: httpFailureSchema }),
  z.object({ activeTurnNotSteerable: z.object({ turnKind: z.string() }) }),
])
const codexErrorPayloadSchema = z.object({
  message: z.string().optional(),
  code: z.string().optional(),
  codexErrorInfo: codexErrorInfoSchema.nullable().optional(),
  additionalDetails: z.string().nullable().optional(),
})

function parsedString<Value>(value: Value): string | undefined {
  const parsed = stringValueSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function parsedFiniteNumber<Value>(value: Value): number | undefined {
  const parsed = finiteNumberSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export interface CodexPendingServerRequest {
  id: JsonRpcId
  method: string
  params: any
  sessionId: string | null
  /** For execute-after-approve entries (e.g. update_work via dynamicTools):
   *  called with the approval decision so the handler runs the tool and
   *  responds itself, instead of the responder emitting a protocol decision. */
  execute?: (approved: boolean) => void | Promise<void>
}

function normalizeCodexNotification(method: string, params: any, opts?: { planMode?: boolean; assembledAgentMessages?: boolean }): NormalizedEvent[] {
  const usageEvent = normalizeCodexTokenCount(method, params)
  if (usageEvent) return [usageEvent]

  switch (method) {
    case 'account/rateLimits/updated':
      return normalizeCodexRateLimitsUpdated(params)

    case 'thread/started': {
      const thread = params?.thread || {}
      if (!thread.id) return []
      return [{
        type: 'session_init',
        sessionId: thread.id,
        model: thread.model || 'codex',
        skills: [],
      }]
    }

    case 'thread/goal/updated': {
      const goal = normalizeThreadGoal(params?.goal)
      return goal ? [{ type: 'goal_updated', goal }] : []
    }

    case 'thread/goal/cleared': {
      const threadId = parsedString(params?.threadId) ?? null
      return threadId ? [{ type: 'goal_cleared', threadId }] : []
    }

    case 'item/agentMessage/delta': {
      const delta = parsedString(params?.delta)
      if (!delta) return []
      const parentToolUseId = codexParentToolUseId(params)
      const event: Extract<NormalizedEvent, { type: 'text_chunk' }> = {
        type: 'text_chunk',
        text: delta,
      }
      if (parentToolUseId) event.parentToolUseId = parentToolUseId
      return [event]
    }

    case 'item/started':
      return normalizeItemStarted(params)

    case 'item/fileChange/patchUpdated':
    case 'item/mcpToolCall/progress':
      return normalizeToolUpdate(params)

    case 'item/completed':
      return normalizeItemCompleted(params, opts)

    case 'turn/plan/updated': {
      if (opts?.planMode) return []

      const parsedPlan = z.array(planItemSchema).safeParse(params?.plan)
      const planItems = parsedPlan.success ? parsedPlan.data : []
      const todos = planItems
        .map((planItem) => ({
          content: (planItem.step || planItem.text || planItem.description || planItem.title || '').trim(),
          status: normalizePlanItemStatus(planItem.status),
        }))
        .filter((p: { content: string }) => p.content)
      // A sub-agent's plan belongs to its own card. Untagged it would overwrite
      // the main agent's tracker, since the reducer routes on this id alone.
      return todos.length > 0
        ? [{ type: 'progress', todos, parentToolUseId: codexParentToolUseId(params) }]
        : []
    }

    case 'turn/completed':
      return normalizeTurnCompleted(params)

    default:
      return []
  }
}

export class CodexTurnNormalizer implements TurnNormalizer<{ method: string; params: any }> {
  private interrupted = false
  private streamedPlanText = ''
  private completedPlan: { id: string; text: string } | null = null
  private streamedPlanId: string | null = null
  private turnId: string | null = null
  private readonly subagentParentByThreadId = new Map<string, string>()
  private readonly seenSubagentActivity = new Set<string>()
  private readonly planMode: boolean
  private readonly assembledAgentMessages: boolean
  private readonly turnSummary: TurnSummary = {
    toolCallCount: 0,
    sawRateLimit: false,
    sawProtocolError: false,
    permissionDenials: [],
  }

  constructor(opts: { planMode: boolean; assembledAgentMessages?: boolean }) {
    this.planMode = opts.planMode
    this.assembledAgentMessages = opts.assembledAgentMessages ?? false
  }

  get summary(): TurnSummary {
    return this.turnSummary
  }

  push(raw: { method: string; params: any }): NormalizedEvent[] {
    const { method } = raw
    const params = this.withSubagentParent(raw.params)
    this.captureTurnId(params)
    if (isInterruptedTurnStatus(params?.turn?.status) && !codexParentToolUseId(params)) {
      this.interrupted = true
    }
    if (this.interrupted) return []
    if (this.isDuplicateSubagentActivity(method, params)) return []

    const events: NormalizedEvent[] = []
    if (this.planMode) {
      if (method === 'turn/plan/updated') {
        const planText = planTextFromPlanUpdated(params)
        if (planText) {
          const planId = this.planId(params)
          this.streamedPlanId = planId
          events.push({
            type: 'plan',
            planContent: planText,
            planFilePath: '',
            questionId: planId,
            options: [],
            planToolUseId: planId,
          })
        }
        return this.emit(events)
      }

      if (method === 'item/agentMessage/delta') {
        this.streamedPlanText += parsedString(params?.delta) ?? ''
      }

      if (method === 'item/completed') {
        const completedPlan = planFromCompletedItem(params)
        if (completedPlan) {
          this.completedPlan = completedPlan
          return []
        }
      }

      if (method === 'turn/completed') {
        const planText = this.completedPlan?.text.trim() || this.streamedPlanText.trim()
        if (planText) {
          const planId = this.completedPlan?.id || this.streamedPlanId || this.planId(params)
          events.push({
            type: 'plan',
            planContent: planText,
            planFilePath: '',
            questionId: this.planId(params),
            options: [],
            planToolUseId: planId,
          })
        }
      }
    }

    events.push(...normalizeCodexNotification(method, params, {
      planMode: this.planMode,
      assembledAgentMessages: this.assembledAgentMessages,
    }))
    return this.emit(events)
  }

  private withSubagentParent(params: any): any {
    for (const link of codexSpawnedThreadLinks(params?.item)) {
      this.subagentParentByThreadId.set(link.threadId, link.toolId)
    }

    if (codexParentToolUseId(params)) return params
    const parentToolUseId = this.subagentParentByThreadId.get(params?.threadId)
    return parentToolUseId ? { ...params, parentToolUseId } : params
  }

  private isDuplicateSubagentActivity(method: string, params: any): boolean {
    const item = params?.item
    if (
      (method !== 'item/started' && method !== 'item/completed') ||
      item?.type !== 'subAgentActivity' ||
      !parsedString(item.id)
    ) {
      return false
    }
    const key = `${item.id}:${String(item.kind ?? '')}`
    if (this.seenSubagentActivity.has(key)) return true
    this.seenSubagentActivity.add(key)
    return false
  }

  interrupt(): void {
    this.interrupted = true
  }

  private emit(events: NormalizedEvent[]): NormalizedEvent[] {
    for (const event of events) {
      if (event.type === 'tool_call') this.turnSummary.toolCallCount++
      if (event.type === 'rate_limit' && event.status !== 'allowed' && event.status !== 'allowed_warning') {
        this.turnSummary.sawRateLimit = true
      }
      if (event.type === 'error') this.turnSummary.sawProtocolError = true
    }
    return events
  }

  private captureTurnId(params: any): void {
    const turnId = parsedString(params?.turnId) ?? parsedString(params?.turn?.id) ?? null
    if (turnId) this.turnId = turnId
  }

  private planId(params: any): string {
    return `codex-plan-${this.turnId || params?.turnId || params?.turn?.id || Date.now()}`
  }
}

export function normalizeThreadGoal<Value>(value: Value): ThreadGoal | null {
  const parsed = threadGoalSchema.safeParse(value)
  if (!parsed.success) return null
  const goal = parsed.data
  const status = goal.status ?? 'active'
  if (!isThreadGoalStatus(status)) return null
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  }
}

function isThreadGoalStatus(value: string): value is ThreadGoal['status'] {
  return value === 'active' ||
    value === 'paused' ||
    value === 'complete' ||
    value === 'blocked' ||
    value === 'budgetLimited' ||
    value === 'usageLimited'
}

function normalizeCodexTokenCount(method: string, params: any): UsageEvent | null {
  if (method === 'thread/tokenUsage/updated') {
    const tokenUsage = params?.tokenUsage
    // `last` is the prompt of the turn that just ran — the window as it stands.
    // `total` sums every turn in the thread, so it passes the window many times
    // over and only means anything as cumulative spend.
    const context = codexContextUsage(tokenUsage?.last, finiteTokenCount(tokenUsage?.modelContextWindow) || undefined)
    const run = codexRunUsage(tokenUsage?.total)
    if (!context && !run) return null
    const event: UsageEvent = { type: 'usage' }
    if (context) event.context = context
    if (run) event.run = run
    return event
  }

  const payload = [
    params,
    params?.payload,
    params?.event,
    params?.msg,
    params?.message,
  ].find((candidate) => candidate?.type === 'token_count') ?? (method === 'token_count' ? params : null)
  const info = payload?.info
  if (!info) return null

  const context = codexContextUsage(info.last_token_usage || info.usage)
  const run = codexRunUsage(info.total_token_usage || info.usage)
  if (!context && !run) return null
  const event: UsageEvent = { type: 'usage' }
  if (context) event.context = context
  if (run) event.run = run
  return event
}

type UsageEvent = Extract<NormalizedEvent, { type: 'usage' }>

interface CodexTokenBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
}

interface CodexSubagentToolInput {
  subagent_type: string
  description?: string
  prompt?: string
  model?: string
  reasoning_effort?: string
}

/** Reads a Codex token breakdown in either the v2 camelCase or the older
 *  snake_case spelling — the two protocol versions report the same numbers. */
function codexTokenBreakdown<Raw>(raw: Raw): CodexTokenBreakdown | null {
  const parsed = tokenBreakdownSchema.safeParse(raw)
  if (!parsed.success) return null
  const tokenUsage = parsed.data
  const inputTokens = finiteTokenCount(tokenUsage.inputTokens ?? tokenUsage.input_tokens)
  const cachedInputTokens = finiteTokenCount(tokenUsage.cachedInputTokens ?? tokenUsage.cached_input_tokens)
  const outputTokens = finiteTokenCount(tokenUsage.outputTokens ?? tokenUsage.output_tokens)
  if (!inputTokens && !cachedInputTokens && !outputTokens) return null
  return {
    totalTokens: finiteTokenCount(tokenUsage.totalTokens ?? tokenUsage.total_tokens) || inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens: finiteTokenCount(tokenUsage.reasoningOutputTokens ?? tokenUsage.reasoning_output_tokens),
  }
}

function codexContextUsage<Raw>(raw: Raw, windowTokens?: number): ContextUsage | null {
  const breakdown = codexTokenBreakdown(raw)
  if (!breakdown) return null
  // Codex/OpenAI counts cached input inside inputTokens. Split it out so the
  // meter's composition rows sum to the total instead of counting cache twice.
  const inputTokens = Math.max(0, breakdown.inputTokens - breakdown.cachedInputTokens)
  return {
    // Codex's own context indicator uses `last.totalTokens`: after a response,
    // the assistant output is retained in history too. Counting input alone
    // makes the meter lag increasingly far behind on output-heavy turns.
    usedTokens: breakdown.totalTokens,
    windowTokens,
    inputTokens,
    cacheReadTokens: breakdown.cachedInputTokens,
    outputTokens: breakdown.outputTokens,
  }
}

function codexRunUsage<Raw>(raw: Raw): UsageData | null {
  const breakdown = codexTokenBreakdown(raw)
  if (!breakdown) return null
  return {
    inputTokens: Math.max(0, breakdown.inputTokens - breakdown.cachedInputTokens),
    outputTokens: breakdown.outputTokens,
    cacheReadTokens: breakdown.cachedInputTokens,
    reasoningTokens: breakdown.reasoningTokens || undefined,
  }
}

function finiteTokenCount<Value>(value: Value): number {
  const parsed = parsedFiniteNumber(value)
  return parsed && parsed > 0
    ? Math.round(parsed)
    : 0
}

function normalizeCodexRateLimitsUpdated(params: any): NormalizedEvent[] {
  const parsed = rateLimitsSchema.safeParse(params?.rateLimits)
  if (!parsed.success) return []
  const rateLimits = parsed.data

  const reachedType = rateLimits.rateLimitReachedType?.toLowerCase() ?? null

  const events: NormalizedEvent[] = []
  for (const [key, window] of [
    ['primary', rateLimits.primary],
    ['secondary', rateLimits.secondary],
  ] as const) {
    if (!window) continue

    const usedPercent = window.usedPercent ?? null
    const resetsAt = findResetTimestamp(window.resetsAt)
    const windowDurationMins = window.windowDurationMins ?? null
    if (!resetsAt || !windowDurationMins) continue

    let status: 'allowed_warning' | 'limited' | null = null
    if (reachedType && (
      reachedType === key ||
      reachedType.includes(key) ||
      (key === 'primary' && (reachedType.includes('5h') || reachedType.includes('5-hour') || reachedType.includes('five'))) ||
      (key === 'secondary' && (reachedType.includes('week') || reachedType.includes('weekly')))
    )) {
      status = 'limited'
    } else if (usedPercent !== null && usedPercent >= 100) {
      status = 'limited'
    } else if (usedPercent !== null && usedPercent >= CODEX_RATE_LIMIT_WARNING_PERCENT) {
      status = 'allowed_warning'
    }
    if (!status) continue

    let durationLabel: string
    if (windowDurationMins === 300) {
      durationLabel = '5h'
    } else if (windowDurationMins === 10_080) {
      durationLabel = 'weekly'
    } else if (windowDurationMins % 10_080 === 0) {
      const weeks = windowDurationMins / 10_080
      durationLabel = weeks === 1 ? 'weekly' : `${weeks}w`
    } else if (windowDurationMins % 1_440 === 0) {
      durationLabel = `${windowDurationMins / 1_440}d`
    } else if (windowDurationMins % 60 === 0) {
      durationLabel = `${windowDurationMins / 60}h`
    } else {
      durationLabel = `${windowDurationMins}m`
    }

    const event: Extract<NormalizedEvent, { type: 'rate_limit' }> = {
      type: 'rate_limit',
      status,
      resetsAt: resetsAt + CODEX_RATE_LIMIT_SEND_BUFFER_SECONDS,
      rateLimitType: `Codex ${windowDurationMins === 300 || windowDurationMins === 10_080 ? durationLabel : `${key} ${durationLabel}`}`,
      windowDurationMins,
      isUsingOverage: rateLimits.credits?.hasCredits,
      deferCurrentRun: true,
    }
    if (usedPercent !== null) event.usedPercent = usedPercent
    events.push(event)
  }

  return events
}

function normalizePlanItemStatus(status: string | undefined): 'completed' | 'in_progress' | 'pending' {
  if (!status) return 'pending'
  const normalized = status.trim().replace(/[\s-]/g, '_').toLowerCase()
  if (normalized === 'completed' || normalized === 'pending') return normalized
  if (normalized === 'in_progress' || normalized === 'inprogress') return 'in_progress'
  if (normalized === 'complete' || normalized === 'done' || normalized === 'success') return 'completed'
  if (normalized === 'running' || normalized === 'active' || normalized === 'current') return 'in_progress'
  return 'pending'
}

function normalizeItemStarted(params: any): NormalizedEvent[] {
  const item = params?.item
  if (!item?.id || !item?.type) return []

  // The transcript prints how long the agent thought, never the thought itself.
  if (item.type === 'reasoning') {
    return [{ type: 'thinking', state: 'start', parentToolUseId: codexParentToolUseId(params) }]
  }

  if (item.type === 'subAgentActivity') {
    if (item.kind === 'started') {
      return [{
        type: 'tool_call',
        toolName: 'spawnAgent',
        toolId: item.id,
        index: 0,
        toolInput: codexSubagentActivityInput(item),
        parentToolUseId: codexParentToolUseId(params),
        isSubagent: true,
        subagentType: 'codex',
      }]
    }
    if (item.kind === 'interrupted') {
      return [{
        type: 'tool_result',
        toolUseId: item.id,
        content: 'Interrupted',
        isError: true,
        parentToolUseId: codexParentToolUseId(params),
      }]
    }
    return []
  }

  const toolName = codexToolNameForItem(item)
  if (!toolName) return []
  const isClaudeSubagent = item.type === 'dynamicToolCall' &&
    toolName.slice(toolName.lastIndexOf('.') + 1) === 'claude_subagent'
  const isCodexSubagent = item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent'
  const isSubagent = isCodexSubagent || isClaudeSubagent

  return [{
    type: 'tool_call',
    toolName,
    toolId: item.id,
    index: 0,
    toolInput: codexStartedToolInput(item),
    parentToolUseId: codexParentToolUseId(params),
    isSubagent,
    subagentType: isClaudeSubagent ? 'claude' : isCodexSubagent ? 'codex' : undefined,
  }]
}

function normalizeToolUpdate(params: any): NormalizedEvent[] {
  const text = [params?.delta, params?.output, params?.diff, params?.patch, params?.message]
    .map((candidate) => parsedString(candidate))
    .find(Boolean)
  const changes = z.array(z.json()).safeParse(params?.changes)
  if (!text && !changes.success) return []
  const payload = text ?? JSON.stringify({ changes: changes.success ? changes.data : [] })
  return [{
    type: 'tool_call_update',
    toolId: params?.itemId || '',
    toolInput: payload,
    parentToolUseId: codexParentToolUseId(params),
  }]
}

function normalizeItemCompleted(params: any, opts?: { assembledAgentMessages?: boolean }): NormalizedEvent[] {
  const item = params?.item
  if (!item?.id) return []
  // Codex emits sub-agent lifecycle records as completed items without a
  // preceding item/started notification. Treat the record itself as the
  // lifecycle event: "started" opens the still-running card, while
  // "interrupted" settles it through the same normalization used above.
  if (item.type === 'subAgentActivity') return normalizeItemStarted(params)
  if (item.type === 'reasoning') {
    return [{ type: 'thinking', state: 'stop', parentToolUseId: codexParentToolUseId(params) }]
  }
  const parentToolUseId = codexParentToolUseId(params)
  const toolName = codexToolNameForItem(item)
  const isClaudeSubagent = item.type === 'dynamicToolCall' &&
    toolName?.slice(toolName.lastIndexOf('.') + 1) === 'claude_subagent'
  const isCodexSubagent = item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent'
  const isSubagent = isCodexSubagent || isClaudeSubagent

  if (item.type === 'agentMessage') {
    // Not parented: headless transcript mode emits the assembled message so the
    // renderer can reconcile it with streamed chunks; regular mode adds a
    // paragraph separator. Parented Codex collaboration messages still arrive
    // assembled here because their deltas are filtered above.
    if (!parentToolUseId) {
      if (opts?.assembledAgentMessages) {
        const text = parsedString(item.text)
        if (!text) return []
        const event: Extract<NormalizedEvent, { type: 'assistant_message' }> = {
          type: 'assistant_message',
          text,
        }
        if (item.phase === 'final_answer') event.isFinal = true
        return [event]
      }
      return [{ type: 'text_chunk', text: '\n\n' }]
    }
    const text = parsedString(item.text)
    if (!text) return []
    const event: Extract<NormalizedEvent, { type: 'assistant_message' }> = {
      type: 'assistant_message',
      text,
      parentToolUseId,
    }
    if (item.phase === 'final_answer') event.isFinal = true
    return [event]
  }

  if (!toolName) return []

  const updates: NormalizedEvent[] = []
  if (item.type === 'imageGeneration') {
    const imagePath = codexImageArtifactPath(item)
    if (imagePath) {
      updates.push({
        type: 'artifact_created',
        kind: 'image',
        path: imagePath,
      })
    }
  } else if (item.type === 'commandExecution') {
    const output =
      parsedString(item.aggregatedOutput) ??
      parsedString(item.result) ??
      parsedString(item.error) ??
      ''
    if (output) {
      updates.push({
        type: 'tool_call_update',
        toolId: item.id,
        content: output,
      })
    }
  } else if (item.type === 'fileChange' && Array.isArray(item.changes)) {
    updates.push({
      type: 'tool_call_update',
      toolId: item.id,
      toolInput: JSON.stringify({ changes: item.changes }),
    })
  } else if (!isSubagent) {
    const payload = item.aggregatedOutput || item.result || item.error || (Array.isArray(item.changes) ? { changes: item.changes } : null)
    if (payload) {
      updates.push({
        type: 'tool_call_update',
        toolId: item.id,
        content: parsedString(payload) ?? JSON.stringify(payload),
      })
    }
  }
  updates.push({ type: 'tool_call_complete', index: 0, toolId: item.id })
  if (item.type === 'collabAgentToolCall' || isClaudeSubagent) {
    const resultEvent: Extract<NormalizedEvent, { type: 'tool_result' }> = {
      type: 'tool_result',
      toolUseId: item.id,
      content: codexItemResultText(item),
      isError: item.status === 'failed' || item.success === false || !!item.error,
    }
    if (isSubagent) resultEvent.isSubagentReport = true
    updates.push(resultEvent)
  }
  if (parentToolUseId) {
    for (const update of updates) {
      // SAFETY: Every normalized event accepts the routing metadata added by the event reducer.
      const routedUpdate = update as NormalizedEvent & { parentToolUseId?: string }
      routedUpdate.parentToolUseId = parentToolUseId
    }
  }
  return updates
}

function codexItemResultText(item: any): string {
  const aggregatedOutput = parsedString(item.aggregatedOutput)
  if (aggregatedOutput) return aggregatedOutput
  if (Array.isArray(item.contentItems)) {
    const text = item.contentItems
      .map((part: any) => contentPartText(part))
      .filter(Boolean)
      .join('\n')
    if (text) return text
  }
  const resultText = parsedString(item.result)
  if (resultText) return resultText
  const result = z.object({
    contentItems: z.array(contentPartSchema).optional(),
    content: z.array(contentPartSchema).optional(),
  }).safeParse(item.result)
  if (result.success) {
    const content = result.data.contentItems ?? result.data.content
    if (Array.isArray(content)) {
      return content
        .map((part) => contentPartText(part))
        .filter(Boolean)
        .join('\n')
    }
  }
  return parsedString(item.error) || parsedString(item.status) || ''
}

function contentPartText<Part>(part: Part): string {
  const parsed = contentPartSchema.safeParse(part)
  if (!parsed.success) return ''
  return parsedString(parsed.data) ?? parsed.data.text ?? ''
}

function codexStartedToolInput(item: any): string | undefined {
  if (item.type === 'commandExecution') return parsedString(item.command)
  if (item.type === 'dynamicToolCall' && item.arguments !== undefined) {
    return parsedString(item.arguments) ?? JSON.stringify(item.arguments)
  }
  if (item.type !== 'collabAgentToolCall') return undefined

  const parsedArguments = collabArgumentsSchema.safeParse(item.arguments)
  const args = parsedArguments.success ? parsedArguments.data : {}
  const settings = args.settings ?? {}
  const prompt = stringField(item.prompt) || stringField(args.prompt) || stringField(args.task) || stringField(args.instructions)
  const description = stringField(args.description) || stringField(args.title) || prompt || stringField(item.name) || stringField(item.tool)
  const model = stringField(item.model) || stringField(args.model) || stringField(args.model_id) || stringField(settings.model)
  const reasoningEffort =
    stringField(item.reasoningEffort) ||
    stringField(args.reasoning_effort) ||
    stringField(args.reasoningEffort) ||
    stringField(settings.reasoning_effort) ||
    stringField(settings.reasoningEffort)
  const input: CodexSubagentToolInput = {
    subagent_type: stringField(item.tool) || stringField(item.name) || 'agent',
  }
  if (description) input.description = description
  if (prompt) input.prompt = prompt
  if (model) input.model = model
  if (reasoningEffort) input.reasoning_effort = reasoningEffort
  return JSON.stringify(input)
}

function stringField<Value>(value: Value): string {
  return parsedString(value)?.trim() ?? ''
}

function codexParentToolUseId(params: any): string | undefined {
  for (const value of [
    params?.parentToolUseId,
    params?.parent_tool_use_id,
    params?.parentItemId,
    params?.parent_item_id,
    params?.parentId,
    params?.item?.parentToolUseId,
    params?.item?.parent_tool_use_id,
    params?.item?.parentItemId,
    params?.item?.parent_item_id,
    params?.item?.parentId,
  ]) {
    const parsed = parsedString(value)
    if (parsed) return parsed
  }
  return undefined
}

function normalizeTurnCompleted(params: any): NormalizedEvent[] {
  const turn = params?.turn || {}
  const parentToolUseId = codexParentToolUseId(params)
  if (parentToolUseId) {
    if (turn.status === 'failed') {
      const parsedError = codexErrorPayload(turn.error)
      const message = parsedError?.message
      return [{
        type: 'tool_result',
        toolUseId: parentToolUseId,
        content: message || 'Codex subagent failed',
        isError: true,
        parentToolUseId,
        isSubagentReport: true,
      }]
    }
    if (
      turn.status === 'interrupted' ||
      turn.status === 'cancelled' ||
      turn.status === 'canceled' ||
      turn.status === 'aborted'
    ) {
      return [{
        type: 'tool_result',
        toolUseId: parentToolUseId,
        content: 'Interrupted',
        isError: true,
        parentToolUseId,
        isSubagentReport: true,
      }]
    }
    return []
  }
  if (turn.status === 'interrupted' || turn.status === 'cancelled' || turn.status === 'canceled' || turn.status === 'aborted') return []
  if (turn.status === 'failed') {
    const events: NormalizedEvent[] = []
    const rateLimitEvent = codexRateLimitEvent(turn.error)
    if (rateLimitEvent) events.push(rateLimitEvent)

    const message = codexErrorPayload(turn.error)?.message
    events.push({ type: 'error', message: message || 'Codex turn failed', isError: true, sessionId: params?.threadId })

    return events
  }

  return [{
    type: 'task_complete',
    result: '',
    costUsd: 0,
    durationMs: turn.durationMs || 0,
    numTurns: 1,
    usage: {},
    sessionId: params?.threadId || '',
  }]
}

function codexErrorPayload<ErrorValue>(error: ErrorValue): z.infer<typeof codexErrorPayloadSchema> | null {
  const message = parsedString(error)
  if (message) return { message }
  const parsed = codexErrorPayloadSchema.safeParse(error)
  return parsed.success ? parsed.data : null
}

function codexRateLimitEvent<ErrorValue>(error: ErrorValue): NormalizedEvent | null {
  const payload = codexErrorPayload(error)
  if (!payload) return null
  const kind = codexErrorKind(payload.codexErrorInfo)
  const httpStatusCode = codexHttpStatusCode(payload.codexErrorInfo)
  const rateLimitKind = kind || payload.code
  const normalizedKind = rateLimitKind?.replace(/[\s_-]/g, '').toLowerCase() ?? null
  const isRateLimit = normalizedKind === 'usagelimitexceeded' ||
    normalizedKind === 'ratelimitexceeded' ||
    normalizedKind === 'ratelimit' ||
    httpStatusCode === 429 ||
    (!!payload.message && /\b(usage limit|rate limit|429)\b/i.test(payload.message))
  if (!isRateLimit) return null

  const reset = findResetTimestamp(payload.additionalDetails) ||
    findResetTimestamp(payload.message) ||
    Math.ceil(Date.now() / 1000) + 5 * 60

  return {
    type: 'rate_limit',
    status: 'limited',
    resetsAt: reset + CODEX_RATE_LIMIT_SEND_BUFFER_SECONDS,
    rateLimitType: rateLimitKind?.trim()
      ? rateLimitKind.trim()
      : httpStatusCode ? `HTTP ${httpStatusCode}` : 'Codex',
    isUsingOverage: false
  }
}

function codexErrorKind(info: z.infer<typeof codexErrorInfoSchema> | null | undefined): string | null {
  if (!info) return null
  const named = stringValueSchema.safeParse(info)
  if (named.success) return named.data
  if ('httpConnectionFailed' in info) return 'httpConnectionFailed'
  if ('responseStreamConnectionFailed' in info) return 'responseStreamConnectionFailed'
  if ('responseStreamDisconnected' in info) return 'responseStreamDisconnected'
  if ('responseTooManyFailedAttempts' in info) return 'responseTooManyFailedAttempts'
  if ('activeTurnNotSteerable' in info) return 'activeTurnNotSteerable'
  return null
}

function codexHttpStatusCode(info: z.infer<typeof codexErrorInfoSchema> | null | undefined): number | null {
  if (!info || stringValueSchema.safeParse(info).success) return null
  if ('httpStatusCode' in info) return info.httpStatusCode
  if ('httpConnectionFailed' in info) return info.httpConnectionFailed.httpStatusCode
  if ('responseStreamConnectionFailed' in info) return info.responseStreamConnectionFailed.httpStatusCode
  if ('responseStreamDisconnected' in info) return info.responseStreamDisconnected.httpStatusCode
  if ('responseTooManyFailedAttempts' in info) return info.responseTooManyFailedAttempts.httpStatusCode
  return null
}
