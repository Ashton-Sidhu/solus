import type { ContextUsage, NormalizedEvent, UsageData } from '@solus/contracts/types'
import type { ClaudeEvent, StreamEvent, InitEvent, StatusEvent, CompactBoundaryEvent, AssistantEvent, UserEvent, ResultEvent, RateLimitEvent, PermissionEvent, ContentBlock, ContentDelta, ClaudeUsageData } from '@solus/contracts/claude-types'
import type { TurnNormalizer, TurnSummary } from '../turn-normalizer'
import { normalizeResetNumber, rateLimitEventFromMessage } from '../../rate-limits'
import { parentSubagentEvent, type SubagentTranscriptEvent } from '../subagent-events'
import { claudeToolResultText } from './claude-subagent-protocol'
import { z } from 'zod'

const SDK_TO_UI_PERMISSION_MODE = {
  default: 'ask',
  acceptEdits: 'auto',
  plan: 'plan',
} satisfies Record<string, 'ask' | 'auto' | 'plan'>

const checkpointEventSchema = z.object({ type: z.literal('user'), uuid: z.string() })
const permissionDenialSchema = z.object({
  tool_name: z.string().optional(),
  tool_use_id: z.string().optional(),
})
const permissionDenialsSchema = z.array(permissionDenialSchema)
const editedFileInputSchema = z.object({
  file_path: z.string().optional(),
  notebook_path: z.string().optional(),
})
const todoInputSchema = z.object({
  todos: z.array(z.object({
    content: z.string().optional(),
    status: z.string().optional(),
  })),
})
const exitPlanInputSchema = z.object({
  plan: z.string().optional(),
  planFilePath: z.string().optional(),
})
const permissionToolSchema = z.object({ id: z.string().optional() })

interface ClaudeTaskSystemEvent {
  subtype: string
  task_id?: string
  tool_use_id?: string
  description?: string
  usage?: {
    total_tokens?: number
    tool_uses?: number
    duration_ms?: number
  }
  last_tool_name?: string
  status?: string
  patch?: { status?: string }
}

/**
 * Maps raw Claude stream-json events to canonical SOLUS events.
 * Mostly stateless (one raw in, zero or more normalized out), except that a
 * main-thread tool's input arrives only as `input_json_delta` stream events —
 * those accumulate into `pendingToolInputs` (keyed by content-block index) so the
 * complete input can ride out on `tool_call_complete`. `thinkingBlocks` is the
 * same trick for extended thinking: `content_block_stop` carries only an index,
 * so the start has to record which indexes were thinking. Sequencing/routing
 * lives in ClaudeAgent.
 */
function normalize(
  raw: ClaudeEvent,
  pendingToolInputs: Map<number, string>,
  thinkingBlocks: Set<number>,
): NormalizedEvent[] {
  switch (raw.type) {
    case 'system':
      // SAFETY: ClaudeEvent.type is the provider discriminant for system initialization, status, and compaction events.
      return normalizeSystem(raw as InitEvent | StatusEvent | CompactBoundaryEvent)

    case 'stream_event':
      // SAFETY: ClaudeEvent.type is the provider discriminant for stream events.
      return normalizeStreamEvent(raw as StreamEvent, pendingToolInputs, thinkingBlocks)

    case 'assistant':
      // SAFETY: ClaudeEvent.type is the provider discriminant for assistant events.
      return normalizeAssistant(raw as AssistantEvent)

    case 'user':
      // SAFETY: ClaudeEvent.type is the provider discriminant for user events.
      return normalizeUser(raw as UserEvent)

    case 'result':
      // SAFETY: ClaudeEvent.type is the provider discriminant for result events.
      return normalizeResult(raw as ResultEvent)

    case 'rate_limit_event':
      // SAFETY: ClaudeEvent.type is the provider discriminant for rate-limit events.
      return normalizeRateLimit(raw as RateLimitEvent)

    case 'permission_request':
      // SAFETY: ClaudeEvent.type is the provider discriminant for permission events.
      return normalizePermission(raw as PermissionEvent)

    default:
      return []
  }
}

