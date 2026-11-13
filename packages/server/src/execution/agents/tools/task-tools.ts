import { taskSessions, tasksForSession } from '../../../data/tasks/task-sessions'
import { z } from 'zod'
import { createLogger } from '../../../logger'
import type { AgentTool } from './agent-tool'
import { toolAgentAttribution } from './agent-attribution'
import { commentOnTask, createTask, getTask, moveTask, namedTaskStatus } from '../../../data/tasks/task'
import { listTasks } from '../../../data/tasks/task-store'
import { loadTaskSources, taskSourceLabel } from '../../../data/tasks/task-source-store'
import { applyOpToForeignTask, foreignTaskFor } from '../../../data/tasks/foreign-tasks'
import { formatTaskEpic, formatTaskLink } from '../../../data/tasks/task-context'
import { recordOutboxOp } from '../../../sync/outbox/outbox-store'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import { sessionSettings } from '../../sessions/session-settings'
import { ANY_ORGANIZATION } from '../../../admission/principal'
import { hostUserKey } from '../../../host/host-user'
import { captureActingScope } from '../../../vault/acting-scope'
import type { TaskCommentOpPayload, TaskSetStatusOpPayload } from '@solus/contracts/outbox-types'
import { inferTaskSourceKey, taskSourceKey, type TaskSource, type TaskSourceHints } from '@solus/contracts/task-sources'
import { resolvePrimaryRepoRef } from '../../../git/git-helpers'
import { resolveHomePath } from '../../../platform/paths'
import type {
  TaskSessionLink,
  Task as TaskRecord,
  TaskLink as TaskLinkRecord,
  TaskSummary,
} from '@solus/contracts/task-types'
import type { AgentId } from '@solus/contracts/types'
import { attributionLabel } from '@solus/contracts/user'
import { mentionsAsText } from '@solus/contracts/mentions'

const log = createLogger('main', 'task-tools.ts')

/**
 * Agent-facing task tools for long-running sessions. Like work-tools.ts and
 * automation-tools.ts, one set of Zod shapes backs both agent backends.
 * GitHub and Jira own every task (docs/plans/provider-owned-tasks.md §6): a
 * tool reads the host's copy, and a write goes to the provider with the
 * connection of the person the turn acts for. This is the same on a personal
 * host and on an organization machine; a tool never calls the Solus API for a
 * task. Tools return error TEXT (never throw) so a bad call degrades to a
 * recoverable message rather than killing the turn.
 */

const CATEGORY_VALUES = ['open', 'active', 'done'] as const
const LIST_STATUS_VALUES = [...CATEGORY_VALUES, 'all'] as const
const PRIORITY_VALUES = ['urgent', 'high', 'medium', 'low'] as const
/** The most tasks one list answers. */
const LIST_LIMIT = 100

// ─── Schemas ───

const TASK_KEY_DESC = 'The task key (github:... or jira:...), from the task context or list_tasks.'

const readTaskFields = {
  task_id: z.string().describe(TASK_KEY_DESC),
}

const updateStatusFields = {
  task_id: z.string().describe(TASK_KEY_DESC),
  status: z
    .string()
    .describe(`A status category (${CATEGORY_VALUES.join(', ')}), or the exact name of a column that read_task shows.`),
}

const listTasksFields = {
  status: z
    .enum(LIST_STATUS_VALUES)
    .optional()
    .describe("Filter by status category. Defaults to 'all'."),
  source: z.string().optional().describe('Only this task source, by source key.'),
}

const createTaskFields = {
  title: z.string().describe('Task title.'),
  body: z.string().optional().describe('Task body/description in markdown.'),
  priority: z.enum(PRIORITY_VALUES).optional().describe('Optional priority.'),
  labels: z.array(z.string()).optional().describe('Optional labels.'),
  due_date: z.string().optional().describe('Optional ISO due date, usually YYYY-MM-DD.'),
  column: z.string().optional().describe('Optional column to start in.'),
  source: z.string().optional().describe('Task source key from list_tasks. Without it, the task goes to the source of the task this session works on, else to the GitHub repository of this checkout, else to the only source; with several sources and no such match, name one.'),
}

