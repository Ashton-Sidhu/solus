import type { NormalizedEvent, ThreadGoal, UsageData } from '../../../shared/types'
import { codexImageArtifactPath, codexToolNameForItem } from './codex-utils'

const CODEX_RATE_LIMIT_WARNING_PERCENT = 80
const CODEX_RATE_LIMIT_SEND_BUFFER_SECONDS = 2 * 60

export type JsonRpcId = number | string

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: any
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export interface CodexThread {
  id: string
  sessionId?: string
  forkedFromId?: string
  cliVersion?: string
  modelProvider?: string
  cwd?: string
  status?: string
}

export interface CodexTurn {
  id: string
  status?: string
  durationMs?: number | null
  error?: CodexErrorPayload | string | null
}

export interface CodexErrorPayload {
  message?: string
  code?: string
  codexErrorInfo?: unknown
  additionalDetails?: unknown
}

export interface CodexThreadStartResponse {
  thread: CodexThread
  model?: string
}

export interface CodexTurnStartResponse {
  turn: CodexTurn
}

export interface CodexModelListResponse {
  data?: Array<{ id?: string; model?: string; displayName?: string; hidden?: boolean; isDefault?: boolean }>
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

export function normalizeCodexNotification(method: string, params: any, opts?: { planMode?: boolean }): NormalizedEvent[] {
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
        tools: [],
        model: thread.model || 'codex',
        mcpServers: [],
        skills: [],
        version: thread.cliVersion || 'unknown',
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
      return typeof params?.delta === 'string' && params.delta
        ? [{ type: 'text_chunk', text: params.delta }]
        : []

    case 'item/started':
      return normalizeItemStarted(params)

    case 'command/exec/outputDelta':
    case 'item/commandExecution/outputDelta':
    case 'item/fileChange/outputDelta':
    case 'item/fileChange/patchUpdated':
    case 'item/mcpToolCall/progress':
      return normalizeToolUpdate(method, params)

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
    input_tokens: freshInputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cachedInputTokens,
    reasoning_output_tokens: finiteTokenCount(rawReasoningOutputTokens) || undefined,
    context_window_tokens: finiteTokenCount(rawContextWindowTokens) || undefined,
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

  return [{
    type: 'tool_call',
    toolName,
    toolId: item.id,
    index: 0,
    toolInput: item.type === 'commandExecution' && typeof item.command === 'string' ? item.command : undefined,
  }]
}

function normalizeToolUpdate(method: string, params: any): NormalizedEvent[] {
  const text = params?.delta || params?.output || params?.diff || params?.patch || params?.message
  if ((typeof text !== 'string' || !text) && !Array.isArray(params?.changes)) return []
  const payload = typeof text === 'string' && text
    ? text
    : JSON.stringify({ changes: params.changes })
  if (method === 'command/exec/outputDelta' || method === 'item/commandExecution/outputDelta') {
    return [{
      type: 'tool_call_update',
      toolId: params?.itemId || '',
      content: payload,
    }]
  }
  return [{
    type: 'tool_call_update',
    toolId: params?.itemId || '',
    toolInput: payload,
  }]
}

function normalizeItemCompleted(params: any): NormalizedEvent[] {
  const item = params?.item
  if (!item?.id || !codexToolNameForItem(item)) return []

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
  return updates
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

function findResetTimestamp(value: unknown): number | null {
  if (value == null) return null

  if (typeof value === 'number') return normalizeResetNumber(value)

  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return normalizeResetNumber(numeric)

    const parsedDate = Date.parse(value)
    if (!Number.isNaN(parsedDate)) return Math.ceil(parsedDate / 1000)

    // Parse "try again at H:MM AM/PM" from Codex usage-limit messages
    const tryAgainMatch = value.match(/try again at (\d{1,2}):(\d{2})\s*(AM|PM)/i)
    if (tryAgainMatch) {
      let hours = parseInt(tryAgainMatch[1], 10)
      const minutes = parseInt(tryAgainMatch[2], 10)
      const meridiem = tryAgainMatch[3].toUpperCase()
      if (meridiem === 'AM' && hours === 12) hours = 0
      if (meridiem === 'PM' && hours !== 12) hours += 12
      const now = new Date()
      const reset = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0)
      if (reset.getTime() <= now.getTime()) reset.setDate(reset.getDate() + 1)
      return Math.ceil(reset.getTime() / 1000)
    }

    return null
  }

  if (typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  for (const key of [
    'resetsAt',
    'resetAt',
    'reset_at',
    'retryAfter',
    'retry_after',
    'retryAfterSeconds',
    'secondsUntilReset',
    'resetInSeconds',
  ]) {
    const found = findResetTimestamp(record[key])
    if (found) return found
  }

  return null
}

function normalizeResetNumber(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  if (value > 10_000_000_000) return Math.ceil(value / 1000)
  const nowSeconds = Date.now() / 1000
  if (value > nowSeconds - 60) return Math.ceil(value)
  return Math.ceil(nowSeconds + value)
}