export class ClaudeTurnNormalizer implements TurnNormalizer<ClaudeEvent> {
  private interrupted = false
  private readonly turnSummary: TurnSummary = {
    toolCallCount: 0,
    sawRateLimit: false,
    sawProtocolError: false,
    permissionDenials: [],
  }
  private readonly editedFileSet = new Set<string>()
  // A main-thread tool's input arrives only as input_json_delta stream events;
  // accumulate per content-block index so the assembled input rides out on
  // tool_call_complete. Cleared on message_start so indexes never leak.
  private readonly pendingToolInputs = new Map<number, string>()
  // content_block_stop carries only an index, so remember which indexes opened as
  // thinking blocks to know whose span just closed. Cleared alongside the inputs.
  private readonly thinkingBlocks = new Set<number>()
  // The provider returns every tool result through the same shape. Remember
  // which calls launched subagents so their final answer can be marked before
  // the server projects ordinary output away.
  private readonly subagentToolIds = new Set<string>()

  get summary(): TurnSummary {
    return this.turnSummary
  }

  get editedFiles(): string[] {
    return [...this.editedFileSet]
  }

  push(raw: ClaudeEvent): NormalizedEvent[] {
    if (this.interrupted) return []

    const events: NormalizedEvent[] = []
    const checkpoint = checkpointEventSchema.safeParse(raw)
    if (checkpoint.success) {
      events.push({ type: 'checkpoint', checkpointId: checkpoint.data.uuid })
    }

    if (raw.type === 'result') {
      const denials = permissionDenialsSchema.safeParse(raw.permission_denials)
      if (denials.success && denials.data.length > 0) {
        this.turnSummary.permissionDenials = denials.data.map((denial) => ({
          tool_name: denial.tool_name || '',
          tool_use_id: denial.tool_use_id || '',
        }))
      }
    }

    if (raw.type === 'assistant') this.collectEditedFiles(raw.message?.content)

    const normalized = normalize(raw, this.pendingToolInputs, this.thinkingBlocks)
    for (const event of normalized) {
      if (event.type === 'tool_call' && event.isSubagent && event.toolId) {
        this.subagentToolIds.add(event.toolId)
      } else if (
        event.type === 'tool_result'
        && !event.isAsyncLaunch
        && this.subagentToolIds.delete(event.toolUseId)
      ) {
        event.isSubagentReport = true
      }
    }
    events.push(...normalized)
    return this.emit(events)
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
    }
    return events
  }

  private collectEditedFiles(content: ContentBlock[] | undefined): void {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type !== 'tool_use') continue
      if (block.name !== 'Write' && block.name !== 'Edit' && block.name !== 'NotebookEdit') continue
      const parsed = editedFileInputSchema.safeParse(block.input)
      const filePath = parsed.success
        ? parsed.data.file_path ?? parsed.data.notebook_path ?? null
        : null
      if (filePath) this.editedFileSet.add(filePath)
    }
  }
}

function normalizeSystem(event: InitEvent | StatusEvent | CompactBoundaryEvent): NormalizedEvent[] {
  // Sub-agents/tools that run as SDK "tasks" (the Task/Agent tool, backgroundable
  // Bash, etc.) settle out-of-band: the SDK keeps the query open, streaming task
  // lifecycle system messages until the work finishes. A task started up-front as
  // background (run_in_background) never emits an is_backgrounded transition — it
  // goes straight from task_started to task_notification — so track every task
  // from task_started through to whichever terminal signal it gets. Foreground
  // (blocking) tasks settle before the turn's own result fires, so this is a no-op
  // for them; it only changes behavior for tasks still in flight at turn end.
  // `tool_use_id` links a task back to the tool call that spawned it — the
  // sub-agent card's anchor. task_started and task_notification carry it;
  // task_updated doesn't, so the renderer keys settles off `taskId` instead.
  // SAFETY: The SDK system union omits documented task lifecycle subtypes that use this exact field contract.
  const sys = event as ClaudeTaskSystemEvent
  if (sys.subtype === 'task_started' && sys.task_id) {
    return [{ type: 'background_task_started', taskId: sys.task_id, toolUseId: sys.tool_use_id }]
  }
  if (sys.subtype === 'task_progress' && sys.task_id) {
    return [{
      type: 'background_task_progress',
      taskId: sys.task_id,
      toolUseId: sys.tool_use_id,
      description: sys.description,
      toolUses: sys.usage?.tool_uses,
      totalTokens: sys.usage?.total_tokens,
      durationMs: sys.usage?.duration_ms,
      lastToolName: sys.last_tool_name,
    }]
  }
  if (sys.subtype === 'task_updated' && sys.task_id) {
    const patchStatus = sys.patch?.status
    if (patchStatus === 'completed' || patchStatus === 'failed' || patchStatus === 'killed') {
      return [{ type: 'background_task_settled', taskId: sys.task_id, status: patchStatus, toolUseId: sys.tool_use_id }]
    }
    return []
  }
  if (sys.subtype === 'task_notification' && sys.task_id) {
    const status = sys.status === 'failed' || sys.status === 'stopped' ? sys.status : 'completed'
    return [{ type: 'background_task_settled', taskId: sys.task_id, status, toolUseId: sys.tool_use_id }]
  }

  if (event.subtype === 'init') {
    // SAFETY: The init subtype carries the InitEvent contract.
    const init = event as InitEvent
    return [{
      type: 'session_init',
      sessionId: init.session_id,
      model: init.model || 'unknown',
      skills: init.skills || [],
    }]
  }

  if (event.subtype === 'status') {
    // SAFETY: The status subtype carries the StatusEvent contract.
    const status = event as StatusEvent
    const uiMode = SDK_TO_UI_PERMISSION_MODE[status.permissionMode]
    if (uiMode) {
      return [{ type: 'permission_mode_changed', permissionMode: uiMode }]
    }
  }

  if (event.subtype === 'compact_boundary') {
    const compaction: Extract<NormalizedEvent, { type: 'context_compaction' }> = {
      type: 'context_compaction',
      state: 'stop',
      trigger: event.compact_metadata.trigger,
    }
    if (event.compact_metadata.duration_ms !== undefined) {
      compaction.durationMs = event.compact_metadata.duration_ms
    }
    return [compaction]
  }

  return []
}

