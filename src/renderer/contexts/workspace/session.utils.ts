import type { Message, NormalizedEvent, PermissionRequest, PermissionOption, QuestionRequest, RuntimeSessionInfo, TodoItem, SessionProgress, Session, DiffComment, PlanComment } from '../../../shared/types'
import { z } from 'zod'

let msgCounter = 0
export const nextMsgId = () => `msg-${++msgCounter}`

export const AGENT_INTERRUPT_NOTICE = '[Request interrupted by user]'

const AGENT_NOTICE_RE = /^\s*\[(request interrupted|request cancelled|request canceled)[^\]]*\]\s*$/i

/**
 * A turn the provider was told not to answer. It arrives as ordinary assistant
 * text — unbracketed — so nothing else marks it as machine-written, and the
 * bracketed form turns up on the user side of a resumed transcript.
 */
const NO_REPLY_RE = /^\s*\[?\s*no response requested\.?\s*\]?\s*$/i

/** A no-reply turn is a state of the run, not an answer to print as prose. */
export function isNoReplyNotice(content: string): boolean {
  return NO_REPLY_RE.test(content)
}

/** Notices the agent SDK injects to keep its transcript valid — nobody typed them. */
export function isAgentNotice(content: string): boolean {
  return AGENT_NOTICE_RE.test(content) || NO_REPLY_RE.test(content)
}

// In-app tools available to Solus agents. Keys use the bare Codex name; Claude
// prefixes the same tools with `mcp__solus__`.
const SOLUS_TOOL_KEYS = new Set([
  'list_works',
  'search_works',
  'read_work',
  'create_work',
  'update_work',
  'render_artifact',
  'create_automation',
  'list_automations',
  'read_automation',
  'update_automation',
  'delete_automation',
  'set_automation_enabled',
  'run_automation',
  'list_automation_runs',
  'read_automation_run',
  'list_sessions',
  'read_session',
  'search_sessions',
  'create_session',
  'prompt_session',
  'wait_for_session',
  'stop_session',
  'list_tasks',
  'read_task',
  'update_task_status',
  'create_task',
  'comment_task',
  'link_task_session',
  'link_task',
  'list_prs',
  'read_pr',
  'list_pr_threads',
  'reply_pr_thread',
  'resolve_pr_thread',
  'submit_pr_review',
  'submit_review_guide',
  'get_goal',
  'create_goal',
  'update_goal',
  'claude_subagent',
  'codex_subagent',
])

// Friendly labels where the product has intentionally named the action.
const SOLUS_TOOL_LABELS = new Map([
  ['list_works', 'List works'],
  ['search_works', 'Search works'],
  ['read_work', 'Read work'],
  ['create_work', 'Create work'],
  ['update_work', 'Update work'],
  ['render_artifact', 'Render artifact'],
  ['create_session', 'Create session'],
  ['codex_subagent', 'Codex subagent'],
])

/** Returns the bare Solus tool key (e.g. "create_work") if `name` is a Solus tool, else null. */
export function solusToolKey(name: string): string | null {
  const key = name.startsWith('mcp__solus__') ? name.slice('mcp__solus__'.length) : name
  return SOLUS_TOOL_KEYS.has(key) ? key : null
}

/** Display name for a tool: friendly Solus label when applicable, otherwise the raw name. */
export function prettyToolName(name: string): string {
  const key = solusToolKey(name)
  return key ? (SOLUS_TOOL_LABELS.get(key) ?? key) : name
}

export function findLastUserIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return -1
}

/** The most specific user-facing label for a live session's current phase. */
export function computeCurrentActivity(session: Session): string {
  if (session.permissionQueue.length > 0) return `Waiting for permission: ${session.permissionQueue[0].toolTitle}`
  if (session.questionQueue.length > 0) return 'Waiting for your input...'
  if (session.isStreamingText) return 'Writing...'
  if (session.isReconnecting) return 'Reconnecting...'
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i]
    if (message.role === 'tool' && message.toolStatus === 'running' && message.toolName) {
      return `Running ${prettyToolName(message.toolName)}...`
    }
  }
  if (session.currentActivity) return session.currentActivity
  if (session.status === 'connecting') return session.agentSessionId ? 'Resuming...' : 'Starting session...'
  if (session.status === 'running') return 'Thinking...'
  if (session.status === 'dead') return 'Session ended'
  return ''
}

export function normalizeTodoStatus(status: string | undefined): TodoItem['status'] {
  if (status === undefined) return 'pending'
  const normalized = status.trim().replace(/[\s-]/g, '_').toLowerCase()
  if (normalized === 'completed' || normalized === 'pending') return normalized
  if (normalized === 'in_progress' || normalized === 'inprogress') return 'in_progress'
  if (normalized === 'complete' || normalized === 'done' || normalized === 'success') return 'completed'
  if (normalized === 'running' || normalized === 'active' || normalized === 'current') return 'in_progress'
  return 'pending'
}

export function toPermissionRequest(event: Extract<NormalizedEvent, { type: 'permission_request' }>): PermissionRequest {
  return {
    questionId: event.questionId,
    toolTitle: event.toolName,
    toolDescription: event.toolDescription,
    toolInput: event.toolInput,
    options: event.options.map((o: PermissionOption) => ({
      optionId: o.id,
      kind: o.kind,
      label: o.label,
    })),
  }
}

export function toQuestionRequest(event: Extract<NormalizedEvent, { type: 'question_request' }>): QuestionRequest {
  const request: QuestionRequest = {
    questionId: event.questionId,
    questions: event.questions,
  }
  if (event.kind) request.kind = event.kind
  return request
}