const commentTaskFields = {
  task_id: z.string().describe(TASK_KEY_DESC),
  body: z
    .string()
    .describe(
      'Comment body in markdown, written for a busy teammate and posted on GitHub or Jira. Keep it short: a one-line summary, then a few bullets for key decisions and what the reader must do next. Leave out step-by-step logs, tool output, and long reasoning. Put a file path in backticks and name a pull request by its URL.',
    ),
}

const listTasksInputSchema = z.object(listTasksFields)
const readTaskInputSchema = z.object(readTaskFields)
const updateStatusInputSchema = z.object(updateStatusFields)
const createTaskInputSchema = z.object(createTaskFields)
const commentTaskInputSchema = z.object(commentTaskFields)

// ─── Descriptions ───

const READ_TASK_DESC =
  'Read a GitHub or Jira task by its task key: description, state, columns, epic, comments, linked items, and linked session IDs. Use read_session for a session.'
const UPDATE_DESC =
  'Move a task to a status category (open, active, done) or to a named column. This writes to GitHub or Jira.'
const LIST_TASKS_DESC =
  'List the GitHub and Jira tasks of your task sources, with their task keys and status category.'
const CREATE_TASK_DESC =
  'Create a real task on GitHub or Jira, in one of your task sources. Other people see it at once.'
const COMMENT_TASK_DESC =
  'Post a comment on a task on GitHub or Jira, for durable findings, status, or handoff notes.'
// ─── Executor (one implementation behind every agent backend's tool surface) ───

export interface TaskToolCtx {
  /** The calling session; every row the tool writes names it. */
  sessionId?: string
  /** The calling agent, named on what the tool writes. */
  agentProvider?: AgentId
  /** The session's folder, resolved: its repository says where a new task belongs. */
  cwd?: string
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
  column?: unknown
  due_date?: unknown
  labels?: unknown
  priority?: unknown
  source?: unknown
  status?: unknown
  task_id?: unknown
  title?: unknown
}

/** One task as a list line names it: the key an agent passes back, then what a person reads. */
function taskLine(task: TaskSummary): string {
  const meta = [task.priority ?? 'no priority', task.assignee ?? 'unassigned'].join(', ')
  return `${task.id}  [${task.category}]  ${task.reference ? `${task.reference}  ` : ''}${task.title}  (${meta})`
}

/** What each task tool reads of its call. */
interface TaskToolCall {
  args: TaskToolArgs
  deps: TaskToolDeps
  /** The person whose provider connections decide which task sources show. */
  personKey: string
}

// A Local session reads the whole disk (docs/plans/project-model.md §4); the
// person's own provider connections decide which task sources they see.
const scope = ANY_ORGANIZATION

const NO_TASK_SOURCE = 'You have no task source. A person adds a GitHub or Jira task source on the Tasks page of Solus.'

async function listTasksTool({ args, deps, personKey }: TaskToolCall): Promise<TaskToolResult> {
  const input = listTasksInputSchema.parse(args)
  const status = input.status ?? 'all'
  // The person's own task sources, from the preferences the session's run was dispatched with.
  const sources = sessionSettings(deps.ctx.sessionId)?.preferences?.taskSources
  if (sources && !sources.length) return { ok: true, text: NO_TASK_SOURCE }
  const sourceKeys = new Set(input.source ? [input.source.trim()] : sources?.map(taskSourceKey) ?? [])
  // A run with no task sources in its preferences lists every task this host holds for the person.
  let tasks = await listTasks({ personKey, scope })
  if (sourceKeys.size) tasks = tasks.filter((task) => task.placements.some((placement) => sourceKeys.has(placement.sourceKey)))
  if (status !== 'all') tasks = tasks.filter((task) => task.category === status)
  const lines = tasks.slice(0, LIST_LIMIT).map(taskLine)
  const suffix = tasks.length > LIST_LIMIT ? `\n\nNote: ${tasks.length - LIST_LIMIT} more tasks matched. Narrow the list with status.` : ''
  const header = sources?.length ? `Task sources: ${sources.map(taskSourceKey).join(', ')}\n\n` : ''
  return { ok: true, text: `${header}${lines.length ? `Tasks:\n${lines.join('\n')}${suffix}` : 'No tasks matched.'}` }
}

