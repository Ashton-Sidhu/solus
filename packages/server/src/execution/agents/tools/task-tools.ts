import { workspaceToolContext } from '../../../data/workspace/tool-context'
import { taskRecord } from '@solus/contracts/solus-api/records'
import { z } from 'zod'
import { createLogger } from '../../../logger'
import type { AgentTool } from './agent-tool'
import { toolAgentAttribution } from './agent-attribution'
import { resolveRepoRoot, resolveRepositoryKey } from '../../../git/git-helpers'
import { Task } from '../../../data/tasks/task'
import { linkSessionPullRequest, pullRequestIdentityOf, readSessionPullRequests, sessionPullRequestOwnerId } from '../../../data/sessions/session-pull-requests'
import { resolvePullRequestUrl } from '../../../providers/pull-request-url'
import { applyOpToForeignTask, foreignTaskFor } from '../../../data/tasks/foreign-tasks'
import { formatTaskEpic, formatTaskLink } from '../../../data/tasks/task-context'
import { recordOutboxOp, type DeliveryDestination } from '../../../sync/outbox/outbox-store'
import { ulid } from '@solus/contracts/ulid'
import { getHostConfig } from '../../../host/settings'
import { ANY_ORGANIZATION } from '../../../admission/principal'
import type { SessionPullRequestOpPayload, TaskCommentOpPayload, TaskLinkOpPayload, TaskLinkSessionOpPayload, TaskSetStatusOpPayload } from '@solus/contracts/outbox-types'
import type {
  Task as TaskRecord,
  TaskCreateInput,
  TaskLink as TaskLinkRecord,
} from '@solus/contracts/task-types'
import type { AgentId } from '@solus/contracts/types'
import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
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
const LINK_KIND_VALUES = ['work', 'plan', 'pr', 'automation', 'session'] as const

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

const linkFields = {
  task_id: z
    .string()
    .optional()
    .describe('The id of the task to link to. Omit it for kind=pr to link the pull request to the calling session. Required for every other kind.'),
  kind: z
    .enum(LINK_KIND_VALUES)
    .describe("What is being linked: 'work' (a Solus doc, slides or diagram), 'plan', 'pr', 'automation', or 'session' (a Solus agent session)."),
  target_id: z
    .string()
    .optional()
    .describe("The target's id: a work id, an automation id, a plan tool-use id, a PR number, or a GitHub PR URL. For kind=session, omit it to link the calling session. Required for every other kind."),
  session_id: z
    .string()
    .optional()
    .describe('For kind=plan only: the session the plan belongs to. Defaults to the calling session. A session being linked is named by target_id, not here.'),
  role: z
    .enum(['working', 'referenced'])
    .optional()
    .describe("For kind=session only: 'working' (the session doing the work, the default) or 'referenced'."),
  title: z.string().optional().describe('Optional label; resolved from the target when omitted.'),
}

const listSessionPullRequestsFields = {}

const listTasksInputSchema = z.object(listTasksFields)
const readTaskInputSchema = z.object(readTaskFields)
const updateStatusInputSchema = z.object(updateStatusFields)
const createTaskInputSchema = z.object(createTaskFields)
const commentTaskInputSchema = z.object(commentTaskFields)
const linkInputSchema = z.object(linkFields)

// ─── Descriptions ───

const READ_TASK_DESC =
  "Read a local Solus task by id, including its description, its upstream epic, comments, and linked items (works, plans, PRs, automations) with the ids their read tools take."
const UPDATE_DESC =
  "Move a local task to a lifecycle status. This does not write to an external tracker."
const LIST_TASKS_DESC =
  "List local Solus tasks. Defaults to the calling project and can include the global inbox or all projects."
const CREATE_TASK_DESC =
  "Create a local Solus task in the calling project. This never creates an external ticket."
const COMMENT_TASK_DESC =
  "Add a local comment to a Solus task for durable findings, status, or handoff notes."
const LINK_DESC =
  "Link a pull request to this session, or attach a doc, plan, pull request, or automation to a Solus task. With kind='pr' and no task_id, the pull request is linked to the calling session: call this for each pull request that you create or work on. Solus shows it on the session and on the task the session works on, keeps its state current, and marks the session done when its pull requests are merged or closed. With a task_id, the item shows in the task's Linked list. Pass kind='session' to bind an agent session to the task instead — that one goes on the local task/session map, and defaults to the calling session. Linking a linked item is safe."
const LIST_SESSION_PULL_REQUESTS_DESC =
  "List the pull requests linked to this session, with the state that Solus last saw for each. Before you finish pull request work, call this and link each pull request from your work that is missing."

