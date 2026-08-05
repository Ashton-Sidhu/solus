import { z } from 'zod'
import { createLogger } from '../logger'
import type { AgentTool } from '../agents/tools/agent-tool'
import { resolveRepoRoot } from '../git/git-helpers'
import { createTask, listTasks } from './task-store'
import { Task } from './task'
import type {
  Task as TaskRecord,
  TaskCreateInput,
  TaskKind,
  TaskLinkKind,
  TaskPriority,
  TaskSessionRole,
  TaskStatus,
} from '../../shared/task-types'

const log = createLogger('main', 'task-tools.ts')

/**
 * Agent-facing task tools for long-running sessions. Like work-tools.ts and
 * automation-tools.ts, one set of Zod shapes backs both agent backends. Tasks
 * are always written to the local store; the calling cwd is used only to stamp
 * the project on newly-created records.
 * Tools return error TEXT (never throw) so a bad call degrades to a recoverable
 * message rather than killing the turn.
 */

const STATUS_VALUES = ['inbox', 'todo', 'in_progress', 'in_review', 'done', 'dropped'] as const
const LIST_STATUS_VALUES = [...STATUS_VALUES, 'all'] as const
const PRIORITY_VALUES = ['urgent', 'high', 'medium', 'low'] as const
const KIND_VALUES = ['task', 'epic'] as const
const LINK_KIND_VALUES = ['work', 'plan', 'pr', 'automation'] as const

// ─── Schemas ───

const readTaskShape = {
  task_id: z
    .string()
    .describe('Local task id. The bound task id is in the session\'s task context.'),
}

const updateStatusShape = {
  task_id: z.string().describe('The id of the task to move (the bound task, or one from its context).'),
  status: z
    .enum(STATUS_VALUES)
    .describe(`New local lifecycle status: ${STATUS_VALUES.join(', ')}.`),
}

const listTasksShape = {
  status: z
    .enum(LIST_STATUS_VALUES)
    .optional()
    .describe("Filter by task status. Defaults to 'all'."),
  scope: z
    .enum(['project', 'all', 'inbox', 'up_next'])
    .optional()
    .describe("Defaults to this project; use 'all', 'inbox', or 'up_next' to change scope."),
}

const createTaskShape = {
  title: z.string().describe('Task title.'),
  body: z.string().optional().describe('Task body/description in markdown.'),
  kind: z.enum(KIND_VALUES).optional().describe("Task kind. Defaults to 'task'."),
  parent_id: z.string().optional().describe('Optional parent epic/task id.'),
  priority: z.enum(PRIORITY_VALUES).optional().describe('Optional priority.'),
  labels: z.array(z.string()).optional().describe('Optional labels.'),
  due_date: z.string().optional().describe('Optional ISO due date, usually YYYY-MM-DD.'),
  status: z.enum(STATUS_VALUES).optional().describe("Initial status. Defaults to 'todo', or 'inbox' for global capture."),
  inbox: z.boolean().optional().describe('When true, file this task in the global inbox instead of the calling project.'),
}

const commentTaskShape = {
  task_id: z.string().describe('The id of the task to comment on.'),
  body: z.string().describe('Comment body in markdown.'),
}

const linkTaskSessionShape = {
  task_id: z.string().describe('The id of the task to link.'),
  session_id: z.string().optional().describe('The Solus agent session id to link. Defaults to the calling session.'),
  role: z.enum(['working', 'referenced']).optional().describe("Link role. Defaults to 'working'."),
}

const linkTaskShape = {
  task_id: z.string().describe('The id of the task to link.'),
  kind: z
    .enum(LINK_KIND_VALUES)
    .describe("What is being linked: 'work' (a Solus doc, slides or diagram), 'plan', 'pr', or 'automation'."),
  target_id: z
    .string()
    .describe("The target's id: a work id, an automation id, a plan tool-use id, or a PR number."),
  session_id: z
    .string()
    .optional()
    .describe('Required for kind=plan: the session the plan belongs to. Defaults to the calling session.'),
  title: z.string().optional().describe('Optional label; resolved from the target when omitted.'),
}

// ─── Descriptions ───

const READ_TASK_DESC =
  "Read a local Solus task by id, including its description, comments, subtasks, and linked sessions."
const UPDATE_DESC =
  "Move a local task to a lifecycle status. This does not write to an external tracker."
const LIST_TASKS_DESC =
  "List local Solus tasks. Defaults to the calling project and can include the global inbox or all projects."
const CREATE_TASK_DESC =
  "Create a local Solus task in the calling project. This never creates an external ticket."
const COMMENT_TASK_DESC =
  "Add a local comment to a Solus task for durable findings, status, or handoff notes."
const LINK_TASK_SESSION_DESC =
  "Link a task to a Solus agent session in the local Solus task/session map. Defaults to the calling session when session_id is omitted."
const LINK_TASK_DESC =
  "Attach a doc, plan, pull request, or automation to a Solus task so it shows in the task's Linked list."