function normalizeStreamEvent(
  event: StreamEvent,
  pendingToolInputs: Map<number, string>,
  thinkingBlocks: Set<number>,
): NormalizedEvent[] {
  const sub = event.event
  if (!sub) return []

  const parentToolUseId = event.parent_tool_use_id || undefined
  const events = normalizeStreamSub(sub, pendingToolInputs, thinkingBlocks)
  return parentToolUseId
    ? events.map((normalized) => parentSubagentEvent(normalized, parentToolUseId))
    : events
}

function normalizeStreamSub(
  sub: NonNullable<StreamEvent['event']>,
  pendingToolInputs: Map<number, string>,
  thinkingBlocks: Set<number>,
): SubagentTranscriptEvent[] {
  switch (sub.type) {
    case 'content_block_start': {
      if (sub.content_block.type === 'thinking') {
        thinkingBlocks.add(sub.index)
        return [{ type: 'thinking', state: 'start' }]
      }
      if (sub.content_block.type === 'tool_use') {
        pendingToolInputs.set(sub.index, '')
        const toolName = sub.content_block.name || 'unknown'
        const baseToolName = toolName.slice(toolName.lastIndexOf('.') + 1)
        return [{
          type: 'tool_call',
          toolName,
          toolId: sub.content_block.id || '',
          index: sub.index,
          ...(baseToolName === 'codex_subagent'
            ? { isSubagent: true, subagentType: 'codex' as const }
            : baseToolName === 'claude_subagent' || toolName === 'Task' || toolName === 'Agent'
              ? { isSubagent: true, subagentType: 'claude' as const }
              : {}),
        }]
      }
      // Text blocks arrive via deltas; the start event carries no user-facing data.
      return []
    }

    case 'content_block_delta': {
      // SAFETY: The content_block_delta subtype carries the ContentDelta union.
      const delta = sub.delta as ContentDelta
      if (delta.type === 'text_delta') {
        return [{ type: 'text_chunk', text: delta.text }]
      }
      if (delta.type === 'input_json_delta') {
        // Accumulate the tool's input; it's delivered whole on content_block_stop.
        pendingToolInputs.set(sub.index, (pendingToolInputs.get(sub.index) ?? '') + delta.partial_json)
        return []
      }
      // The thought itself is never surfaced — only its duration is.
      return []
    }

    case 'content_block_stop': {
      if (thinkingBlocks.delete(sub.index)) {
        return [{ type: 'thinking', state: 'stop' }]
      }
      const toolInput = pendingToolInputs.get(sub.index)
      pendingToolInputs.delete(sub.index)
      const event: NormalizedEvent = {
        type: 'tool_call_complete',
        index: sub.index,
      }
      if (toolInput) event.toolInput = toolInput
      return [event]
    }

    case 'message_start':
      // A fresh message resets content-block indexes; clear any stragglers.
      pendingToolInputs.clear()
      thinkingBlocks.clear()
      return []

    case 'message_delta':
    case 'message_stop':
      // Structural only; the assembled `assistant` event carries message-level state.
      return []

    default:
      return []
  }
}