async function readTaskTool({ args, deps }: TaskToolCall): Promise<TaskToolResult> {
  const input = readTaskInputSchema.parse(args)
  const id = input.task_id.trim()
  if (!id) return { ok: false, text: 'read_task requires a task_id.' }
  // A foreign task (dispatched session) answers from the shipped snapshot,
  // overlaid with this session's own not-yet-delivered writes.
  const foreign = foreignTaskFor(deps.ctx.sessionId, id)
  const details = foreign ? foreign.details : await getTask(scope, id)
  return {
    ok: true,
    text: formatTaskForAgent(details.task, await columnNamesOf(details.task), details.comments.map((comment) => ({
      author: comment.author ? attributionLabel(comment.author) : comment.externalAuthor ?? 'unknown',
      // A mention reads as `@Name`, as read_work shows it (plan 004 item 13).
      body: mentionsAsText(comment.body),
      unsent: comment.unsent === true,
    })), details.links, foreign?.sessions ?? (await taskSessions(scope, id))[id] ?? [], details.fromCache === true),
  }
}

async function updateTaskStatusTool({ args, deps }: TaskToolCall): Promise<TaskToolResult> {
  const input = updateStatusInputSchema.parse(args)
  const id = input.task_id.trim()
  if (!id) return { ok: false, text: 'update_task_status requires a task_id.' }
  const status = input.status.trim()
  if (!status) return { ok: false, text: 'update_task_status requires a status.' }
  // The choice of the person the session's run works for. A call no session
  // stands behind gets the built-in default.
  const lifecyclePolicy = sessionSettings(deps.ctx.sessionId)?.preferences?.agentTaskLifecyclePolicy ?? DEFAULT_EXECUTION_PREFERENCES.agentTaskLifecyclePolicy
  if (lifecyclePolicy === 'none') {
    return {
      ok: false,
      text: 'Agent task status changes are disabled. The user controls this task\'s lifecycle.',
    }
  }
  const foreign = foreignTaskFor(deps.ctx.sessionId, id)
  // The task of a dispatched session is read on another host: only a category can be checked here.
  const named = foreign ? null : await namedTaskStatus(id, status)
  const category = named?.category ?? CATEGORY_VALUES.find((candidate) => candidate === status.toLowerCase())
  if (lifecyclePolicy === 'moderate' && category === 'done') {
    return {
      ok: false,
      text: 'Agents cannot move tasks to done in Moderate mode. Move the task to a review column if its board has one, or ask the user to close it.',
    }
  }
  if (!named) {
    const payload: TaskSetStatusOpPayload = { status, actor: await toolAgentAttribution(deps.ctx) }
    const op = recordOutboxOp({ domain: 'tasks', resourceId: id, name: 'set-status', payload, sessionId: deps.ctx.sessionId })
    applyOpToForeignTask(deps.ctx.sessionId, op)
    return { ok: true, text: `Task ${id} is sent to "${status}". The host that reads the task makes the move on the provider.` }
  }
  const moved = await moveTask(id, named.target)
  return { ok: true, text: `Task ${moved.reference ?? moved.id} is now ${moved.state.name} (${moved.category}) on ${providerName(moved)}.` }
}

