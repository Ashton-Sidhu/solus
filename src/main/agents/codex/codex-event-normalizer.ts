import type { NormalizedEvent, ThreadGoal, UsageData } from '../../../shared/types'
import { findResetTimestamp } from '../../rate-limits'
import {
  codexImageArtifactPath,
  codexToolNameForItem,
  isInterruptedTurnStatus,
  planFromCompletedItem,
  planTextFromPlanUpdated,
} from './codex-utils'
import type { TurnNormalizer, TurnSummary } from '../turn-normalizer'
import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  CodexThreadStartResponse,
  CodexTurnStartResponse,
  CodexModelListResponse,
} from './codex-protocol'

const CODEX_RATE_LIMIT_WARNING_PERCENT = 80
const CODEX_RATE_LIMIT_SEND_BUFFER_SECONDS = 2 * 60

export interface CodexErrorPayload {
  message?: string
  code?: string
  codexErrorInfo?: unknown
  additionalDetails?: unknown
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

function normalizeCodexNotification(method: string, params: any, opts?: { planMode?: boolean }): NormalizedEvent[] {
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
      const threadId = typeof params?.threadId === 'string' ? params.threadId : null
      return threadId ? [{ type: 'goal_cleared', threadId }] : []
    }

    case 'item/agentMessage/delta':
      // Sub-agent text no longer streams — it arrives whole on item/completed.
      return typeof params?.delta === 'string' && params.delta && !codexParentToolUseId(params)
        ? [{ type: 'text_chunk', text: params.delta }]
        : []

    case 'item/started':
      return normalizeItemStarted(params)

    case 'item/fileChange/patchUpdated':
    case 'item/mcpToolCall/progress':
      return normalizeToolUpdate(params)

    case 'item/completed':
      return normalizeItemCompleted(params)

