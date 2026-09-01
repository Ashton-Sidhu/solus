import { z } from 'zod'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { createLogger } from '../logger'
import { getTask, updateTask, listTasks, createTask, postTaskComment, linkTaskSessionAndNotify, formatTaskForAgent } from './task-service'
import type { Task, TaskKind, TaskPriority, TaskStatus } from '../../shared/task-types'

const log = createLogger('main', 'task-tools.ts')

/**
 * Agent-facing task tools for long-running sessions: re-fetch the bound ticket
 * (`get_task`) and move it (`update_task_status`). Like work-tools.ts and
 * automation-tools.ts, one set of zod shapes is exported in three shapes — Claude
 * SDK `tool()` objects, Codex JSON-schema descriptors, and a shared executor —
 * so both backends call identical logic. The provider is resolved per-cwd by
 * task-service, so these are bound to the calling session's working directory.
 * Tools return error TEXT (never throw) so a bad call degrades to a recoverable
 * message rather than killing the turn.
 */

const STATUS_VALUES = ['open', 'in_progress', 'done'] as const
const LIST_STATUS_VALUES = ['open', 'in_progress', 'done', 'all'] as const
const PRIORITY_VALUES = ['urgent', 'high', 'medium', 'low'] as const
const KIND_VALUES = ['task', 'epic'] as const

// ─── Schemas ───

const getTaskShape = {
  task_id: z
    .string()
    .describe('Provider-native task id — the GitHub issue number, or the local task uuid. The bound task id is in the session\'s task context.'),
}

const updateStatusShape = {
  task_id: z.string().describe('The id of the task to move (the bound task, or one from its context).'),
  status: z
    .enum(STATUS_VALUES)
    .describe("New status: 'open', 'in_progress', or 'done'. On GitHub this maps to the in-progress label / closing the issue; locally it sets the stored status."),
}

const listTasksShape = {
  status: z
    .enum(LIST_STATUS_VALUES)
    .optional()
    .describe("Filter by task status. Defaults to 'all'."),
  assigned_to_me: z
    .boolean()
    .optional()
    .describe('When true, only list tasks assigned to the current GitHub user when the provider supports it.'),
}

const createTaskShape = {
  title: z.string().describe('Task title.'),
  body: z.string().optional().describe('Task body/description in markdown.'),
  kind: z.enum(KIND_VALUES).optional().describe("Task kind. Defaults to 'task'."),
  parent_id: z.string().optional().describe('Optional parent epic/task id.'),
  priority: z.enum(PRIORITY_VALUES).optional().describe('Optional priority.'),
  labels: z.array(z.string()).optional().describe('Optional labels.'),
  due_date: z.string().optional().describe('Optional ISO due date, usually YYYY-MM-DD.'),
}

const commentTaskShape = {
  task_id: z.string().describe('The id of the task to comment on.'),
  body: z.string().describe('Comment body in markdown.'),
}

const linkTaskSessionShape = {
  task_id: z.string().describe('The id of the task to link.'),
  session_id: z.string().optional().describe('The Solus agent session id to link. Defaults to the calling session.'),
}

// ─── Descriptions ───

const GET_DESC =
  "Re-fetch a task (ticket) by id, hydrated with its latest description, status, comments, and linked pull requests. Use this to refresh the ticket a long-running session is working on — the version injected at session start can go stale."
const UPDATE_DESC =
  "Move a task to a new status, writing it back to the provider: 'in_progress' marks it in progress (GitHub: adds the in-progress label), 'done' closes/completes it, 'open' reopens it. Narrow, intentional write-back — only status changes are pushed upstream."
const LIST_TASKS_DESC =
  "List tasks for this project through the configured provider. Use this to inspect the durable task queue before choosing or creating work."
const CREATE_TASK_DESC =
  "Create a new task in this project's configured task provider. Returns the created task id and details; a task card appears in the conversation."
const COMMENT_TASK_DESC =
  "Post a comment to a task in this project's configured provider. Use this to leave durable findings, status, or handoff notes."
const LINK_TASK_SESSION_DESC =
  "Link a task to a Solus agent session in the local Solus task/session map. Defaults to the calling session when session_id is omitted."

// ─── Executor (shared by Claude SDK tools + Codex handler) ───

