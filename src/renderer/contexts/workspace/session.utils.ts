import type { Message, NormalizedEvent, PermissionRequest, PermissionOption, QuestionRequest, TodoItem, SessionProgress, Session, DiffComment, PlanComment } from '../../../shared/types'

let msgCounter = 0
export const nextMsgId = () => `msg-${++msgCounter}`

// Friendly labels for the in-app Solus MCP tools. Keyed by the bare tool name,
// which matches Codex directly and Claude after stripping the `mcp__solus__` prefix.
const SOLUS_TOOL_LABELS: Record<string, string> = {
  list_works: 'List works',
  search_works: 'Search works',
  read_work: 'Read work',
  create_work: 'Create work',
  update_work: 'Update work',
  render_artifact: 'Render artifact',
  create_session: 'Create session',
  codex_subagent: 'Codex subagent',
}

/** Returns the bare Solus tool key (e.g. "create_work") if `name` is a Solus tool, else null. */
export function solusToolKey(name: string): string | null {
  const key = name.startsWith('mcp__solus__') ? name.slice('mcp__solus__'.length) : name
  return key in SOLUS_TOOL_LABELS ? key : null
}

/** Display name for a tool: friendly Solus label when applicable, otherwise the raw name. */
export function prettyToolName(name: string): string {
  const key = solusToolKey(name)
  return key ? SOLUS_TOOL_LABELS[key] : name
}

export function findLastUserIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return -1
}

export function computeCurrentActivity(sess: Session): string {
  if (sess.permissionQueue.length > 0) return `Waiting for permission: ${sess.permissionQueue[0].toolTitle}`
  if (sess.questionQueue.length > 0) return 'Waiting for your input...'
  if (sess.isStreamingText) return 'Writing...'
  if (sess.isReconnecting) return 'Reconnecting...'
  if (sess.status === 'connecting') return 'Starting...'
  if (sess.status === 'running') {
    for (let i = sess.messages.length - 1; i >= 0; i--) {
      const m = sess.messages[i]
      if (m.role === 'tool' && m.toolStatus === 'running' && m.toolName) return `Running ${prettyToolName(m.toolName)}...`
    }
    return 'Thinking...'
  }
  if (sess.status === 'dead') return 'Session ended'
  return ''
}

export function normalizeTodoStatus(status: unknown): TodoItem['status'] {
  if (typeof status !== 'string') return 'pending'

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
  return {
    questionId: event.questionId,
    questions: event.questions,
  }
}

export function progressFromTodos(todos: TodoItem[]): SessionProgress {
  const currentStep = todos.filter((t) => t.status === 'completed').length
  return { todos, currentStep, totalSteps: todos.length }
}

export function parseToolInput(input: string): unknown {
  const parsed = JSON.parse(input)
  if (typeof parsed !== 'string') return parsed

  const trimmed = parsed.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return parsed
  try {
    return JSON.parse(trimmed)
  } catch {
    return parsed
  }
}

function todoContent(value: any): string {
  return String(value?.content || value?.step || value?.text || value?.description || value?.title || '').trim()
}

function todosFromList(items: unknown): TodoItem[] | null {
  if (!Array.isArray(items)) return null

  const todos: TodoItem[] = items
    .map((t: any) => ({
      content: todoContent(t),
      status: normalizeTodoStatus(t?.status),
    }))
    .filter((t) => t.content)

  return todos.length > 0 ? todos : null
}

export function progressTodosFromTool(toolName: string | undefined, toolInput: string | undefined): TodoItem[] | null {
  if (!toolName || !toolInput) return null

  const normalizedToolName = toolName.trim().toLowerCase()
  const isTodoWrite = normalizedToolName === 'todowrite'
  const isCodexPlanUpdate = normalizedToolName === 'update_plan' || normalizedToolName.endsWith('.update_plan')
  if (!isTodoWrite && !isCodexPlanUpdate) return null

  const input = parseToolInput(toolInput)
  if (!input || typeof input !== 'object') return null

  if (isTodoWrite) return todosFromList((input as any).todos)
  return todosFromList((input as any).plan ?? (input as any).todos)
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

export function formatInlineComments(comments: PlanComment[]): string {
  return comments
    .map((c) =>
      c.nodeId
        ? `- On node "${c.selectedText}" (node id: ${c.nodeId}): ${c.comment}`
        : `- On "${c.selectedText}": ${c.comment}`,
    )
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