    case 'turn/plan/updated': {
      if (opts?.planMode) return []

      const planItems = Array.isArray(params?.plan) ? params.plan : []
      const todos = planItems
        .map((p: any) => ({
          content: String(p.step || p.text || p.description || p.title || '').trim(),
          status: normalizePlanItemStatus(p.status),
        }))
        .filter((p: { content: string }) => p.content)
      return todos.length > 0 ? [{ type: 'progress', todos }] : []
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
  private readonly planMode: boolean
  private readonly turnSummary: TurnSummary = {
    toolCallCount: 0,
    sawRateLimit: false,
    sawProtocolError: false,
    permissionDenials: [],
  }

  constructor(opts: { planMode: boolean }) {
    this.planMode = opts.planMode
  }

  get summary(): TurnSummary {
    return this.turnSummary
  }

  push(raw: { method: string; params: any }): NormalizedEvent[] {
    const { method } = raw
    const params = this.withSubagentParent(raw.params)
    this.captureTurnId(params)
    if (isInterruptedTurnStatus(params?.turn?.status)) this.interrupted = true
    if (this.interrupted) return []

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

      if (method === 'item/agentMessage/delta' && typeof params?.delta === 'string') {
        this.streamedPlanText += params.delta
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

    events.push(...normalizeCodexNotification(method, params, { planMode: this.planMode }))
    return this.emit(events)
  }

  private withSubagentParent(params: any): any {
    const item = params?.item
    if (item?.type === 'collabAgentToolCall' && typeof item.id === 'string') {
      for (const threadId of item.receiverThreadIds ?? []) {
        if (typeof threadId === 'string' && threadId) {
          this.subagentParentByThreadId.set(threadId, item.id)
        }
      }
    }

    if (codexParentToolUseId(params)) return params
    const parentToolUseId = this.subagentParentByThreadId.get(params?.threadId)
    return parentToolUseId ? { ...params, parentToolUseId } : params
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
    const turnId = typeof params?.turnId === 'string'
      ? params.turnId
      : typeof params?.turn?.id === 'string'
        ? params.turn.id
        : null
    if (turnId) this.turnId = turnId
  }

  private planId(params: any): string {
    return `codex-plan-${this.turnId || params?.turnId || params?.turn?.id || Date.now()}`
  }
}

export function normalizeThreadGoal(value: unknown): ThreadGoal | null {
  if (!value || typeof value !== 'object') return null
  const goal = value as Record<string, unknown>
  if (typeof goal.threadId !== 'string' || typeof goal.objective !== 'string') return null
  const status = typeof goal.status === 'string' ? goal.status : 'active'
  if (!isThreadGoalStatus(status)) return null
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status,
    tokenBudget: finiteOptionalNumber(goal.tokenBudget),
    tokensUsed: finiteOptionalNumber(goal.tokensUsed),
    timeUsedSeconds: finiteOptionalNumber(goal.timeUsedSeconds),
    createdAt: finiteOptionalNumber(goal.createdAt),
    updatedAt: finiteOptionalNumber(goal.updatedAt),
  }
}

function isThreadGoalStatus(value: string): value is ThreadGoal['status'] {
  return value === 'active' ||
    value === 'complete' ||
    value === 'blocked' ||
    value === 'budgetLimited' ||
    value === 'usageLimited'
}

function finiteOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeCodexTokenCount(method: string, params: any): UsageEvent | null {
  if (method === 'thread/tokenUsage/updated') {
    const tokenUsage = params?.tokenUsage
    const rawUsage = tokenUsage?.last
    if (!rawUsage || typeof rawUsage !== 'object') return null

    const usage = normalizedCodexUsage(
      rawUsage.inputTokens,
      rawUsage.cachedInputTokens,
      rawUsage.outputTokens,
      tokenUsage.modelContextWindow,
      rawUsage.reasoningOutputTokens,
    )
    if (!usage) return null

    const rawTotalUsage = tokenUsage?.total
    if (!rawTotalUsage || typeof rawTotalUsage !== 'object') return usage

    const totalUsage = normalizedCodexUsage(
      rawTotalUsage.inputTokens,
      rawTotalUsage.cachedInputTokens,
      rawTotalUsage.outputTokens,
      tokenUsage.modelContextWindow,
      rawTotalUsage.reasoningOutputTokens,
    )
    return totalUsage ? { ...usage, sessionUsage: totalUsage.usage } : usage
  }

  const payload = [
    params,
    params?.payload,
    params?.event,
    params?.msg,
    params?.message,
  ].find((candidate) => candidate?.type === 'token_count') ?? (method === 'token_count' ? params : null)
  const info = payload?.info
  if (!info || typeof info !== 'object') return null

  const rawUsage = info.last_token_usage || info.total_token_usage || info.usage
  if (!rawUsage || typeof rawUsage !== 'object') return null

  return normalizedCodexUsage(
    rawUsage.input_tokens,
    rawUsage.cached_input_tokens,
    rawUsage.output_tokens,
  )
}

type UsageEvent = Extract<NormalizedEvent, { type: 'usage' }>

function normalizedCodexUsage(
  rawInputTokens: unknown,
  rawCachedInputTokens: unknown,
  rawOutputTokens: unknown,
  rawContextWindowTokens?: unknown,
  rawReasoningOutputTokens?: unknown,
): UsageEvent | null {
  const inputTokens = finiteTokenCount(rawInputTokens)
  const cachedInputTokens = finiteTokenCount(rawCachedInputTokens)
  const outputTokens = finiteTokenCount(rawOutputTokens)
  if (!inputTokens && !cachedInputTokens && !outputTokens) return null

  // Codex/OpenAI reports cached input as part of input_tokens. Solus UsageData
  // keeps cache tokens separate so the shared context meter can add them once.
  const freshInputTokens = Math.max(0, inputTokens - cachedInputTokens)
  const usage: UsageData = {
    inputTokens: freshInputTokens,
    outputTokens: outputTokens,
    cacheReadTokens: cachedInputTokens,
    reasoningTokens: finiteTokenCount(rawReasoningOutputTokens) || undefined,
    contextWindowTokens: finiteTokenCount(rawContextWindowTokens) || undefined,
  }

  return { type: 'usage', usage }
}

function finiteTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0
}