async function createTaskTool({ args, deps, personKey }: TaskToolCall): Promise<TaskToolResult> {
  const parsed = createTaskInputSchema.parse(args)
  const title = parsed.title.trim()
  if (!title) return { ok: false, text: 'create_task requires a non-empty title.' }
  const sources = sessionSettings(deps.ctx.sessionId)?.preferences?.taskSources ?? []
  if (!sources.length) return { ok: false, text: NO_TASK_SOURCE }
  const chosen = await newTaskSource(parsed.source?.trim(), sources, deps.ctx)
  if ('refusal' in chosen) return { ok: false, text: chosen.refusal }
  const { source } = chosen
  const labels = parsed.labels?.map((label) => label.trim()).filter(Boolean)
  const columnName = parsed.column?.trim().toLowerCase()
  let columnId: string | undefined
  if (columnName) {
    const stored = (await loadTaskSources([taskSourceKey(source)])).get(taskSourceKey(source))
    columnId = stored?.columns.find((column) => column.name.toLowerCase() === columnName)?.id
    if (!columnId) return { ok: false, text: `The task source ${taskSourceKey(source)} has no column "${parsed.column}".${stored ? ` Its columns: ${stored.columns.map((column) => column.name).join(', ')}.` : ''}` }
  }
  const task = await createTask({
    source,
    title,
    body: parsed.body ?? '',
    priority: parsed.priority,
    labels,
    dueDate: parsed.due_date?.trim() || undefined,
    columnId,
  }, personKey)
  deps.onTaskCreated?.({ taskId: task.id, title: task.title, url: task.url })
  return {
    ok: true,
    text: `Created on ${providerName(task)}.\n\n${formatTaskForAgent(task, await columnNamesOf(task))}`,
  }
}

/** The source that `create_task` writes to: the one the agent names, else the
 *  one the session points to (`inferTaskSourceKey`). A refusal names the
 *  person's sources, so that the agent can name one. */
async function newTaskSource(
  named: string | undefined,
  sources: readonly TaskSource[],
  ctx: TaskToolCtx,
): Promise<{ source: TaskSource } | { refusal: string }> {
  const sourceKey = named || inferTaskSourceKey(sources.map(taskSourceKey), await newTaskHints(ctx))
  const source = sources.find((candidate) => taskSourceKey(candidate) === sourceKey)
  if (source) return { source }
  return {
    refusal: named
      ? `"${named}" is not one of your task sources: ${await sourceChoices(sources)}.`
      : `Name the task source with "source": neither the task of this session nor its repository is one of your sources. Your task sources: ${await sourceChoices(sources)}.`,
  }
}

/** What the calling session says about where its new task belongs: the task
 *  it works on, and the GitHub repository of its checkout. */
async function newTaskHints(ctx: TaskToolCtx): Promise<TaskSourceHints> {
  const [linked, repository] = await Promise.all([
    ctx.sessionId ? tasksForSession(scope, ctx.sessionId) : null,
    ctx.cwd ? resolvePrimaryRepoRef(ctx.cwd).catch(() => null) : null,
  ])
  return {
    taskSourceKeys: linked?.task.placements.map((placement) => placement.sourceKey),
    repository: repository?.host.toLowerCase() === 'github.com' ? { owner: repository.owner, repo: repository.repo } : null,
  }
}

/** The person's sources as `key (label)`, so that an agent can name one. */
async function sourceChoices(sources: readonly TaskSource[]): Promise<string> {
  const stored = await loadTaskSources(sources.map(taskSourceKey))
  return sources
    .map((source) => `${taskSourceKey(source)} (${stored.get(taskSourceKey(source))?.label ?? taskSourceLabel(source)})`)
    .join(', ')
}

async function commentTaskTool({ args, deps }: TaskToolCall): Promise<TaskToolResult> {
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
    return { ok: true, text: `Comment sent for task ${id}. The host that reads the task posts it on the provider.` }
  }
  const details = await commentOnTask(scope, id, { body, by: author, originSessionId: deps.ctx.sessionId })
  const unsent = details.comments.findLast((comment) => comment.unsent && comment.body === body)
  if (unsent) {
    return { ok: false, text: `${providerName(details.task)} did not take the comment (${unsent.sendError ?? 'unknown reason'}). Solus holds it as unsent on the task; a person can send it again from the task page.` }
  }
  return { ok: true, text: `Comment posted on ${details.task.reference ?? id} on ${providerName(details.task)}.` }
}

