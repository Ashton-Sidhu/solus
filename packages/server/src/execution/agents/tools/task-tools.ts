import { resolveHomePath } from '../../../platform/paths'
import { taskSessions } from '../../../data/tasks/task-sessions'
import { workspaceToolContext } from '../../../data/workspace/tool-context'
import { taskRecord } from '@solus/contracts/solus-api/records'
import { z } from 'zod'
import { createLogger } from '../../../logger'
import type { AgentTool } from './agent-tool'
import { toolAgentAttribution } from './agent-attribution'
import { resolveRepoRoot, resolveRepositoryKey } from '../../../git/git-helpers'
import { Task } from '../../../data/tasks/task'
import { applyOpToForeignTask, foreignTaskFor } from '../../../data/tasks/foreign-tasks'
import { formatTaskEpic, formatTaskLink } from '../../../data/tasks/task-context'
import { recordOutboxOp } from '../../../sync/outbox/outbox-store'
import { ulid } from '@solus/contracts/ulid'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import { sessionSettings } from '../../sessions/session-settings'
import { ANY_ORGANIZATION } from '../../../admission/principal'
import type { TaskCommentOpPayload, TaskSetStatusOpPayload } from '@solus/contracts/outbox-types'
import type {
  TaskSessionLink,
  Task as TaskRecord,
  TaskCreateInput,
  TaskLink as TaskLinkRecord,
} from '@solus/contracts/task-types'
import type { AgentId } from '@solus/contracts/types'
import { attributionLabel } from '@solus/contracts/user'
import { mentionsAsText } from '@solus/contracts/mentions'

const log = createLogger('main', 'task-tools.ts')

/**
 * Agent-facing task tools for long-running sessions. Like work-tools.ts and
 * automation-tools.ts, one set of Zod shapes backs both agent backends. Tasks
 * are written where the session's records live: this machine's store, or the
 * organization's Solus API for an organization session on an attached machine.
 * The calling cwd is used only to stamp the project on newly-created records.
 * Tools return error TEXT (never throw) so a bad call degrades to a recoverable
 * message rather than killing the turn.
 */

const STATUS_VALUES = ['inbox', 'todo', 'in_progress', 'in_review', 'done', 'dropped'] as const
const LIST_STATUS_VALUES = [...STATUS_VALUES, 'all'] as const
const PRIORITY_VALUES = ['urgent', 'high', 'medium', 'low'] as const

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
  cursor: z.string().max(2048).optional().describe('Continue from the next cursor returned by a previous list with the same filters.'),
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
  priority: z.enum(PRIORITY_VALUES).optional().describe('Optional priority.'),
  labels: z.array(z.string()).optional().describe('Optional labels.'),
  due_date: z.string().optional().describe('Optional ISO due date, usually YYYY-MM-DD.'),
  status: z.enum(STATUS_VALUES).optional().describe("Initial status. Defaults to 'todo', or 'inbox' for global capture."),
  inbox: z.boolean().optional().describe('When true, file this task in the global inbox instead of the calling project.'),
}

const commentTaskFields = {
  task_id: z.string().describe('The id of the task to comment on.'),
  body: z
    .string()
    .describe(
      'Comment body in markdown, written for a busy teammate. Keep it short and plain: a one-line summary of what you did, then a few short bullets for the key decisions and anything the reader must do next. Use simple words and short sentences. Leave out step-by-step logs, tool output, and long reasoning. Solus shows references as clickable chips only when they are marked up: put a file path in backticks (`src/app.ts` or `src/app.ts:42`), and link a work as [title](work://open?workId=<id>), a plan as [title](plan://open?planId=<id>), a task as [title](task://open?taskId=<id>), and a pull request by its URL. A bare path or id stays plain text.',
    ),
}

const listTasksInputSchema = z.object(listTasksFields)
const readTaskInputSchema = z.object(readTaskFields)
const updateStatusInputSchema = z.object(updateStatusFields)
const createTaskInputSchema = z.object(createTaskFields)
const commentTaskInputSchema = z.object(commentTaskFields)

// ─── Descriptions ───

const READ_TASK_DESC =
  "Read a local Solus task by id, including its description, upstream epic, comments, linked items, and linked session IDs. Use read_session with a session ID for its status, pending input and history."
const UPDATE_DESC =
  "Move a local task to a lifecycle status. This does not write to an external tracker."
const LIST_TASKS_DESC =
  "List local Solus tasks. Defaults to the calling project and can include the global inbox or all projects."
