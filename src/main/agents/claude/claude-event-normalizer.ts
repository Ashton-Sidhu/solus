import type { NormalizedEvent, ContentDelta } from '../../../shared/types'
import type { ClaudeEvent, StreamEvent, InitEvent, StatusEvent, AssistantEvent, UserEvent, ResultEvent, RateLimitEvent, PermissionEvent } from '../../../shared/claude-types'

const SDK_TO_UI_PERMISSION_MODE: Record<string, 'ask' | 'auto' | 'plan'> = {
  default: 'ask',
  acceptEdits: 'auto',
  plan: 'plan',
}

/**
 * Maps raw Claude stream-json events to canonical SOLUS events.
 * Stateless: one raw in, zero or more normalized out. Sequencing/routing lives in ClaudeAgent.
 */
export function normalize(raw: ClaudeEvent): NormalizedEvent[] {
  switch (raw.type) {
    case 'system':
      return normalizeSystem(raw as InitEvent)

    case 'stream_event':
      return normalizeStreamEvent(raw as StreamEvent)

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
      tools: init.tools || [],
      model: init.model || 'unknown',
      mcpServers: init.mcp_servers || [],
      skills: init.skills || [],
      version: init.claude_code_version || 'unknown',
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

function normalizeStreamEvent(event: StreamEvent): NormalizedEvent[] {
  const sub = event.event
  if (!sub) return []

  // Sub-agent (Agent/Task) tool calls and text stream through the same query
  // tagged with the originating tool call. Thread it onto every emitted event so
  // the reducer can divert them into the parent tool's nested transcript.
  const parentToolUseId = event.parent_tool_use_id || undefined

  const events = normalizeStreamSub(sub)
  if (parentToolUseId) {
    for (const e of events) (e as { parentToolUseId?: string }).parentToolUseId = parentToolUseId
  }
  return events
}

function normalizeStreamSub(sub: NonNullable<StreamEvent['event']>): NormalizedEvent[] {
  switch (sub.type) {
    case 'content_block_start': {
      if (sub.content_block.type === 'tool_use') {
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
        return [{
          type: 'tool_call_update',
          toolId: '',
          index: sub.index,
          toolInput: delta.partial_json,
          toolInputDelta: true,
        }]
      }
      return []
    }

    case 'content_block_stop': {
      return [{
        type: 'tool_call_complete',
        index: sub.index,
      }]
    }

    case 'message_start':
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
  const events: NormalizedEvent[] = [{ type: 'task_update', message: event.message, parentToolUseId }]

  const content = event.message?.content
  if (Array.isArray(content)) {
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
    usage: event.usage || {},
    sessionId: event.session_id,
    ...(denials && denials.length > 0 ? { permissionDenials: denials } : {}),
  }]
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

function normalizeResetNumber(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  if (value > 10_000_000_000) return Math.ceil(value / 1000)
  const nowSeconds = Date.now() / 1000
  if (value > nowSeconds - 60) return Math.ceil(value)
  return Math.ceil(nowSeconds + value)
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
