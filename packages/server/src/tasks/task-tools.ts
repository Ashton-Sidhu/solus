import { z } from 'zod'
import { createLogger } from '../logger'
import type { AgentTool } from '../agents/tools/agent-tool'
import { resolveRepoRoot } from '../git/git-helpers'
import { createTask, listTasks } from './task-store'
import { Task } from './task'
import { applyOpToForeignTask, foreignTaskFor } from './foreign-tasks'
import { formatTaskLink } from './task-context'
import { recordOutboxOp } from '../outbox/outbox-store'
import { getServerSettings } from '../server/settings'
import type { TaskCommentOpPayload, TaskSetStatusOpPayload } from '@solus/contracts/outbox-types'
import type {
  Task as TaskRecord,
  TaskCreateInput,
  TaskLink as TaskLinkRecord,
} from '@solus/contracts/task-types'

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

const readTaskFields = {
  task_id: z
    .string()
    .describe('Local task id. The bound task id is in the session\'s task context.'),
}

const updateStatusFields = {
  task_id: z.string().describe('The id of the task to move (the bound task, or one from its context).'),
  status: z
    .enum(STATUS_VALUES)
    .describe(`New local lifecycle status: ${STATUS_VALUES.join(', ')}.`),
}

const listTasksFields = {
  status: z
    .enum(LIST_STATUS_VALUES)
    .optional()
    .describe("Filter by task status. Defaults to 'all'."),
  scope: z
    .enum(['project', 'all', 'inbox', 'up_next'])
    .optional()
    .describe("Defaults to this project; use 'all', 'inbox', or 'up_next' to change scope."),
}