export interface TaskToolCtx {
  /** The calling session's working directory — selects the provider. */
  cwd: string
  sessionId?: string
}

export interface TaskToolDeps {
  ctx: TaskToolCtx
  onTaskCreated?: OnTaskCreated
}

export interface TaskToolResult {
  ok: boolean
  text: string
}

export interface TaskCreatedPayload {
  taskId: string
  title: string
  url: string | null
}

export type OnTaskCreated = (task: TaskCreatedPayload) => void

export async function executeTaskTool(
  name: string,
  args: Record<string, unknown>,
  deps: TaskToolDeps,
): Promise<TaskToolResult> {
  const cwd = deps.ctx.cwd
  try {
    if (name === 'list_tasks') {
      const status = String(args.status ?? 'all')
      if (!(LIST_STATUS_VALUES as readonly string[]).includes(status)) {
        return { ok: false, text: `list_tasks: status must be one of ${LIST_STATUS_VALUES.join(', ')}.` }
      }
      const result = await listTasks(cwd, { assignedToMe: args.assigned_to_me === true })
      const filtered = status === 'all' ? result.tasks : result.tasks.filter((task) => task.status === status)
      const shown = filtered.slice(0, 50)
      const lines = shown.map((task) => {
        const meta = [task.priority ?? 'no priority', task.assignee ?? 'unassigned'].join(', ')
        return `${task.id}  [${task.status}]  ${task.title}  (${meta})`
      })
      const notes: string[] = []
      if (result.truncated) notes.push('provider result was truncated')
      if (result.fromCache) notes.push('served from cache')
      if (filtered.length > shown.length) notes.push(`showing 50 of ${filtered.length}`)
      const suffix = notes.length ? `\n\nNote: ${notes.join('; ')}.` : ''
      return { ok: true, text: lines.length ? `Tasks:\n${lines.join('\n')}${suffix}` : `No tasks matched.${suffix}` }
    }

    if (name === 'get_task') {
      const id = String(args.task_id ?? '').trim()
      if (!id) return { ok: false, text: 'get_task requires a task_id.' }
      const task = await getTask(cwd, id)
      return {
        ok: true,
        text: formatTaskForAgent(task, {
          heading: `${task.kind === 'epic' ? 'Epic' : 'Task'} ${task.id} — "${task.title}"`,
          includeStatus: true,
          includeHierarchy: true,
        }),
      }
    }

    if (name === 'update_task_status') {
      const id = String(args.task_id ?? '').trim()
      if (!id) return { ok: false, text: 'update_task_status requires a task_id.' }
      const status = String(args.status ?? '')
      if (!(STATUS_VALUES as readonly string[]).includes(status)) {
        return { ok: false, text: `update_task_status: status must be one of ${STATUS_VALUES.join(', ')}.` }
      }
      const updated = await updateTask(cwd, id, { status: status as TaskStatus })
      return { ok: true, text: `Task ${updated.id} is now "${updated.status}".` }
    }

    if (name === 'create_task') {
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      if (!title) return { ok: false, text: 'create_task requires a non-empty title.' }
      const labels = Array.isArray(args.labels)
        ? args.labels.map((label) => String(label).trim()).filter(Boolean)
        : undefined
      const input: Partial<Task> = {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        kind: (KIND_VALUES as readonly string[]).includes(String(args.kind)) ? args.kind as TaskKind : 'task',
        parentId: typeof args.parent_id === 'string' && args.parent_id.trim() ? args.parent_id.trim() : undefined,
        priority: (PRIORITY_VALUES as readonly string[]).includes(String(args.priority)) ? args.priority as TaskPriority : undefined,
        labels,
        dueDate: typeof args.due_date === 'string' && args.due_date.trim() ? args.due_date.trim() : undefined,
      }
      const task = await createTask(cwd, input)
      deps.onTaskCreated?.({ taskId: task.id, title: task.title, url: task.url })
      return {
        ok: true,
        text: formatTaskForAgent(task, {
          heading: `${task.kind === 'epic' ? 'Epic' : 'Task'} ${task.id} — "${task.title}"`,
          includeStatus: true,
          includeHierarchy: true,
        }),
      }
    }

    if (name === 'comment_task') {
      const id = String(args.task_id ?? '').trim()
      if (!id) return { ok: false, text: 'comment_task requires a task_id.' }
      const body = typeof args.body === 'string' ? args.body.trim() : ''
      if (!body) return { ok: false, text: 'comment_task requires a non-empty body.' }
      const task = await postTaskComment(cwd, id, body)
      return { ok: true, text: `Comment posted to task ${task.id}.` }
    }

    if (name === 'link_task_session') {
      const taskId = String(args.task_id ?? '').trim()
      if (!taskId) return { ok: false, text: 'link_task_session requires a task_id.' }
      const sessionId = typeof args.session_id === 'string' && args.session_id.trim()
        ? args.session_id.trim()
        : deps.ctx.sessionId
      if (!sessionId) return { ok: false, text: 'link_task_session requires session_id when no calling session id is available.' }
      await linkTaskSessionAndNotify(cwd, taskId, sessionId)
      return { ok: true, text: `Linked task ${taskId} to session ${sessionId}.` }
    }

    return { ok: false, text: `Unknown task tool: ${name}` }
  } catch (err: any) {
    log.error(`executeTaskTool(${name}) failed: ${String(err)}`)
    return { ok: false, text: `Task tool error: ${String(err?.message ?? err)}` }
  }
}

