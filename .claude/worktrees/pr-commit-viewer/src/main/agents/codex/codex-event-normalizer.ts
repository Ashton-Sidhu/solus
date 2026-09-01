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
      const threadId = typeof params?.threadId === 'string' ? params.threadId : null
      return threadId ? [{ type: 'goal_cleared', threadId }] : []
    }

    case 'item/agentMessage/delta': {
      if (typeof params?.delta !== 'string' || !params.delta) return []
      const parentToolUseId = codexParentToolUseId(params)
      return [{
        type: 'text_chunk',
        text: params.delta,
        ...(parentToolUseId ? { parentToolUseId } : {}),
      }]
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

      const planItems = Array.isArray(params?.plan) ? params.plan : []
      const todos = planItems
        .map((p: any) => ({
          content: String(p.step || p.text || p.description || p.title || '').trim(),
          status: normalizePlanItemStatus(p.status),
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
      typeof item.id !== 'string'
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
  const goal = value as {
    threadId?: unknown
    objective?: unknown
    status?: unknown
    tokenBudget?: unknown
    tokensUsed?: unknown
    timeUsedSeconds?: unknown
    createdAt?: unknown
    updatedAt?: unknown
    completedAt?: unknown
  }
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
    value === 'paused' ||
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
    // `last` is the prompt of the turn that just ran — the window as it stands.
    // `total` sums every turn in the thread, so it passes the window many times
    // over and only means anything as cumulative spend.
    const context = codexContextUsage(tokenUsage?.last, finiteTokenCount(tokenUsage?.modelContextWindow) || undefined)
    const run = codexRunUsage(tokenUsage?.total)
    if (!context && !run) return null
    return { type: 'usage', ...(context ? { context } : {}), ...(run ? { run } : {}) }
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

  const context = codexContextUsage(info.last_token_usage || info.usage)
  const run = codexRunUsage(info.total_token_usage || info.usage)
  if (!context && !run) return null
  return { type: 'usage', ...(context ? { context } : {}), ...(run ? { run } : {}) }
}

type UsageEvent = Extract<NormalizedEvent, { type: 'usage' }>

interface CodexTokenBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
}

/** Reads a Codex token breakdown in either the v2 camelCase or the older
 *  snake_case spelling — the two protocol versions report the same numbers. */
function codexTokenBreakdown(raw: any): CodexTokenBreakdown | null {
  if (!raw || typeof raw !== 'object') return null
  const inputTokens = finiteTokenCount(raw.inputTokens ?? raw.input_tokens)
  const cachedInputTokens = finiteTokenCount(raw.cachedInputTokens ?? raw.cached_input_tokens)
  const outputTokens = finiteTokenCount(raw.outputTokens ?? raw.output_tokens)
  if (!inputTokens && !cachedInputTokens && !outputTokens) return null
  return {
    totalTokens: finiteTokenCount(raw.totalTokens ?? raw.total_tokens) || inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens: finiteTokenCount(raw.reasoningOutputTokens ?? raw.reasoning_output_tokens),
  }
}

function codexContextUsage(raw: any, windowTokens?: number): ContextUsage | null {
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

function codexRunUsage(raw: any): UsageData | null {
  const breakdown = codexTokenBreakdown(raw)
  if (!breakdown) return null
  return {
    inputTokens: Math.max(0, breakdown.inputTokens - breakdown.cachedInputTokens),
    outputTokens: breakdown.outputTokens,
    cacheReadTokens: breakdown.cachedInputTokens,
    reasoningTokens: breakdown.reasoningTokens || undefined,
  }
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
        return typeof item.text === 'string' && item.text
          ? [{
              type: 'assistant_message',
              text: item.text,
              ...(item.phase === 'final_answer' ? { isFinal: true } : {}),
            }]
          : []
      }
      return [{ type: 'text_chunk', text: '\n\n' }]
    }
    return typeof item.text === 'string' && item.text
      ? [{
          type: 'assistant_message',
          text: item.text,
          parentToolUseId,
          ...(item.phase === 'final_answer' ? { isFinal: true } : {}),
        }]
      : []
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
  } else if (!isSubagent) {
    const payload = item.aggregatedOutput || item.result || item.error || (Array.isArray(item.changes) ? { changes: item.changes } : null)
    if (payload) {
      updates.push({
        type: 'tool_call_update',
        toolId: item.id,
        content: typeof payload === 'string' ? payload : JSON.stringify(payload),
      })
    }
  }
  updates.push({ type: 'tool_call_complete', index: 0, toolId: item.id })
  if (item.type === 'collabAgentToolCall' || isClaudeSubagent) {
    updates.push({
      type: 'tool_result',
      toolUseId: item.id,
      content: codexItemResultText(item),
      isError: item.status === 'failed' || item.success === false || !!item.error,
      ...(isSubagent ? { isSubagentReport: true } : {}),
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
  if (Array.isArray(item.contentItems)) {
    const text = item.contentItems
      .map((part: unknown) => {
        if (typeof part === 'string') return part
        if (!part || typeof part !== 'object') return ''
        const record = part as { text?: unknown }
        return typeof record.text === 'string' ? record.text : ''
      })
      .filter(Boolean)
      .join('\n')
    if (text) return text
  }
  if (typeof item.result === 'string' && item.result) return item.result
  if (item.result && typeof item.result === 'object') {
    const content = item.result.contentItems ?? item.result.content
    if (Array.isArray(content)) {
      return content
        .map((part: unknown) => {
          if (typeof part === 'string') return part
          if (!part || typeof part !== 'object') return ''
          const record = part as { text?: unknown }
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
  if (item.type === 'dynamicToolCall' && item.arguments !== undefined) {
    return typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments)
  }
  if (item.type !== 'collabAgentToolCall') return undefined

  const args = item.arguments && typeof item.arguments === 'object'
    ? item.arguments as {
        settings?: unknown
        prompt?: unknown
        task?: unknown
        instructions?: unknown
        description?: unknown
        title?: unknown
        model?: unknown
        model_id?: unknown
        reasoning_effort?: unknown
        reasoningEffort?: unknown
      }
    : {}
  const settings = args.settings && typeof args.settings === 'object'
    ? args.settings as { model?: unknown; reasoning_effort?: unknown; reasoningEffort?: unknown }
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
  const parentToolUseId = codexParentToolUseId(params)
  if (parentToolUseId) {
    if (turn.status === 'failed') {
      const message = typeof turn.error === 'string' ? turn.error : turn.error?.message
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

  const record = info as { type?: unknown; code?: unknown; kind?: unknown; name?: unknown }
  for (const key of ['type', 'code', 'kind', 'name']) {
    const value = Reflect.get(record, key)
    if (typeof value === 'string') return value
  }

  const variantKey = Object.keys(info).find((key) => key !== 'httpStatusCode')
  return variantKey || null
}

function codexHttpStatusCode(info: unknown): number | null {
  if (!info || typeof info !== 'object') return null
  const record = info as { httpStatusCode?: unknown }
  if (typeof record.httpStatusCode === 'number') return record.httpStatusCode

  for (const value of Object.values(info)) {
    if (value && typeof value === 'object') {
      const nested = (value as { httpStatusCode?: unknown }).httpStatusCode
      if (typeof nested === 'number') return nested
    }
  }
  return null
}