function normalizeAssistant(event: AssistantEvent): NormalizedEvent[] {
  const parentToolUseId = event.parent_tool_use_id || undefined
  const events: NormalizedEvent[] = []

  // Every API call reports the prompt it just saw, which is the window as it
  // stands — so the meter tracks a turn as it runs, and still has a figure if
  // the SDK's exact `getContextUsage()` report is unavailable at the result.
  // A sub-agent runs its own window; letting its call overwrite the main
  // thread's meter would replace 150K of real context with the agent's 8K.
  if (!parentToolUseId) {
    const context = contextUsageFrom(event.message?.usage)
    if (context) events.push({ type: 'usage', context })
  }

  const content = event.message?.content
  if (Array.isArray(content)) {
    const text = content
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text!)
      .join('')
      .trim()
    if (text) {
      events.push(parentToolUseId
        ? { type: 'assistant_message', text, parentToolUseId }
        : { type: 'assistant_message', text })
    }

    content.forEach((block, index) => {
      // A sub-agent's TodoWrite is tagged with its parent so it lands on that
      // sub-agent's card instead of hijacking the main progress tracker, which
      // only the top-level agent (no parent) drives.
      if (block.type === 'tool_use' && block.name === 'TodoWrite') {
        const parsed = todoInputSchema.safeParse(block.input)
        if (parsed.success) {
          events.push({
            type: 'progress',
            todos: parsed.data.todos.map((todo) => ({
              content: todo.content || '',
              status: todo.status || 'pending',
            })),
            parentToolUseId,
          })
        }
      }

      // Sub-agents don't surface partial stream events, so their tool calls never
      // arrive as content_block_start. Synthesize a tool_call from the assembled
      // assistant message so the sub-agent card shows the tool and its later
      // tool_result has a target to land on. Main-thread tool calls already come
      // through as stream events, so only do this under a parent (never double-emit).
      if (block.type === 'tool_use' && parentToolUseId) {
        events.push({
          type: 'tool_call',
          toolName: block.name || 'unknown',
          toolId: block.id || '',
          index,
          toolInput: block.input !== undefined ? JSON.stringify(block.input) : '',
          parentToolUseId,
        })
      }
    })
  }

  return events
}

/**
 * The SDK delivers sub-agent tool results — and the parent Agent tool's own
 * result — as `type:'user'` messages carrying `tool_result` blocks. Emit a
 * canonical `tool_result` event for each so the reducer lands it on the matching
 * tool message instead of leaking a stray user bubble into the thread.
 *
 * A backgrounded sub-agent (the Task tool's default) is the exception: the SDK
 * answers the tool call within milliseconds with launch metadata ("Async agent
 * launched successfully…") and only reports the real outcome later, via a
 * task_notification. Flag that placeholder so the reducer doesn't read it as the
 * agent's answer and call the card done while the agent is still working.
 */
function normalizeUser(event: UserEvent): NormalizedEvent[] {
  const parentToolUseId = event.parent_tool_use_id || undefined
  const content = event.message?.content
  if (!Array.isArray(content)) return []

  const isAsyncLaunch = event.tool_use_result?.status === 'async_launched' || event.tool_use_result?.isAsync === true

  const events: NormalizedEvent[] = []
  for (const block of content) {
    if (block.type !== 'tool_result' || !block.tool_use_id) continue
    const result: NormalizedEvent = {
      type: 'tool_result',
      toolUseId: block.tool_use_id,
      content: claudeToolResultText(block.content),
      isError: block.is_error,
      parentToolUseId,
    }
    if (isAsyncLaunch) result.isAsyncLaunch = true
    events.push(result)
  }
  return events
}

/**
 * A result that only marks an aborted request, not the end of the turn. The SDK
 * reports the abort as an error result and then restarts its agent loop on the
 * same query, so this is a seam inside the turn, not the turn's outcome —
 * neither a user-visible error nor a reason to close the turn's input stream.
 *
 * Both reasons matter and the CLI itself treats them as one: `aborted_streaming`
 * when the abort lands while the model is streaming, `aborted_tools` when it
 * lands during tool execution.
 */
export function isAbortSeamResult(event: ResultEvent): boolean {
  return event.terminal_reason === 'aborted_streaming'
    || event.terminal_reason === 'aborted_tools'
}