// ─── Executor (one implementation behind every agent backend's tool surface) ───

interface TaskToolCtx {
  /** The calling session's working directory — stamps new tasks with a project. */
  cwd: string
  sessionId?: string
}

interface TaskToolDeps {
  ctx: TaskToolCtx
  onTaskCreated?: (task: { taskId: string; title: string; url: string | null }) => void
}

interface TaskToolResult {
  ok: boolean
  text: string
}

async function executeTaskTool(
  name: string,
  args: Record<string, unknown>,
  deps: TaskToolDeps,
): Promise<TaskToolResult> {
  const cwd = deps.ctx.cwd
  const projectKey = await resolveRepoRoot(cwd) ?? cwd
  try {
    if (name === 'list_tasks') {
      const status = String(args.status ?? 'all')
      if (!(LIST_STATUS_VALUES as readonly string[]).includes(status)) {
        return { ok: false, text: `list_tasks: status must be one of ${LIST_STATUS_VALUES.join(', ')}.` }
      }
      const requestedScope = typeof args.scope === 'string' ? args.scope : 'project'
      const result = await listTasks({
        projectKey: requestedScope === 'project' ? projectKey : undefined,
        scope: requestedScope as 'project' | 'all' | 'inbox' | 'up_next',
        status: status === 'all' ? undefined : status as TaskStatus,
      })
      const filtered = result.tasks
      const shown = filtered.slice(0, 50)
      const lines = shown.map((task) => {
        const meta = [task.priority ?? 'no priority', task.assignee ?? 'unassigned'].join(', ')
        return `${task.id}  [${task.status}]  ${task.title}  (${meta})`
      })
      const notes: string[] = []
      if (filtered.length > shown.length) notes.push(`showing 50 of ${filtered.length}`)
      const suffix = notes.length ? `\n\nNote: ${notes.join('; ')}.` : ''
      return { ok: true, text: lines.length ? `Tasks:\n${lines.join('\n')}${suffix}` : `No tasks matched.${suffix}` }
    }

    if (name === 'read_task') {
      const id = String(args.task_id ?? '').trim()
      if (!id) return { ok: false, text: 'read_task requires a task_id.' }
      const details = await (await Task.byId(id)).details()
      const task = details.task
      return {
        ok: true,
        text: formatTaskForAgent(task, details.comments.map((comment) => ({
          author: comment.author ?? 'unknown',
          body: comment.body,
        })), details.subtasks),
      }
    }

    if (name === 'update_task_status') {
      const id = String(args.task_id ?? '').trim()
      if (!id) return { ok: false, text: 'update_task_status requires a task_id.' }
      const status = String(args.status ?? '')
      if (!(STATUS_VALUES as readonly string[]).includes(status)) {
        return { ok: false, text: `update_task_status: status must be one of ${STATUS_VALUES.join(', ')}.` }
      }
      const updated = await (await Task.byId(id)).update(
        { status: status as TaskStatus },
        { actor: 'agent', actorLabel: deps.ctx.sessionId },
      )
      return { ok: true, text: `Task ${updated.id} is now "${updated.status}".` }
    }

    if (name === 'create_task') {
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      if (!title) return { ok: false, text: 'create_task requires a non-empty title.' }
      const labels = Array.isArray(args.labels)
        ? args.labels.map((label) => String(label).trim()).filter(Boolean)
        : undefined
      const isInbox = args.inbox === true
      const input: TaskCreateInput = {
        title,
        projectKey: isInbox ? null : projectKey,
        body: typeof args.body === 'string' ? args.body : '',
        kind: (KIND_VALUES as readonly string[]).includes(String(args.kind)) ? args.kind as TaskKind : 'task',
        parentId: typeof args.parent_id === 'string' && args.parent_id.trim() ? args.parent_id.trim() : null,
        priority: (PRIORITY_VALUES as readonly string[]).includes(String(args.priority)) ? args.priority as TaskPriority : null,
        labels,
        dueDate: typeof args.due_date === 'string' && args.due_date.trim() ? args.due_date.trim() : null,
        status: (STATUS_VALUES as readonly string[]).includes(String(args.status))
          ? args.status as TaskStatus
          : isInbox ? 'inbox' : 'todo',
        source: 'agent',
        originSessionId: deps.ctx.sessionId ?? null,
      }
      const task = await createTask(input)
      deps.onTaskCreated?.({ taskId: task.id, title: task.title, url: task.url ?? null })
      return {
        ok: true,
        text: formatTaskForAgent(task),
      }
    }

    if (name === 'comment_task') {
      const id = String(args.task_id ?? '').trim()
      if (!id) return { ok: false, text: 'comment_task requires a task_id.' }
      const body = typeof args.body === 'string' ? args.body.trim() : ''
      if (!body) return { ok: false, text: 'comment_task requires a non-empty body.' }
      await (await Task.byId(id)).comment(body, {
        author: 'agent',
        originSessionId: deps.ctx.sessionId,
      })
      return { ok: true, text: `Comment added to task ${id}.` }
    }

    if (name === 'link_task_session') {
      const taskId = String(args.task_id ?? '').trim()
      if (!taskId) return { ok: false, text: 'link_task_session requires a task_id.' }
      const sessionId = typeof args.session_id === 'string' && args.session_id.trim()
        ? args.session_id.trim()
        : deps.ctx.sessionId
      if (!sessionId) return { ok: false, text: 'link_task_session requires session_id when no calling session id is available.' }
      const role = (args.role === 'referenced' ? 'referenced' : 'working') as TaskSessionRole
      await (await Task.byId(taskId)).linkSession(sessionId, role)
      return { ok: true, text: `Linked task ${taskId} to session ${sessionId}.` }
    }

    if (name === 'link_task') {
      const taskId = String(args.task_id ?? '').trim()
      if (!taskId) return { ok: false, text: 'link_task requires a task_id.' }
      const kind = String(args.kind ?? '') as TaskLinkKind
      if (!(LINK_KIND_VALUES as readonly string[]).includes(kind)) {
        return { ok: false, text: `link_task: kind must be one of ${LINK_KIND_VALUES.join(', ')}.` }
      }
      const targetKey = String(args.target_id ?? '').trim()
      if (!targetKey) return { ok: false, text: 'link_task requires a target_id.' }

      // Only plans and PRs need a qualifier: a plan is identified by the session
      // it belongs to, and a PR number is only unique within a repo.
      let targetScope = ''
      if (kind === 'plan') {
        targetScope = (typeof args.session_id === 'string' && args.session_id.trim())
          ? args.session_id.trim()
          : deps.ctx.sessionId ?? ''
        if (!targetScope) return { ok: false, text: 'link_task requires session_id for kind=plan.' }
      } else if (kind === 'pr') {
        targetScope = projectKey ?? ''
      }

      await (await Task.byId(taskId)).link({
        kind,
        targetScope,
        targetKey,
        title: typeof args.title === 'string' ? args.title : undefined,
        createdBy: 'agent',
        originSessionId: deps.ctx.sessionId ?? null,
      }, { actor: 'agent', actorLabel: deps.ctx.sessionId })
      return { ok: true, text: `Linked ${kind} ${targetKey} to task ${taskId}.` }
    }

    return { ok: false, text: `Unknown task tool: ${name}` }
  } catch (err: unknown) {
    log.error('task_tool_failed', { tool: name, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, text: `Task tool error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function formatTaskForAgent(
  task: TaskRecord,
  comments: Array<{ author: string; body: string }> = [],
  subtasks: TaskRecord[] = [],
): string {
  const lines = [
    `${task.kind === 'epic' ? 'Epic' : 'Task'} ${task.id} — "${task.title}"`,
    `status: ${task.status}`,
  ]
  if (task.labels.length) lines.push(`labels: ${task.labels.join(', ')}`)
  if (task.assignee) lines.push(`assignee: ${task.assignee}`)
  if (task.parentId) lines.push(`parent: ${task.parentId}`)
  lines.push('', task.body.trim() || '(no description)')
  if (subtasks.length) {
    lines.push('', 'Subtasks:')
    for (const subtask of subtasks) lines.push(`- ${subtask.id} [${subtask.status}] ${subtask.title}`)
  }
  if (comments.length) {
    lines.push('', 'Comments:')
    for (const comment of comments) lines.push(`- ${comment.author}: ${comment.body.trim()}`)
  }
  return lines.join('\n')
}

function taskAgentTool(
  name: string,
  description: string,
  inputShape: z.ZodRawShape,
  requiresApproval: boolean,
): AgentTool {
  return {
    name,
    description,
    inputShape,
    requiresApproval,
    execute: async (args, context) => executeTaskTool(name, args, {
      ctx: { cwd: context.cwd, sessionId: context.sessionId() },
      onTaskCreated: (task) => context.emit({
        type: 'task_created',
        taskId: task.taskId,
        title: task.title,
        url: task.url,
      }),
    }),
  }
}

export const listTasksAgentTool = taskAgentTool('list_tasks', LIST_TASKS_DESC, listTasksShape, false)
export const readTaskAgentTool = taskAgentTool('read_task', READ_TASK_DESC, readTaskShape, false)
export const updateTaskStatusAgentTool = taskAgentTool('update_task_status', UPDATE_DESC, updateStatusShape, true)
export const createTaskAgentTool = taskAgentTool('create_task', CREATE_TASK_DESC, createTaskShape, true)
export const commentTaskAgentTool = taskAgentTool('comment_task', COMMENT_TASK_DESC, commentTaskShape, true)
export const linkTaskSessionAgentTool = taskAgentTool('link_task_session', LINK_TASK_SESSION_DESC, linkTaskSessionShape, true)
export const linkTaskAgentTool = taskAgentTool('link_task', LINK_TASK_DESC, linkTaskShape, true)