function normalizeCodexRateLimitsUpdated(params: any): NormalizedEvent[] {
  const rateLimits = params?.rateLimits
  if (!rateLimits || typeof rateLimits !== 'object') return []

  const reachedType = typeof rateLimits.rateLimitReachedType === 'string'
    ? rateLimits.rateLimitReachedType.toLowerCase()
    : null

  const events: NormalizedEvent[] = []
  for (const [key, window] of [
    ['primary', rateLimits.primary],
    ['secondary', rateLimits.secondary],
  ] as const) {
    if (!window || typeof window !== 'object') continue

    const usedPercent = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
      ? window.usedPercent
      : null
    const resetsAt = findResetTimestamp(window.resetsAt)
    const windowDurationMins = typeof window.windowDurationMins === 'number' && Number.isFinite(window.windowDurationMins)
      ? window.windowDurationMins
      : null
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

    events.push({
      type: 'rate_limit',
      status,
      resetsAt: resetsAt + CODEX_RATE_LIMIT_SEND_BUFFER_SECONDS,
      rateLimitType: `Codex ${windowDurationMins === 300 || windowDurationMins === 10_080 ? durationLabel : `${key} ${durationLabel}`}`,
      ...(usedPercent !== null ? { usedPercent } : {}),
      windowDurationMins,
      isUsingOverage: rateLimits.credits?.hasCredits,
      deferCurrentRun: true,
    })
  }

  return events
}

function normalizePlanItemStatus(status: unknown): 'completed' | 'in_progress' | 'pending' {
  if (typeof status !== 'string') return 'pending'

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

  const toolName = codexToolNameForItem(item)
  if (!toolName) return []
  const isSubagent = item.type === 'collabAgentToolCall'

  return [{
    type: 'tool_call',
    toolName,
    toolId: item.id,
    index: 0,
    toolInput: codexStartedToolInput(item),
    parentToolUseId: codexParentToolUseId(params),
    isSubagent,
    subagentType: isSubagent ? toolName : undefined,
  }]
}

function normalizeToolUpdate(params: any): NormalizedEvent[] {
  const text = params?.delta || params?.output || params?.diff || params?.patch || params?.message
  if ((typeof text !== 'string' || !text) && !Array.isArray(params?.changes)) return []
  const payload = typeof text === 'string' && text
    ? text
    : JSON.stringify({ changes: params.changes })
  return [{
    type: 'tool_call_update',
    toolId: params?.itemId || '',
    toolInput: payload,
    parentToolUseId: codexParentToolUseId(params),
  }]
}

function normalizeItemCompleted(params: any): NormalizedEvent[] {
  const item = params?.item
  if (!item?.id) return []
  const parentToolUseId = codexParentToolUseId(params)

  if (item.type === 'agentMessage') {
    // Not parented: main-thread paragraph separator between streamed messages.
    // Parented: sub-agent prose no longer streams, so deliver the full text here
    // as the assembled assistant message the reducer lands in the sub-agent card.
    if (!parentToolUseId) return [{ type: 'text_chunk', text: '\n\n' }]
    return typeof item.text === 'string' && item.text
      ? [{ type: 'assistant_message', text: item.text, parentToolUseId }]
      : []
  }

  if (!codexToolNameForItem(item)) return []

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
      typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput :
        typeof item.result === 'string' ? item.result :
          typeof item.error === 'string' ? item.error :
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
  } else {
    const payload = item.aggregatedOutput || item.result || item.error || (Array.isArray(item.changes) ? { changes: item.changes } : null) || item.status
    if (payload) {
      updates.push({
        type: 'tool_call_update',
        toolId: item.id,
        toolInput: typeof payload === 'string' ? payload : JSON.stringify(payload),
      })
    }
  }
  updates.push({ type: 'tool_call_complete', index: 0, toolId: item.id })
  if (item.type === 'collabAgentToolCall') {
    updates.push({
      type: 'tool_result',
      toolUseId: item.id,
      content: codexItemResultText(item),
      isError: item.status === 'failed' || !!item.error,
    })
  }
  if (parentToolUseId) {
    for (const update of updates) {
      ;(update as NormalizedEvent & { parentToolUseId?: string }).parentToolUseId = parentToolUseId
    }
  }
  return updates
}

function codexItemResultText(item: any): string {
  if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput) return item.aggregatedOutput
  if (typeof item.result === 'string' && item.result) return item.result
  if (item.result && typeof item.result === 'object') {
    const content = item.result.contentItems ?? item.result.content
    if (Array.isArray(content)) {
      return content
        .map((part: unknown) => {
          if (typeof part === 'string') return part
          if (!part || typeof part !== 'object') return ''
          const record = part as Record<string, unknown>
          return typeof record.text === 'string' ? record.text : ''
        })
        .filter(Boolean)
        .join('\n')
    }
  }
  if (typeof item.error === 'string' && item.error) return item.error
  return typeof item.status === 'string' ? item.status : ''
}