/** Claude can automatically resume the parent when a background task reports
 *  back. The resulting `result` closes only that internal continuation; treating
 *  it as the user's task_complete resets the UI and can complete the session
 *  while sibling tasks are still running. */
export function isTaskNotificationResult(event: ResultEvent): boolean {
  return event.origin?.kind === 'task-notification'
}

/**
 * An error result carries no `result` text — the detail lives in `errors`, with
 * `subtype`/`terminal_reason` as the only clue when that array is empty. Reading
 * `result` here is what used to render every failure as a bare "Unknown error".
 */
function resultErrorMessage(event: ResultEvent): string {
  const errors = event.errors?.filter(Boolean).join('\n')
  if (errors) return errors
  if (event.result) return event.result
  return event.terminal_reason
    ? `${event.subtype} (${event.terminal_reason})`
    : event.subtype
}

function normalizeResult(event: ResultEvent): NormalizedEvent[] {
  if (isAbortSeamResult(event)) return []
  if (isTaskNotificationResult(event) && !event.is_error && event.subtype === 'success') return []

  if (event.is_error || event.subtype !== 'success') {
    const message = resultErrorMessage(event)
    const rateLimit = rateLimitEventFromMessage(message)
    if (rateLimit) return [rateLimit]
    return [{
      type: 'error',
      message,
      isError: true,
      sessionId: event.session_id,
    }]
  }

  const parsedDenials = permissionDenialsSchema.safeParse(event.permission_denials)
  const denials = parsedDenials.success
    ? parsedDenials.data.map((denial) => ({
        toolName: denial.tool_name || '',
        toolUseId: denial.tool_use_id || '',
      }))
    : undefined

  const completed: NormalizedEvent = {
    type: 'task_complete',
    result: event.result || '',
    costUsd: event.total_cost_usd || 0,
    durationMs: event.duration_ms || 0,
    numTurns: event.num_turns || 0,
    usage: normalizeClaudeUsage(event.usage),
    sessionId: event.session_id,
  }
  if (denials && denials.length > 0) completed.permissionDenials = denials
  return [completed]
}

/**
 * The prompt one API call sent: fresh input plus everything read from or written
 * to the cache. Output is excluded — it isn't in the window yet; it rolls into
 * the next call's input, which that call's own report already covers.
 */
function contextUsageFrom(usage: ClaudeUsageData | undefined): ContextUsage | null {
  if (!usage) return null
  const inputTokens = usage.input_tokens ?? 0
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0
  const usedTokens = inputTokens + cacheReadTokens + cacheCreationTokens
  if (usedTokens <= 0) return null
  return { usedTokens, inputTokens, cacheReadTokens, cacheCreationTokens }
}

function normalizeClaudeUsage(usage: ClaudeUsageData | undefined): UsageData {
  if (!usage) return {}
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    reasoningTokens: usage.reasoning_output_tokens,
  }
}

function normalizeRateLimit(event: RateLimitEvent): NormalizedEvent[] {
  const info = event.rate_limit_info
  if (!info) return []
  const resetsAt = normalizeResetNumber(info.resetsAt)
  if (!resetsAt) return []

  return [{
    type: 'rate_limit',
    status: info.status,
    resetsAt,
    rateLimitType: info.rateLimitType,
    isUsingOverage: info.isUsingOverage,
  }]
}

function normalizePermission(event: PermissionEvent): NormalizedEvent[] {
  const toolName = event.tool?.name || 'unknown'

  // ExitPlanMode marks a plan ready for review; upgrade it to a plan event for richer UI.
  if (toolName === 'ExitPlanMode') {
    const input = exitPlanInputSchema.parse(event.tool?.input || {})
    const plan = input.plan || ''
    const planFilePath = input.planFilePath || ''
    if (plan) {
      return [{
        type: 'plan',
        planContent: plan,
        planFilePath,
        questionId: event.question_id,
        planToolUseId: permissionToolSchema.parse(event.tool || {}).id || '',
        options: (event.options || []).map((o) => ({
          id: o.id,
          label: o.label,
          kind: o.kind,
        })),
      }]
    }
  }

  return [{
    type: 'permission_request',
    questionId: event.question_id,
    toolName,
    toolDescription: event.tool?.description,
    toolInput: event.tool?.input,
    options: (event.options || []).map((o) => ({
      id: o.id,
      label: o.label,
      kind: o.kind,
    })),
  }]
}
