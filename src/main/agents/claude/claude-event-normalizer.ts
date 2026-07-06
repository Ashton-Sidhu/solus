import type { NormalizedEvent, UsageData } from '../../../shared/types'
import type { ClaudeEvent, StreamEvent, InitEvent, StatusEvent, AssistantEvent, UserEvent, ResultEvent, RateLimitEvent, PermissionEvent, ContentBlock, ContentDelta, ClaudeUsageData } from '../../../shared/claude-types'
import type { TurnNormalizer, TurnSummary } from '../turn-normalizer'
import { normalizeResetNumber } from '../../rate-limits'

const SDK_TO_UI_PERMISSION_MODE: Record<string, 'ask' | 'auto' | 'plan'> = {
  default: 'ask',
  acceptEdits: 'auto',
  plan: 'plan',
}

/**
 * Maps raw Claude stream-json events to canonical SOLUS events.
 * Mostly stateless (one raw in, zero or more normalized out), except that a
 * main-thread tool's input arrives only as `input_json_delta` stream events —
 * those accumulate into `pendingToolInputs` (keyed by content-block index) so the
 * complete input can ride out on `tool_call_complete`. Sequencing/routing lives
 * in ClaudeAgent.
 */
function normalize(raw: ClaudeEvent, pendingToolInputs: Map<number, string>): NormalizedEvent[] {
  switch (raw.type) {
    case 'system':
      return normalizeSystem(raw as InitEvent)

    case 'stream_event':
      return normalizeStreamEvent(raw as StreamEvent, pendingToolInputs)

    case 'assistant':
      return normalizeAssistant(raw as AssistantEvent)

    case 'user':
      return normalizeUser(raw as UserEvent)

    case 'result':
      return normalizeResult(raw as ResultEvent)

    case 'rate_limit_event':
      return normalizeRateLimit(raw as RateLimitEvent)

    case 'permission_request':
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

  get summary(): TurnSummary {
    return this.turnSummary
  }

  get editedFiles(): string[] {
    return [...this.editedFileSet]
  }

  push(raw: ClaudeEvent): NormalizedEvent[] {
    if (this.interrupted) return []

    const events: NormalizedEvent[] = []
    if ((raw as any).type === 'user' && (raw as any).uuid) {
      events.push({ type: 'checkpoint', checkpointId: (raw as any).uuid })
    }

    if (raw.type === 'result') {
      const denials = (raw as any).permission_denials
      if (Array.isArray(denials) && denials.length > 0) {
        this.turnSummary.permissionDenials = denials.map((d: any) => ({
          tool_name: d.tool_name || '',
          tool_use_id: d.tool_use_id || '',
        }))
      }
    }

    if (raw.type === 'assistant') this.collectEditedFiles(raw.message?.content)

    events.push(...normalize(raw, this.pendingToolInputs))
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
      const input = block.input
      const filePath = typeof input?.file_path === 'string'
        ? input.file_path
        : typeof input?.notebook_path === 'string'
          ? input.notebook_path
          : null
      if (filePath) this.editedFileSet.add(filePath)
    }
  }
}

function normalizeSystem(event: InitEvent | StatusEvent): NormalizedEvent[] {
  // Sub-agents/tools that run as SDK "tasks" (the Task/Agent tool, backgroundable
  // Bash, etc.) settle out-of-band: the SDK keeps the query open, streaming task
  // lifecycle system messages until the work finishes. A task started up-front as
  // background (run_in_background) never emits an is_backgrounded transition — it
  // goes straight from task_started to task_notification — so track every task
  // from task_started through to whichever terminal signal it gets. Foreground
  // (blocking) tasks settle before the turn's own result fires, so this is a no-op
  // for them; it only changes behavior for tasks still in flight at turn end.
  const sys = event as unknown as {
    subtype: string
    task_id?: string
    status?: string
    patch?: { status?: string }
  }
  if (sys.subtype === 'task_started' && sys.task_id) {
    return [{ type: 'background_task_started', taskId: sys.task_id }]
  }
  if (sys.subtype === 'task_updated' && sys.task_id) {
    const patchStatus = sys.patch?.status
    if (patchStatus === 'completed' || patchStatus === 'failed' || patchStatus === 'killed') {
      return [{ type: 'background_task_settled', taskId: sys.task_id, status: patchStatus }]
    }
    return []
  }
  if (sys.subtype === 'task_notification' && sys.task_id) {
    const status = sys.status === 'failed' || sys.status === 'stopped' ? sys.status : 'completed'
    return [{ type: 'background_task_settled', taskId: sys.task_id, status }]
  }

  if (event.subtype === 'init') {
    const init = event as InitEvent
    return [{
      type: 'session_init',
      sessionId: init.session_id,
      model: init.model || 'unknown',
      skills: init.skills || [],
    }]
  }

  if (event.subtype === 'status') {
    const status = event as StatusEvent
    const uiMode = SDK_TO_UI_PERMISSION_MODE[status.permissionMode]
    if (uiMode) {
      return [{ type: 'permission_mode_changed', permissionMode: uiMode }]
    }
  }

  return []
}