const TASK_TOOLS = new Map<string, (call: TaskToolCall) => Promise<TaskToolResult>>([
  ['list_tasks', listTasksTool],
  ['read_task', readTaskTool],
  ['update_task_status', updateTaskStatusTool],
  ['create_task', createTaskTool],
  ['comment_task', commentTaskTool],
])

async function executeTaskTool(
  name: string,
  args: TaskToolArgs,
  deps: TaskToolDeps,
): Promise<TaskToolResult> {
  const tool = TASK_TOOLS.get(name)
  if (!tool) return { ok: false, text: `Unknown task tool: ${name}` }
  try {
    // The person the turn acts for; the host's own work reads as the host's user.
    return await tool({ args, deps, personKey: captureActingScope()?.personKey ?? hostUserKey() })
  } catch (err: unknown) {
    log.error('task_tool_failed', { tool: name, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, text: `Task tool error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function providerName(task: Pick<TaskRecord, 'providerId'>): string {
  return task.providerId === 'jira' ? 'Jira' : 'GitHub'
}

/** The column of the task in each source that lists it, as `source label: column name`. */
async function columnNamesOf(task: Pick<TaskRecord, 'placements'>): Promise<string[]> {
  const sources = await loadTaskSources(task.placements.map((placement) => placement.sourceKey))
  return task.placements.flatMap((placement) => {
    const source = sources.get(placement.sourceKey)
    if (!source) return []
    const column = source.columns.find((candidate) => candidate.id === placement.columnId)
    return [`${source.label}: ${column?.name ?? 'no column'}`]
  })
}

/** The facts of a task that a line each names, when the task has them. */
function taskFactLines(task: TaskRecord, columns: string[]): string[] {
  const facts: Array<[string, string | undefined]> = [
    ['columns', columns.join('; ')],
    ['labels', task.labels.join(', ')],
    ['assignee', task.assignee],
    ['priority', task.priority],
    ['due', task.dueDate],
  ]
  return facts.flatMap(([name, value]) => value ? [`${name}: ${value}`] : [])
}

function formatTaskForAgent(
  task: TaskRecord,
  columns: string[] = [],
  comments: Array<{ author: string; body: string; unsent: boolean }> = [],
  links: TaskLinkRecord[] = [],
  sessions: Pick<TaskSessionLink, 'sessionId' | 'sessionTitle' | 'role'>[] = [],
  fromCache = false,
): string {
  const lines = [
    `Task ${task.id} — "${task.title}"`,
    `${providerName(task)} ${task.kind === 'draft' ? 'draft item' : task.reference ?? 'issue'}${task.url ? ` — ${task.url}` : ''}`,
    `status category: ${task.category}`,
    `state: ${task.state.name}`,
  ]
  if (fromCache) lines.push('(The provider did not answer. This is the last copy that Solus read.)')
  lines.push(...taskFactLines(task, columns))
  if (task.epic) lines.push(...formatTaskEpic(task.epic))
  if (links.length) lines.push('', 'Linked:', ...links.map((link) => `- ${formatTaskLink(link)}`))
  if (sessions.length) {
    lines.push('', 'Sessions (read_session with session_id):')
    for (const session of sessions) lines.push(`- ${session.sessionId} [${session.role ?? 'working'}]${session.sessionTitle ? ` — ${JSON.stringify(session.sessionTitle)}` : ''}`)
  }
  lines.push('', task.body.trim() || '(no description)')
  if (comments.length) {
    lines.push('', 'Comments:')
    for (const comment of comments) lines.push(`- ${comment.author}${comment.unsent ? ' (not sent yet)' : ''}: ${comment.body.trim()}`)
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
      ctx: { sessionId: context.sessionId(), agentProvider: context.provider, cwd: resolveHomePath(context.cwd) },
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