function codexStartedToolInput(item: any): string | undefined {
  if (item.type === 'commandExecution' && typeof item.command === 'string') return item.command
  if (item.type !== 'collabAgentToolCall') return undefined

  const args = item.arguments && typeof item.arguments === 'object'
    ? item.arguments as Record<string, unknown>
    : {}
  const settings = args.settings && typeof args.settings === 'object'
    ? args.settings as Record<string, unknown>
    : {}
  const prompt = stringField(item.prompt) || stringField(args.prompt) || stringField(args.task) || stringField(args.instructions)
  const description = stringField(args.description) || stringField(args.title) || prompt || stringField(item.name) || stringField(item.tool)
  const model = stringField(item.model) || stringField(args.model) || stringField(args.model_id) || stringField(settings.model)
  const reasoningEffort =
    stringField(item.reasoningEffort) ||
    stringField(args.reasoning_effort) ||
    stringField(args.reasoningEffort) ||
    stringField(settings.reasoning_effort) ||
    stringField(settings.reasoningEffort)
  return JSON.stringify({
    subagent_type: stringField(item.tool) || stringField(item.name) || 'agent',
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  })
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
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
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function normalizeTurnCompleted(params: any): NormalizedEvent[] {
  const turn = params?.turn || {}
  if (turn.status === 'interrupted' || turn.status === 'cancelled' || turn.status === 'canceled' || turn.status === 'aborted') return []
  if (turn.status === 'failed') {
    const events: NormalizedEvent[] = []
    const rateLimitEvent = codexRateLimitEvent(turn.error)
    if (rateLimitEvent) events.push(rateLimitEvent)

    const message = typeof turn.error === 'string' ? turn.error : turn.error?.message
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

function codexRateLimitEvent(error: unknown): NormalizedEvent | null {
  if (!error) return null
  const payload: CodexErrorPayload = typeof error === 'string' ? { message: error } : error as CodexErrorPayload
  const kind = codexErrorKind(payload.codexErrorInfo)
  const httpStatusCode = codexHttpStatusCode(payload.codexErrorInfo)
  const rateLimitKind = kind || payload.code
  const normalizedKind = typeof rateLimitKind === 'string'
    ? rateLimitKind.replace(/[\s_-]/g, '').toLowerCase()
    : null
  const isRateLimit = normalizedKind === 'usagelimitexceeded' ||
    normalizedKind === 'ratelimitexceeded' ||
    normalizedKind === 'ratelimit' ||
    httpStatusCode === 429 ||
    (typeof payload.message === 'string' && /\b(usage limit|rate limit|429)\b/i.test(payload.message))
  if (!isRateLimit) return null

  const reset = findResetTimestamp(payload.additionalDetails) ||
    findResetTimestamp(payload.message) ||
    Math.ceil(Date.now() / 1000) + 5 * 60

  return {
    type: 'rate_limit',
    status: 'limited',
    resetsAt: reset + CODEX_RATE_LIMIT_SEND_BUFFER_SECONDS,
    rateLimitType: typeof rateLimitKind === 'string' && rateLimitKind.trim()
      ? rateLimitKind.trim()
      : httpStatusCode ? `HTTP ${httpStatusCode}` : 'Codex',
    isUsingOverage: false
  }
}

function codexErrorKind(info: unknown): string | null {
  if (!info) return null
  if (typeof info === 'string') return info
  if (typeof info !== 'object') return null

  const record = info as Record<string, unknown>
  for (const key of ['type', 'code', 'kind', 'name']) {
    if (typeof record[key] === 'string') return record[key] as string
  }

  const variantKey = Object.keys(record).find((key) => key !== 'httpStatusCode')
  return variantKey || null
}

function codexHttpStatusCode(info: unknown): number | null {
  if (!info || typeof info !== 'object') return null
  const record = info as Record<string, unknown>
  if (typeof record.httpStatusCode === 'number') return record.httpStatusCode

  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      const nested = (value as Record<string, unknown>).httpStatusCode
      if (typeof nested === 'number') return nested
    }
  }
  return null
}