const createTaskFields = {
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

const commentTaskFields = {
  task_id: z.string().describe('The id of the task to comment on.'),
  body: z.string().describe('Comment body in markdown.'),
}

const linkTaskSessionFields = {
  task_id: z.string().describe('The id of the task to link.'),
  session_id: z.string().optional().describe('The Solus agent session id to link. Defaults to the calling session.'),
  role: z.enum(['working', 'referenced']).optional().describe("Link role. Defaults to 'working'."),
}

const linkTaskFields = {
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

const listTasksInputSchema = z.object(listTasksFields)
const readTaskInputSchema = z.object(readTaskFields)
const updateStatusInputSchema = z.object(updateStatusFields)
const createTaskInputSchema = z.object(createTaskFields)
const commentTaskInputSchema = z.object(commentTaskFields)
const linkTaskSessionInputSchema = z.object(linkTaskSessionFields)
const linkTaskInputSchema = z.object(linkTaskFields)

// ─── Descriptions ───

const READ_TASK_DESC =
  "Read a local Solus task by id, including its description, comments, subtasks, and linked items (works, plans, PRs, automations) with the ids their read tools take."
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
  /** Provider thread id — provenance on durable rows (comments, links). */
  sessionId?: string
  /** Solus session id — the key the session's foreign task snapshot is held
   *  under (see foreign-tasks.ts; the ControlPlane keys by Solus's id). */
  solusSessionId?: string
}

interface TaskToolDeps {
  ctx: TaskToolCtx
  onTaskCreated?: (task: { taskId: string; title: string; url: string | null }) => void
}

interface TaskToolResult {
  ok: boolean
  text: string
}

interface TaskToolArgs {
  body?: unknown
  due_date?: unknown
  inbox?: unknown
  kind?: unknown
  labels?: unknown
  parent_id?: unknown
  priority?: unknown
  role?: unknown
  scope?: unknown
  session_id?: unknown
  status?: unknown
  target_id?: unknown
  task_id?: unknown
  title?: unknown
}

async function executeTaskTool(
  name: string,
  args: TaskToolArgs,
  deps: TaskToolDeps,
): Promise<TaskToolResult> {
  const cwd = deps.ctx.cwd
  const projectKey = await resolveRepoRoot(cwd) ?? cwd
  try {
    if (name === 'list_tasks') {
      const input = listTasksInputSchema.parse(args)
      const status = input.status ?? 'all'
      const requestedScope = input.scope ?? 'project'
      const result = await listTasks({
        projectKey: requestedScope === 'project' ? projectKey : undefined,
        scope: requestedScope,
        status: status === 'all' ? undefined : status,
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
      const input = readTaskInputSchema.parse(args)
      const id = input.task_id.trim()
      if (!id) return { ok: false, text: 'read_task requires a task_id.' }
      // A foreign task (dispatched session) answers from the shipped snapshot,
      // overlaid with this session's own not-yet-delivered writes.
      const foreign = foreignTaskFor(deps.ctx.solusSessionId, id)
      const details = foreign ? foreign.details : await (await Task.byId(id)).details()
      const task = details.task
      return {
        ok: true,
        text: formatTaskForAgent(task, details.comments.map((comment) => ({
          author: comment.author ?? 'unknown',
          body: comment.body,
        })), details.subtasks, details.links),
      }
    }

    if (name === 'update_task_status') {
      const input = updateStatusInputSchema.parse(args)
      const id = input.task_id.trim()
      if (!id) return { ok: false, text: 'update_task_status requires a task_id.' }
      const status = input.status
      const lifecyclePolicy = getServerSettings().agentTaskLifecyclePolicy
      if (lifecyclePolicy === 'none') {
        return {
          ok: false,
          text: 'Agent task status changes are disabled. The user controls this task\'s lifecycle.',
        }
      }
      if (lifecyclePolicy === 'moderate' && status === 'done') {
        return {
          ok: false,
          text: 'Agents cannot move tasks to done in Moderate mode. Move the task to in_review or ask the user to close it.',
        }
      }
      if (foreignTaskFor(deps.ctx.solusSessionId, id)) {
        const payload: TaskSetStatusOpPayload = { status, actorLabel: deps.ctx.sessionId }
        const op = recordOutboxOp({ domain: 'tasks', resourceId: id, name: 'set-status', payload, sessionId: deps.ctx.sessionId })
        applyOpToForeignTask(deps.ctx.solusSessionId, op)
        return { ok: true, text: `Task ${id} is now "${status}".` }
      }
      const updated = await (await Task.byId(id)).update(
        { status },
        { actor: 'agent', actorLabel: deps.ctx.sessionId },
      )
      return { ok: true, text: `Task ${updated.id} is now "${updated.status}".` }
    }

    if (name === 'create_task') {
      const parsed = createTaskInputSchema.parse(args)
      const title = parsed.title.trim()
      if (!title) return { ok: false, text: 'create_task requires a non-empty title.' }
      const requestedParentId = parsed.parent_id?.trim() ?? ''
      if (requestedParentId && foreignTaskFor(deps.ctx.solusSessionId, requestedParentId)) {
        return { ok: false, text: foreignWriteUnsupported('create_task under a parent', requestedParentId) }
      }
      const labels = parsed.labels?.map((label) => label.trim()).filter(Boolean)
      const isInbox = parsed.inbox === true
      const input: TaskCreateInput = {
        title,
        projectKey: isInbox ? null : projectKey,
        body: parsed.body ?? '',
        kind: parsed.kind ?? 'task',
        parentId: requestedParentId || null,
        priority: parsed.priority ?? null,
        labels,
        dueDate: parsed.due_date?.trim() || null,
        status: parsed.status ?? (isInbox ? 'inbox' : 'todo'),
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
      const input = commentTaskInputSchema.parse(args)
      const id = input.task_id.trim()
      if (!id) return { ok: false, text: 'comment_task requires a task_id.' }
      const body = input.body.trim()
      if (!body) return { ok: false, text: 'comment_task requires a non-empty body.' }
      if (foreignTaskFor(deps.ctx.solusSessionId, id)) {
        const payload: TaskCommentOpPayload = { body, author: 'agent', originSessionId: deps.ctx.sessionId }
        const op = recordOutboxOp({ domain: 'tasks', resourceId: id, name: 'comment', payload, sessionId: deps.ctx.sessionId })
        applyOpToForeignTask(deps.ctx.solusSessionId, op)
        return { ok: true, text: `Comment added to task ${id}.` }
      }
      await (await Task.byId(id)).comment(body, {
        author: 'agent',
        originSessionId: deps.ctx.sessionId,
      })
      return { ok: true, text: `Comment added to task ${id}.` }
    }

    if (name === 'link_task_session') {
      const input = linkTaskSessionInputSchema.parse(args)
      const taskId = input.task_id.trim()
      if (!taskId) return { ok: false, text: 'link_task_session requires a task_id.' }
      if (foreignTaskFor(deps.ctx.solusSessionId, taskId)) {
        return { ok: false, text: foreignWriteUnsupported('link_task_session', taskId) }
      }
      const sessionId = input.session_id?.trim() || deps.ctx.sessionId
      if (!sessionId) return { ok: false, text: 'link_task_session requires session_id when no calling session id is available.' }
      const role = input.role ?? 'working'
      await (await Task.byId(taskId)).linkSession(sessionId, role)
      return { ok: true, text: `Linked task ${taskId} to session ${sessionId}.` }
    }

    if (name === 'link_task') {
      const input = linkTaskInputSchema.parse(args)
      const taskId = input.task_id.trim()
      if (!taskId) return { ok: false, text: 'link_task requires a task_id.' }
      if (foreignTaskFor(deps.ctx.solusSessionId, taskId)) {
        return { ok: false, text: foreignWriteUnsupported('link_task', taskId) }
      }
      const kind = input.kind
      const targetKey = input.target_id.trim()
      if (!targetKey) return { ok: false, text: 'link_task requires a target_id.' }

      // Only plans and PRs need a qualifier: a plan is identified by the session
      // it belongs to, and a PR number is only unique within a repo.
      let targetScope = ''
      if (kind === 'plan') {
        targetScope = input.session_id?.trim()
          ? input.session_id.trim()
          : deps.ctx.sessionId ?? ''
        if (!targetScope) return { ok: false, text: 'link_task requires session_id for kind=plan.' }
      } else if (kind === 'pr') {
        targetScope = projectKey ?? ''
      }

      await (await Task.byId(taskId)).link({
        kind,
        targetScope,
        targetKey,
        title: input.title,
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

/** The honest answer for a foreign-task write the outbox does not carry: the
 *  task exists, but on another host this one cannot reach. */
function foreignWriteUnsupported(operation: string, taskId: string): string {
  return `Task ${taskId} lives on another host (this session was dispatched), and ${operation} is not supported from here. Use comment_task or update_task_status — those sync back — or note it in your final message.`
}

function formatTaskForAgent(
  task: TaskRecord,
  comments: Array<{ author: string; body: string }> = [],
  subtasks: TaskRecord[] = [],
  links: TaskLinkRecord[] = [],
): string {
  const lines = [
    `${task.kind === 'epic' ? 'Epic' : 'Task'} ${task.id} — "${task.title}"`,
    `status: ${task.status}`,
  ]
  if (task.labels.length) lines.push(`labels: ${task.labels.join(', ')}`)
  if (task.assignee) lines.push(`assignee: ${task.assignee}`)
  if (task.parentId) lines.push(`parent: ${task.parentId}`)
  if (links.length) {
    lines.push('', 'Linked:')
    for (const link of links) lines.push(`- ${formatTaskLink(link)}`)
  }
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
  inputFields: AgentTool['inputFields'],
  requiresApproval: boolean,
): AgentTool {
  return {
    name,
    description,
    inputFields,
    requiresApproval,
    execute: async (args, context) => executeTaskTool(name, args, {
      ctx: { cwd: context.cwd, sessionId: context.sessionId(), solusSessionId: context.solusSessionId() },
      onTaskCreated: (task) => context.emit({
        type: 'task_created',
        taskId: task.taskId,
        title: task.title,
        url: task.url,
      }),
    }),
  }
}

export const listTasksAgentTool = taskAgentTool('list_tasks', LIST_TASKS_DESC, listTasksFields, false)
export const readTaskAgentTool = taskAgentTool('read_task', READ_TASK_DESC, readTaskFields, false)
export const updateTaskStatusAgentTool = taskAgentTool('update_task_status', UPDATE_DESC, updateStatusFields, true)
export const createTaskAgentTool = taskAgentTool('create_task', CREATE_TASK_DESC, createTaskFields, true)
export const commentTaskAgentTool = taskAgentTool('comment_task', COMMENT_TASK_DESC, commentTaskFields, true)
export const linkTaskSessionAgentTool = taskAgentTool('link_task_session', LINK_TASK_SESSION_DESC, linkTaskSessionFields, true)
export const linkTaskAgentTool = taskAgentTool('link_task', LINK_TASK_DESC, linkTaskFields, true)