export function progressFromTodos(todos: TodoItem[]): SessionProgress {
  const currentStep = todos.filter((t) => t.status === 'completed').length
  return { todos, currentStep, totalSteps: todos.length }
}

const rawTodoSchema = z.object({
  content: z.string().optional(),
  step: z.string().optional(),
  text: z.string().optional(),
  description: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
})

const todoToolInputSchema = z.object({
  todos: z.array(rawTodoSchema).optional(),
  plan: z.array(rawTodoSchema).optional(),
})

type RawTodo = z.infer<typeof rawTodoSchema>
type TodoToolInput = z.infer<typeof todoToolInputSchema>

function todoContent(value: RawTodo): string {
  return (value.content || value.step || value.text || value.description || value.title || '').trim()
}

function todosFromList(items: RawTodo[] | undefined): TodoItem[] | null {
  if (!items) return null
  const todos: TodoItem[] = items
    .map((todo) => ({
      content: todoContent(todo),
      status: normalizeTodoStatus(todo.status),
    }))
    .filter((todo) => todo.content)

  return todos.length > 0 ? todos : null
}

function parseTodoToolInput(input: string): TodoToolInput | null {
  const decoded = JSON.parse(input)
  const direct = todoToolInputSchema.safeParse(decoded)
  if (direct.success) return direct.data
  const encoded = z.string().safeParse(decoded)
  if (!encoded.success) return null
  const trimmed = encoded.data.trim()
  if (!trimmed.startsWith('{')) return null
  const nested = todoToolInputSchema.safeParse(JSON.parse(trimmed))
  return nested.success ? nested.data : null
}

export function progressTodosFromTool(toolName: string | undefined, toolInput: string | undefined): TodoItem[] | null {
  if (!toolName || !toolInput) return null

  const normalizedToolName = toolName.trim().toLowerCase()
  const isTodoWrite = normalizedToolName === 'todowrite'
  const isCodexPlanUpdate = normalizedToolName === 'update_plan' || normalizedToolName.endsWith('.update_plan')
  if (!isTodoWrite && !isCodexPlanUpdate) return null

  const input = parseTodoToolInput(toolInput)
  if (!input) return null

  if (isTodoWrite) return todosFromList(input.todos)
  return todosFromList(input.plan ?? input.todos)
}

export function progressFromMessages(messages: Message[]): SessionProgress | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    try {
      const todos = progressTodosFromTool(msg.toolName, msg.toolInput)
      if (todos) return progressFromTodos(todos)
    } catch { /* malformed input */ }
  }
  return null
}

export function removeAssistantPlanDuplicate(messages: Message[], planContent: string): void {
  const planText = planContent.trim()
  if (!planText) return

  const lastUserIdx = findLastUserIndex(messages)
  for (let i = messages.length - 1; i > lastUserIdx; i--) {
    const message = messages[i]
    if (message.role !== 'assistant' || message.toolName) continue

    const trimmedContent = message.content.trim()
    if (trimmedContent === planText) {
      messages.splice(i, 1)
      return
    }

    const contentWithoutTrailingWhitespace = message.content.trimEnd()
    if (!contentWithoutTrailingWhitespace.endsWith(planText)) continue

    const remaining = contentWithoutTrailingWhitespace.slice(0, -planText.length).trimEnd()
    if (remaining) {
      message.content = remaining
    } else {
      messages.splice(i, 1)
    }
    return
  }
}

/**
 * A thread as the agent reads it. Resolved threads are dropped — they have
 * been dealt with, and re-sending them reads as a fresh request. Replies come
 * through indented, so a conversation the agent is joining mid-way still has
 * its shape.
 */
export function formatInlineComments(comments: PlanComment[]): string {
  return comments
    .filter((c) => !c.resolvedAt)
    .map((c) => {
      const head = c.nodeId
        ? `- On node "${c.selectedText}" (node id: ${c.nodeId}): ${c.comment}`
        : `- On "${c.selectedText}": ${c.comment}`
      const replies = (c.replies ?? []).map(
        (r) => `  - ${r.author === 'solus' ? 'Solus' : 'User'}: ${r.text}`,
      )
      return [head, ...replies].join('\n')
    })
    .join('\n')
}

function normalizeDiffSelectedCode(code: string): string {
  return code
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, (newlines, offset, source) => {
      if (offset + newlines.length === source.length) return ''
      return '\n'.repeat(Math.ceil(newlines.length / 2))
    })
}

export function formatDiffInlineComments(comments: DiffComment[]): string {
  return comments
    .map((c) => {
      const range = c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}–L${c.endLine}`
      const selectedCode = normalizeDiffSelectedCode(c.selectedCode)
      const codeBlock = selectedCode ? `\n\`\`\`\n${selectedCode}\n\`\`\`` : ''
      return `- ${c.filePath} ${range}:${codeBlock}\n  ${c.comment}`
    })
    .join('\n')
}

export function hasConversation(session: Session): boolean {
  return session.messages.some(m => m.role === 'user' || m.role === 'assistant')
}

/** Reattach hands back the live run's config so a restored tab stops guessing.
 *  A session whose run contract was lost still reattaches, reporting the config
 *  as null — the tab then keeps the values it restored from its own snapshot
 *  rather than being reset to whatever a bare default would be. */
export function applyRuntimeConfig(session: Session, info: RuntimeSessionInfo): void {
  if (info.modelConfig) {
    session.run.modelConfig.modelId = info.modelConfig.modelId
    session.run.modelConfig.reasoningEffort = info.modelConfig.reasoningEffort
    session.run.modelConfig.contextWindow = info.modelConfig.contextWindow
    session.run.modelConfig.fastMode = info.modelConfig.fastMode
  }
  if (info.permissionMode) session.run.permissionMode = info.permissionMode
}