// ─── Executor (one implementation behind every agent backend's tool surface) ───

interface TaskToolCtx {
  /** The calling session's working directory — stamps new tasks with a project. */
  cwd: string
  /** Provider thread id — provenance on durable rows (comments, links). */
  sessionId?: string
  /** Solus session id — the key the session's foreign task snapshot is held
   *  under (see foreign-tasks.ts; the SessionRuntime keys by Solus's id). */
  solusSessionId?: string
  /** The calling agent, named on what the tool writes. */
  agentProvider?: AgentId
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
  priority?: unknown
  role?: unknown
  cursor?: unknown
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
  // The tasks an agent reads and writes live where its session's records live
  // (organization-vms §3): this machine's store for a Local session, which reads
  // the whole disk (docs/plans/project-model.md §4), or the organization's Solus
  // API for a session whose home is there. Reads and writes agree on it.
  const scope = ANY_ORGANIZATION
  const toolContext = () => workspaceToolContext(deps.ctx.sessionId, deps.ctx.solusSessionId)
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
      const foreign = foreignTaskFor(deps.ctx.solusSessionId, id)
      if (!foreign) {
        const { operations, context, remote } = await toolContext()
        const task = await operations.getTask(context, id)
        // The organization's task: its fields from the Solus API. Comments and links stay on the task page.
        if (remote) return { ok: true, text: `${formatTaskForAgent(taskRecord(task))}\n\n(Comments and linked items of an organization task are on its task page in Solus.)` }
      }
      const details = foreign ? foreign.details : await (await Task.byId(scope, id)).details()
      const task = details.task
      return {
        ok: true,
        text: formatTaskForAgent(task, details.comments.map((comment) => ({
          author: comment.author ? attributionLabel(comment.author) : comment.externalAuthor ?? 'unknown',
          // A mention reads as `@Name`, as read_work shows it (plan 004 item 13).
          body: mentionsAsText(comment.body),
        })), details.links),
      }
    }

    if (name === 'update_task_status') {
      const input = updateStatusInputSchema.parse(args)
      const id = input.task_id.trim()
      if (!id) return { ok: false, text: 'update_task_status requires a task_id.' }
      const status = input.status
      const lifecyclePolicy = getHostConfig().config.agentTaskLifecyclePolicy
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
        const payload: TaskSetStatusOpPayload = { status, actor: await toolAgentAttribution(deps.ctx) }
        const op = recordOutboxOp({ domain: 'tasks', resourceId: id, name: 'set-status', payload, sessionId: deps.ctx.sessionId })
        applyOpToForeignTask(deps.ctx.solusSessionId, op)
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
      if (foreignTaskFor(deps.ctx.solusSessionId, id)) {
        const payload: TaskCommentOpPayload = { body, author, originSessionId: deps.ctx.sessionId }
        const op = recordOutboxOp({ domain: 'tasks', resourceId: id, name: 'comment', payload, sessionId: deps.ctx.sessionId })
        applyOpToForeignTask(deps.ctx.solusSessionId, op)
        return { ok: true, text: `Comment added to task ${id}.` }
      }
      const home = await organizationHome(toolContext)
      if (home) {
        const payload: TaskCommentOpPayload = { body, author, originSessionId: deps.ctx.sessionId }
        recordOutboxOp({ domain: 'tasks', resourceId: id, name: 'comment', payload, sessionId: deps.ctx.sessionId, destination: 'cloud', organizationId: home.organizationId, actorUserId: home.actorUserId })
        return { ok: true, text: queuedForOrganization(`Comment on task ${id}`) }
      }
      await (await Task.byId(scope, id)).comment(body, {
        by: author,
        originSessionId: deps.ctx.sessionId,
      })
      return { ok: true, text: `Comment added to task ${id}.` }
    }

    if (name === 'link') {
      const input = linkInputSchema.parse(args)
      const taskId = input.task_id?.trim() ?? ''
      const kind = input.kind
      // A pull request with no task is the calling session's own link, which
      // the task the session works on reads (docs/plans/session-pull-requests.md).
      if (!taskId) {
        if (kind !== 'pr') return { ok: false, text: `link requires a task_id for kind=${kind}.` }
        return await linkCallerPullRequest(deps.ctx, toolContext, projectKey, input)
      }
      if (foreignTaskFor(deps.ctx.solusSessionId, taskId)) {
        return { ok: false, text: foreignWriteUnsupported('link', taskId) }
      }

      // A session is not a linked *item*: it owns a role on the task/session
      // map rather than a row in the task's Linked list, and it is the one kind
      // whose target defaults to the caller.
      if (kind === 'session') {
        const sessionId = input.target_id?.trim() || deps.ctx.sessionId
        if (!sessionId) return { ok: false, text: 'link with kind=session requires target_id when no calling session id is available.' }
        const home = await organizationHome(toolContext)
        if (home) {
          const payload: TaskLinkSessionOpPayload = { sessionId, role: input.role ?? 'working' }
          recordOutboxOp({ domain: 'tasks', resourceId: taskId, name: 'link-session', payload, sessionId: deps.ctx.sessionId, destination: 'cloud', organizationId: home.organizationId, actorUserId: home.actorUserId })
          return { ok: true, text: queuedForOrganization(`Link of task ${taskId} to session ${sessionId}`) }
        }
        await (await Task.byId(scope, taskId)).linkSession(sessionId, input.role ?? 'working')
        return { ok: true, text: `Linked task ${taskId} to session ${sessionId}.` }
      }

      let targetKey = input.target_id?.trim() ?? ''
      if (!targetKey) return { ok: false, text: `link requires a target_id for kind=${kind}.` }

      // Only plans and PRs need a qualifier: a plan is identified by the session
      // it belongs to, and a PR number is only unique within a repo.
      let targetScope = ''
      const externalPr = kind === 'pr' ? parseGitHubPullRequestUrl(targetKey) : null
      if (kind === 'plan') {
        targetScope = input.session_id?.trim()
          ? input.session_id.trim()
          : deps.ctx.sessionId ?? ''
        if (!targetScope) return { ok: false, text: 'link requires session_id for kind=plan.' }
      } else if (kind === 'pr') {
        targetScope = externalPr
          ? `${externalPr.baseRepo.host}/${externalPr.baseRepo.owner}/${externalPr.baseRepo.repo}`
          : projectKey ?? ''
        if (externalPr) targetKey = String(externalPr.number)
      }

      const link: TaskLinkOpPayload = {
        kind,
        targetScope,
        targetKey,
        title: input.title ?? (externalPr
          ? `#${externalPr.number} ${externalPr.baseRepo.owner}/${externalPr.baseRepo.repo}`
          : undefined),
        url: externalPr?.url,
        originSessionId: deps.ctx.sessionId ?? null,
        actor: await toolAgentAttribution(deps.ctx),
      }
      // A pull request named by number gets its URL here, on the machine that
      // has the repository: a session link is made from the URL.
      const prNumber = Number(targetKey)
      if (kind === 'pr' && !link.url && deps.ctx.sessionId && projectKey && Number.isSafeInteger(prNumber) && prNumber > 0) {
        link.url = await resolvePullRequestUrl(projectKey, prNumber).catch(() => undefined)
      }
      const home = await organizationHome(toolContext)
      if (home) {
        recordOutboxOp({ domain: 'tasks', resourceId: taskId, name: 'link', payload: link, sessionId: deps.ctx.sessionId, destination: 'cloud', organizationId: home.organizationId, actorUserId: home.actorUserId })
        return { ok: true, text: queuedForOrganization(`Link of ${kind} ${targetKey} to task ${taskId}`) }
      }

      const { actor, ...linkInput } = link
      const by = actor ?? await toolAgentAttribution(deps.ctx)
      const task = await Task.byId(scope, taskId)
      // A pull request of a session that works on the task is the session's
      // link, which the task reads (docs/plans/session-pull-requests.md).
      const callerSessionId = deps.ctx.sessionId
      if (kind === 'pr' && callerSessionId && link.url
        && await task.linkWorkingSessionPullRequest(callerSessionId, { url: link.url, title: input.title }, by)) {
        return { ok: true, text: `Linked ${kind} ${targetKey} to task ${taskId}.` }
      }
      await task.link(linkInput, by)
      return { ok: true, text: `Linked ${kind} ${targetKey} to task ${taskId}.` }
    }

    if (name === 'list_session_pull_requests') return await listCallerPullRequests(deps.ctx)

    return { ok: false, text: `Unknown task tool: ${name}` }
  } catch (err: unknown) {
    log.error('task_tool_failed', { tool: name, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, text: `Task tool error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Link a pull request to the calling session. The machine that runs the
 * session always holds the link, because its PR sync watches the pull request.
 * For an organization session on an attached machine the organization's Solus
 * API holds the session too, so the same link travels there in the delivery
 * queue.
 */
async function linkCallerPullRequest(
  ctx: TaskToolCtx,
  toolContext: () => ReturnType<typeof workspaceToolContext>,
  projectKey: string,
  input: { target_id?: string; title?: string },
): Promise<TaskToolResult> {
  // Durable rows of a session are keyed by Solus's session id.
  const callerSessionId = ctx.solusSessionId ?? ctx.sessionId
  if (!callerSessionId) return { ok: false, text: 'link with kind=pr and no task_id needs a calling session, and this session has no id yet.' }
  const named = input.target_id?.trim() ?? ''
  const number = Number(named.replace(/^#/, ''))
  const url = parseGitHubPullRequestUrl(named)?.url
    ?? (Number.isSafeInteger(number) && number > 0 ? await resolvePullRequestUrl(projectKey, number) : null)
  const identity = url ? pullRequestIdentityOf(url) : null
  if (!identity) return { ok: false, text: `link could not find pull request "${named}". Pass its number or URL as target_id.` }
  const sessionId = sessionPullRequestOwnerId(callerSessionId)
  const actor = await toolAgentAttribution(ctx)
  await linkSessionPullRequest(sessionId, { url: identity.url, title: input.title, source: 'agent', by: actor })
  const home = await organizationHome(toolContext)
  if (home) {
    const payload: SessionPullRequestOpPayload = { url: identity.url, title: input.title, actor }
    recordOutboxOp({ domain: 'sessions', resourceId: sessionId, name: 'link-pull-request', payload, sessionId: ctx.sessionId, destination: 'cloud', organizationId: home.organizationId, actorUserId: home.actorUserId })
  }
  return { ok: true, text: `Linked pull request #${identity.number} (${identity.repository}) to this session.` }
}

/** The pull requests linked to the calling session, as the rail shows them. */
async function listCallerPullRequests(ctx: TaskToolCtx): Promise<TaskToolResult> {
  const callerSessionId = ctx.solusSessionId ?? ctx.sessionId
  if (!callerSessionId) return { ok: false, text: 'list_session_pull_requests needs a calling session, and this session has no id yet.' }
  const sessionId = sessionPullRequestOwnerId(callerSessionId)
  const links = (await readSessionPullRequests(ANY_ORGANIZATION, [sessionId]))[sessionId] ?? []
  if (!links.length) return { ok: true, text: 'No pull requests are linked to this session.' }
  const lines = links.map((link) => {
    const state = link.missing ? 'missing' : link.snapshot ? (link.snapshot.draft && link.snapshot.state === 'open' ? 'draft' : link.snapshot.state) : 'not yet synced'
    const title = link.snapshot?.title || link.title
    return `- #${link.number} ${link.repository} [${state}]${title ? ` "${title}"` : ''} — ${link.url} (linked by ${link.source})`
  })
  return { ok: true, text: `Pull requests linked to this session:\n${lines.join('\n')}` }
}

/** The honest answer for a foreign-task write the outbox does not carry: the
 *  task exists, but on another host this one cannot reach. */
function foreignWriteUnsupported(operation: string, taskId: string): string {
  return `Task ${taskId} lives on another host (this session was dispatched), and ${operation} is not supported from here. Use comment_task or update_task_status — those sync back — or note it in your final message.`
}

/**
 * The organization whose Solus API holds this session's records, or null for a
 * session whose records are this machine's. Comments and links, which the record
 * API does not carry, travel to it through the host's delivery queue.
 */
/** Where a queued write of an organization session goes, and whose delegated token delivers it; null for any other session. */
async function organizationHome(toolContext: () => ReturnType<typeof workspaceToolContext>): Promise<DeliveryDestination | null> {
  const { context, remote, deliveryActor } = await toolContext()
  return remote && context.home.kind === 'organization' ? { organizationId: context.home.organizationId, actorUserId: deliveryActor ?? '' } : null
}

/** A queued write says so: it reaches the organization with the host's next delivery, and until then it is pending (organization-vms §3). */
function queuedForOrganization(what: string): string {
  return `${what} is queued for the organization's Solus API and appears there with this machine's next delivery.`
}

/** An organization's task names the repository, not this machine's path; a folder with no remote keeps its path. */
async function organizationProjectKey(projectKey: string): Promise<string> {
  return (await resolveRepositoryKey(projectKey)) ?? projectKey
}

function formatTaskForAgent(
  task: TaskRecord,
  comments: Array<{ author: string; body: string }> = [],
  links: TaskLinkRecord[] = [],
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
      ctx: { cwd: context.cwd, sessionId: context.sessionId(), solusSessionId: context.solusSessionId(), agentProvider: context.provider },
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
export const linkAgentTool = taskAgentTool('link', LINK_DESC, linkFields, true)
export const listSessionPullRequestsAgentTool = taskAgentTool('list_session_pull_requests', LIST_SESSION_PULL_REQUESTS_DESC, listSessionPullRequestsFields, false)