function normalizeStreamEvent(event: StreamEvent, pendingToolInputs: Map<number, string>): NormalizedEvent[] {
  const sub = event.event
  if (!sub) return []

  // Sub-agent (Agent/Task) tool calls stream through the same query tagged with
  // the originating tool call. Thread it onto every emitted event so the reducer
  // can divert them into the parent tool's nested transcript. Sub-agent prose no
  // longer streams — it arrives complete via the parented `assistant_message` that
  // `normalizeAssistant` emits — so drop any parented `text_chunk` here.
  const parentToolUseId = event.parent_tool_use_id || undefined

  const events = normalizeStreamSub(sub, pendingToolInputs)
  if (parentToolUseId) {
    const parented = events.filter((e) => e.type !== 'text_chunk')
    for (const e of parented) (e as { parentToolUseId?: string }).parentToolUseId = parentToolUseId
    return parented
  }
  return events
}

function normalizeStreamSub(sub: NonNullable<StreamEvent['event']>, pendingToolInputs: Map<number, string>): NormalizedEvent[] {
  switch (sub.type) {
    case 'content_block_start': {
      if (sub.content_block.type === 'tool_use') {
        pendingToolInputs.set(sub.index, '')
        return [{
          type: 'tool_call',
          toolName: sub.content_block.name || 'unknown',
          toolId: sub.content_block.id || '',
          index: sub.index,
        }]
      }
      // Text blocks arrive via deltas; the start event carries no user-facing data.
      return []
    }

    case 'content_block_delta': {
      const delta = sub.delta as ContentDelta
      if (delta.type === 'text_delta') {
        return [{ type: 'text_chunk', text: delta.text }]
      }
      if (delta.type === 'input_json_delta') {
        // Accumulate the tool's input; it's delivered whole on content_block_stop.
        pendingToolInputs.set(sub.index, (pendingToolInputs.get(sub.index) ?? '') + delta.partial_json)
        return []
      }
      return []
    }

    case 'content_block_stop': {
      const toolInput = pendingToolInputs.get(sub.index)
      pendingToolInputs.delete(sub.index)
      return [{
        type: 'tool_call_complete',
        index: sub.index,
        ...(toolInput ? { toolInput } : {}),
      }]
    }

    case 'message_start':
      // A fresh message resets content-block indexes; clear any stragglers.
      pendingToolInputs.clear()
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
      // A sub-agent's TodoWrite must not hijack the main progress tracker — only
      // the top-level agent (no parent) drives it.
      if (block.type === 'tool_use' && block.name === 'TodoWrite' && !parentToolUseId) {
        const todos = (block.input as any)?.todos
        if (Array.isArray(todos)) {
          events.push({
            type: 'progress',
            todos: todos.map((t: any) => ({
              content: String(t.content || ''),
              status: t.status || 'pending',
            })),
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
 */
function normalizeUser(event: UserEvent): NormalizedEvent[] {
  const parentToolUseId = event.parent_tool_use_id || undefined
  const content = event.message?.content
  if (!Array.isArray(content)) return []

  const events: NormalizedEvent[] = []
  for (const block of content) {
    if (block.type !== 'tool_result' || !block.tool_use_id) continue
    const text = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
        : ''
    events.push({
      type: 'tool_result',
      toolUseId: block.tool_use_id,
      content: text,
      isError: block.is_error,
      parentToolUseId,
    })
  }
  return events
}

function normalizeResult(event: ResultEvent): NormalizedEvent[] {
  if (event.is_error || event.subtype === 'error') {
    return [{
      type: 'error',
      message: event.result || 'Unknown error',
      isError: true,
      sessionId: event.session_id,
    }]
  }

  const denials = Array.isArray((event as any).permission_denials)
    ? (event as any).permission_denials.map((d: any) => ({
        toolName: d.tool_name || '',
        toolUseId: d.tool_use_id || '',
      }))
    : undefined

  return [{
    type: 'task_complete',
    result: event.result || '',
    costUsd: event.total_cost_usd || 0,
    durationMs: event.duration_ms || 0,
    numTurns: event.num_turns || 0,
    usage: normalizeClaudeUsage(event.usage),
    sessionId: event.session_id,
    ...(denials && denials.length > 0 ? { permissionDenials: denials } : {}),
  }]
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
    const input = (event.tool?.input || {}) as any
    const plan: string = input.plan || ''
    const planFilePath: string = input.planFilePath || ''
    if (plan) {
      return [{
        type: 'plan',
        planContent: plan,
        planFilePath,
        questionId: event.question_id,
        planToolUseId: (event.tool as any)?.id || '',
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