// ─── Shape 1: Claude SDK tools (composed into the `solus` MCP server) ───

function toToolResult(r: TaskToolResult) {
  return {
    content: [{ type: 'text' as const, text: r.text }],
    ...(r.ok ? {} : { isError: true as const }),
  }
}

export interface TaskSdkDeps {
  cwd: string
  sessionId?: () => string | undefined
  onTaskCreated?: OnTaskCreated
}

export function taskSdkTools(deps: TaskSdkDeps) {
  const mk = (): TaskToolDeps => ({ ctx: { cwd: deps.cwd, sessionId: deps.sessionId?.() }, onTaskCreated: deps.onTaskCreated })
  const run = (n: string) => async (args: unknown) =>
    toToolResult(await executeTaskTool(n, (args ?? {}) as Record<string, unknown>, mk()))
  return [
    tool('list_tasks', LIST_TASKS_DESC, listTasksShape, run('list_tasks')),
    tool('get_task', GET_DESC, getTaskShape, run('get_task')),
    tool('update_task_status', UPDATE_DESC, updateStatusShape, run('update_task_status')),
    tool('create_task', CREATE_TASK_DESC, createTaskShape, run('create_task')),
    tool('comment_task', COMMENT_TASK_DESC, commentTaskShape, run('comment_task')),
    tool('link_task_session', LINK_TASK_SESSION_DESC, linkTaskSessionShape, run('link_task_session')),
  ]
}

// ─── Shape 2: Codex dynamicTools JSON-schema descriptors ───

export interface TaskToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const TASK_TOOL_JSON_SCHEMAS: TaskToolDescriptor[] = [
  { name: 'list_tasks', description: LIST_TASKS_DESC, inputSchema: z.toJSONSchema(z.object(listTasksShape)) as Record<string, unknown> },
  { name: 'get_task', description: GET_DESC, inputSchema: z.toJSONSchema(z.object(getTaskShape)) as Record<string, unknown> },
  { name: 'update_task_status', description: UPDATE_DESC, inputSchema: z.toJSONSchema(z.object(updateStatusShape)) as Record<string, unknown> },
  { name: 'create_task', description: CREATE_TASK_DESC, inputSchema: z.toJSONSchema(z.object(createTaskShape)) as Record<string, unknown> },
  { name: 'comment_task', description: COMMENT_TASK_DESC, inputSchema: z.toJSONSchema(z.object(commentTaskShape)) as Record<string, unknown> },
  { name: 'link_task_session', description: LINK_TASK_SESSION_DESC, inputSchema: z.toJSONSchema(z.object(linkTaskSessionShape)) as Record<string, unknown> },
]

export const TASK_TOOL_NAMES = new Set(TASK_TOOL_JSON_SCHEMAS.map((t) => t.name))

/** Write tools gate through permissions; list/get are read-only. */
export const TASK_MUTATING_TOOLS = new Set(['update_task_status', 'create_task', 'comment_task', 'link_task_session'])