const CREATE_TASK_DESC =
  "Create a local Solus task in the calling project. This never creates an external ticket."
const COMMENT_TASK_DESC =
  "Add a local comment to a Solus task for durable findings, status, or handoff notes."
// ─── Executor (one implementation behind every agent backend's tool surface) ───

export interface TaskToolCtx {
  /** The calling session's working directory — stamps new tasks with a project. */
  cwd: string
  /** The calling session; every row the tool writes names it. */
  sessionId?: string
  /** The calling agent, named on what the tool writes. */
  agentProvider?: AgentId
}

interface TaskToolDeps {
  ctx: TaskToolCtx
  onTaskCreated?: (task: { taskId: string; title: string; url: string | null }) => void
}

export interface TaskToolResult {
  ok: boolean
  text: string
}

interface TaskToolArgs {
  body?: unknown
  due_date?: unknown
  inbox?: unknown
  labels?: unknown
  priority?: unknown
  cursor?: unknown
  scope?: unknown
  status?: unknown
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
  // The tasks an agent reads and writes live where its session's records live
  // (organization-vms §3): this machine's store for a Local session, which reads
  // the whole disk (docs/plans/project-model.md §4), or the organization's Solus
  // API for a session whose home is there. Reads and writes agree on it.
  const scope = ANY_ORGANIZATION
  const toolContext = () => workspaceToolContext(deps.ctx.sessionId)
  try {
    if (name === 'list_tasks') {
      const input = listTasksInputSchema.parse(args)
      const status = input.status ?? 'all'
      const requestedScope = input.scope ?? 'project'
      const { operations, context, remote } = await toolContext()
      const page = await operations.listTasks(context, {
        limit: 50, cursor: input.cursor, projectKey: requestedScope === 'project' ? (remote ? await organizationProjectKey(projectKey) : projectKey) : undefined,
        scope: requestedScope, status: status === 'all' ? undefined : status,
      })
      const shown = page.items
      const lines = shown.map((task) => {
        const meta = [task.priority ?? 'no priority', task.assignee ?? 'unassigned'].join(', ')
        return `${task.id}  [${task.status}]  ${task.title}  (${meta})`
      })
      const notes: string[] = []
      if (page.nextCursor) notes.push(`More tasks are available. Continue with cursor: ${page.nextCursor}`)
      const suffix = notes.length ? `\n\nNote: ${notes.join('; ')}.` : ''
      return { ok: true, text: lines.length ? `Tasks:\n${lines.join('\n')}${suffix}` : `No tasks matched.${suffix}` }
    }

    if (name === 'read_task') {
      const input = readTaskInputSchema.parse(args)
      const id = input.task_id.trim()
      if (!id) return { ok: false, text: 'read_task requires a task_id.' }
      // A foreign task (dispatched session) answers from the shipped snapshot,
      // overlaid with this session's own not-yet-delivered writes.
      const foreign = foreignTaskFor(deps.ctx.sessionId, id)
      if (!foreign) {
        const { operations, context, remote } = await toolContext()
        const task = await operations.getTask(context, id)
        // The organization's task: its fields from the Solus API. Comments and links stay on the task page.
        if (remote) return { ok: true, text: `${formatTaskForAgent(taskRecord(task), [], [], task.sessions ?? [])}\n\n(Comments and linked items of an organization task are on its task page in Solus.)` }
      }
      const details = foreign ? foreign.details : await (await Task.byId(scope, id)).details()
      const task = details.task
      return {
        ok: true,
        text: formatTaskForAgent(task, details.comments.map((comment) => ({
          author: comment.author ? attributionLabel(comment.author) : comment.externalAuthor ?? 'unknown',
          // A mention reads as `@Name`, as read_work shows it (plan 004 item 13).
          body: mentionsAsText(comment.body),
        })), details.links, foreign?.sessions ?? (await taskSessions(scope, id))[id] ?? []),
      }
    }

    if (name === 'update_task_status') {
      const input = updateStatusInputSchema.parse(args)
      const id = input.task_id.trim()
      if (!id) return { ok: false, text: 'update_task_status requires a task_id.' }
      const status = input.status
      // The choice of the person the session's run works for. A call no session
      // stands behind gets the built-in default.
      const lifecyclePolicy = sessionSettings(deps.ctx.sessionId)?.preferences?.agentTaskLifecyclePolicy ?? DEFAULT_EXECUTION_PREFERENCES.agentTaskLifecyclePolicy
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
      if (foreignTaskFor(deps.ctx.sessionId, id)) {
        const payload: TaskSetStatusOpPayload = { status, actor: await toolAgentAttribution(deps.ctx) }
        const op = recordOutboxOp({ domain: 'tasks', resourceId: id, name: 'set-status', payload, sessionId: deps.ctx.sessionId })
        applyOpToForeignTask(deps.ctx.sessionId, op)
        return { ok: true, text: `Task ${id} is now "${status}".` }
      }
      const { operations, context } = await toolContext()
      const current = await operations.getTask(context, id)
      const updated = await operations.updateTask(context, id, { status }, current.version)
      return { ok: true, text: `Task ${updated.id} is now "${updated.status}".` }
    }

    if (name === 'create_task') {
      const parsed = createTaskInputSchema.parse(args)
      const title = parsed.title.trim()
      if (!title) return { ok: false, text: 'create_task requires a non-empty title.' }
      const labels = parsed.labels?.map((label) => label.trim()).filter(Boolean)
      const isInbox = parsed.inbox === true
      const { operations, context, remote } = await toolContext()
      const input: TaskCreateInput = {
        title,
        // An organization's task belongs to the repository, not to this machine's path
        // (docs/plans/project-model.md §4); a folder with no remote keeps its path.
        projectKey: isInbox ? null : remote ? await organizationProjectKey(projectKey) : projectKey,
        body: parsed.body ?? '',
        priority: parsed.priority ?? null,
        labels,
        dueDate: parsed.due_date?.trim() || null,
        status: parsed.status ?? (isInbox ? 'inbox' : 'todo'),
        source: 'agent',
        originSessionId: deps.ctx.sessionId ?? null,
      }
      const { source: _source, originAutomationId: _automation, ...fields } = input
      const task = taskRecord(await operations.createTask(context, { ...fields, originSessionId: context.actingAgent?.sessionId }, ulid()))
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
      const author = await toolAgentAttribution(deps.ctx)
      if (foreignTaskFor(deps.ctx.sessionId, id)) {
        const payload: TaskCommentOpPayload = { body, author, originSessionId: deps.ctx.sessionId }
        const op = recordOutboxOp({ domain: 'tasks', resourceId: id, name: 'comment', payload, sessionId: deps.ctx.sessionId })
        applyOpToForeignTask(deps.ctx.sessionId, op)
        return { ok: true, text: `Comment added to task ${id}.` }
      }
      const { operations, context, remote } = await toolContext()
      if (remote) {
        await operations.createTaskComment(context, id, { body, originSessionId: deps.ctx.sessionId }, ulid())
        return { ok: true, text: `Comment added to task ${id}.` }
      }
      await (await Task.byId(scope, id)).comment(body, {
        by: author,
        originSessionId: deps.ctx.sessionId,
      })
      return { ok: true, text: `Comment added to task ${id}.` }
    }

    return { ok: false, text: `Unknown task tool: ${name}` }
  } catch (err: unknown) {
    log.error('task_tool_failed', { tool: name, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, text: `Task tool error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** An organization's task names the repository, not this machine's path; a folder with no remote keeps its path. */
async function organizationProjectKey(projectKey: string): Promise<string> {
  return (await resolveRepositoryKey(projectKey)) ?? projectKey
}

function formatTaskForAgent(
  task: TaskRecord,
  comments: Array<{ author: string; body: string }> = [],
  links: TaskLinkRecord[] = [],
  sessions: Pick<TaskSessionLink, 'sessionId' | 'sessionTitle' | 'role'>[] = [],
): string {
  const lines = [
    `Task ${task.id} — "${task.title}"`,
    `status: ${task.status}`,
  ]
  if (task.projectKey) lines.push(`project: ${task.projectKey}`)
  if (task.labels.length) lines.push(`labels: ${task.labels.join(', ')}`)
  if (task.assignee) lines.push(`assignee: ${task.assignee}`)
  if (task.epic) lines.push(...formatTaskEpic(task.epic))
  if (links.length) {
    lines.push('', 'Linked:')
    for (const link of links) lines.push(`- ${formatTaskLink(link)}`)
  }
  if (sessions.length) {
    lines.push('', 'Sessions (read_session with session_id):')
    for (const session of sessions) lines.push(`- ${session.sessionId} [${session.role ?? 'working'}]${session.sessionTitle ? ` — ${JSON.stringify(session.sessionTitle)}` : ''}`)
  }
  lines.push('', task.body.trim() || '(no description)')
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
      ctx: { cwd: resolveHomePath(context.cwd), sessionId: context.sessionId(), agentProvider: context.provider },
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
