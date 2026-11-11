import { childPermissionMode } from '../../sessions/child-permissions'
import { z } from 'zod'
import { createLogger } from '../../../logger'
import type { AgentTool } from './agent-tool'
import { basename } from 'node:path'
import { resolveHomePath } from '../../../platform/paths'
import { listProjectRoots } from '../../../db/session-indexer'
import { searchSessionIndex } from '../../../db/session-search'
import { formatPendingInputReport } from '../../sessions/pending-input'
import { plainSnippet } from '@solus/contracts/search-snippet'
import { MODEL_PROFILES, isLegacyModel, PERMISSION_MODES } from '@solus/contracts/types'
import { formatExchangeTag, formatOrchestrationItem, ORCHESTRATION_LIMITS, type OrchestrationItem } from '@solus/contracts/session-exchange'
import type { AgentId, AgentTarget, NormalizedEvent, PlanDescriptor, ReasoningEffort, PermissionMode, SessionMeta, SessionStatus } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { taskIdForSession } from '../../../data/tasks/task-sessions'
import { loadTask } from '../../../data/tasks/task-store'
import { ANY_ORGANIZATION } from '../../../admission/principal'
import { toolMayRead } from '../../../admission/workspace-tool-authority'
import type { Exchange } from '../../orchestration/exchange'
import { MAX_WAIT_MS, type RemoteTarget, type SendOrder, type SpawnedSession, type SpawnOrder } from '../../orchestration/session-orchestrator'
import type { ReachRequest, RemoteHost, RemoteHosts } from '../../orchestration/remote-hosts'
import { agentTargetFromMetadata } from '../agent-targets'
import { hostDisplayName } from '../../../platform/host-display-name'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { MAX_ATTACHMENT_UPLOAD_COUNT } from '@solus/contracts/rpc'
import { checkAttachments } from '../../orchestration/prompt-attachments'
import { findRemoteSession, type OrganizationApi, type RemoteSession } from '../../orchestration/remote-session-read'
import type { AwaitedTasksResult } from '../../sessions/background-work'
import { messageItemId, readTimeline, type TimelineRequest } from './session-timeline'

const log = createLogger('sessions', 'session-tools.ts')

/**
 * The agent-facing session tools. Three act — `start_session`, `send_session`
 * and `stop_session` — and each is a thin adapter over the session orchestrator,
 * which owns the message from dispatch to result. The rest only read. A tool
 * says what it does; when to use it is in the parent's instructions. Tools
 * return error text rather than throwing so a bad call remains recoverable.
 */

const REASONING_VALUES = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'] as const
// Providers that can start a session. 'opencode' is excluded — same constraint
// the automation runner applies (no headless runner yet).
const AGENT_PROVIDER_VALUES = ['claude-code', 'codex'] as const

// ─── Injected orchestrator and controller (wired in server/index.ts) ───

/** The orchestration commands the acting tools call. */
export interface SessionOrchestration {
  spawn(
    senderSessionId: string | undefined,
    order: SpawnOrder,
    report: boolean,
    waitMs?: number,
    requestId?: string,
    target?: RemoteTarget,
  ): Promise<{ exchangeId: string; sessionId: string; starting?: boolean; taskId?: string; waited?: OrchestrationItem | null }>
  send(
    senderSessionId: string,
    targetSessionId: string,
    message: SendOrder,
    target?: RemoteTarget,
  ): Promise<{ exchangeId: string; disposition: 'started' | 'steered' | 'queued'; waited?: OrchestrationItem | null }>
  readExchange?(senderSessionId: string, exchangeId: string): Exchange | undefined
  stop(senderSessionId: string | undefined, targetSessionId: string): boolean
  /** The host a session the sender started runs on, when it is not this host. */
  remoteHostOf?(senderSessionId: string, targetSessionId: string): string | undefined
}

let sessionOrchestration: SessionOrchestration | null = null
export function setSessionOrchestration(orchestration: SessionOrchestration): void {
  sessionOrchestration = orchestration
}

/** The other hosts a turn's person reaches from this host (docs/plans/host-reach.md). */
let remoteHosts: RemoteHosts | null = null
export function setRemoteHosts(hosts: RemoteHosts | null): void {
  remoteHosts = hosts
}

export interface SessionController {
  listAgentTargets?(): Promise<AgentTarget[]>
  permissionModeFor?(sessionId: string): PermissionMode | undefined
  /** What the session's current turn may reach on other hosts; null when its person reaches none from here (a guest). */
  reachRequestFor?(sessionId: string): ReachRequest | null
  /** The Solus APIs of the organizations the session's current turn may read, as its person. */
  organizationApisFor?(sessionId: string): OrganizationApi[]
  getSessionInfo(sessionId: string): Promise<SessionMeta | null>
  /** The last `limit` messages; without a limit, the whole transcript. */
  loadSessionTail(provider: AgentId, sessionId: string, projectPath: string | undefined, limit?: number): Promise<SessionLoadMessage[]>
  liveStatus(sessionId: string): SessionStatus | null
  pendingInputEvents(sessionId: string): NormalizedEvent[]
  loadPlanContent(provider: AgentId, sessionId: string, projectPath: string, planToolUseId: string): Promise<string | null>
  listPlans(provider: AgentId, projectPath: string | undefined, allProjects: boolean): Promise<PlanDescriptor[]>
  invalidatePlanCaches(sessionId: string): void
  /** Mark the background tasks a live session's agent waits on; null when the session is not live. */
  awaitBackgroundTasks?(sessionId: string, taskIds: readonly string[], waiting: boolean): AwaitedTasksResult | null
}

let sessionController: SessionController | null = null
export function setSessionController(controller: SessionController): void {
  sessionController = controller
}

/** The same controller the comment and linked-content tools read through — one
 *  wiring point in `server/index.ts` serves them all. */
export function getSessionController(): SessionController | null {
  return sessionController
}

// ─── Side-effect callback + per-call context ───

export interface SessionToolCtx {
  agentProvider: AgentId
  cwd: string
  /** The calling session; every row the tool writes names it. */
  sessionId: string | undefined
}

export interface SessionToolDeps {
  ctx?: SessionToolCtx
}

// ─── Schema ───

const REPORT_FIELD = z
  .boolean()
  .default(true)
  .describe('Send a notice when the session needs the user or hits a rate limit, and a report when its turn ends. Defaults to true.')

// A page size the agent asks for above this reads this many. Codex drops
// `maximum` from the tool declaration, so an agent cannot see the bound; a
// refused call only costs it a retry.
const MAX_READ_PAGE = 50

const WAIT_FIELD = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_MS / 1000)
  .default(0)
  .describe(`Wait up to ${MAX_WAIT_MS / 1000} seconds for a report or notice. 0 (default) returns at once. Timeout does not cancel work; report=true delivers the result later.`)

const REQUEST_ID_FIELD = z.string().trim().min(1).max(200).optional()
  .describe('Retry key scoped to the caller. Reuse for the same request to prevent duplicate work. Use a new key for each follow-up. Closed receipts last 30 days.')

const HOST_FIELD = z.string().trim().min(1).optional()

const ATTACHMENTS_FIELD = z
  .array(z.string().min(1))
  .max(MAX_ATTACHMENT_UPLOAD_COUNT)
  .optional()
  .describe(`Up to ${MAX_ATTACHMENT_UPLOAD_COUNT} files on this host, 10 MB each, as absolute or cwd-relative paths. Copied now to the target host. PNG, JPEG, GIF and WebP arrive as images; other files arrive as readable paths.`)

export const startSessionFields = {
  prompt: z.string().describe('The prompt the new session starts running immediately.'),
  title: z
    .string()
    .trim()
    .min(1)
    .max(ORCHESTRATION_LIMITS.title)
    .optional()
    .describe('A short name for the session, such as "Server correctness fixes". It names the session and its card in this conversation. Give each session you start a different name. Omit to name it from the prompt.'),
  attachments: ATTACHMENTS_FIELD,
  host: HOST_FIELD.describe("Optional. Start the session on another of your hosts, by its id or name from list_agent_targets. Omit to start it on this host. On another host, task must be 'none'; cwd is a path on that host: pass a project path that list_agent_targets with this host returns, or omit cwd for a new chat folder there; and the provider and model must be ones that host offers."),
  task: z
    .enum(['attempt', 'none'])
    .default('none')
    .describe("Optional task membership. Defaults to none. Use attempt with task_id to join an existing task."),
  task_id: z.string().trim().min(1).optional().describe("The task key of the existing GitHub or Jira task for task='attempt'. Defaults to your current task. Omit with task='none'."),
  agent_provider: z
    .string()
    .optional()
    .describe("Which configured agent runs the session. Defaults to the calling session's provider; call list_agent_targets for current provider and model ids."),
  model_id: z
    .string()
    .min(1)
    .optional()
    .describe('Model id. Omit to inherit the caller’s model on the same provider, or use the selected provider’s default.'),
  reasoning_effort: z
    .enum(REASONING_VALUES)
    .optional()
    .describe("Reasoning effort for the session. Defaults to the model's default level."),
  cwd: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Working directory the session runs in. Defaults to the calling session\'s directory.'),
  worktree_base_branch: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Optional base branch to create an isolated worktree for the new session.'),
  permission_mode: z.enum(PERMISSION_MODES).optional().describe('Inherit the caller’s permission mode, or request a narrower mode.'),
  report: REPORT_FIELD.default(false).describe('Send notices and the final report to this conversation. Defaults to false for independent work.'),
  request_id: REQUEST_ID_FIELD,
  wait_seconds: WAIT_FIELD,
}

const startSessionSchema = z.object(startSessionFields).refine(
  (input) => input.task !== 'none' || input.task_id === undefined,
  { message: "Omit task_id with task='none'. Use task='attempt' to join an existing task.", path: ['task_id'] },
)

const listAgentTargetsFields = {
  host: HOST_FIELD.describe('Optional. List what another of your hosts offers, by its id or name, with its projects to use as start_session cwd. Omit for this host, which also lists the other hosts you can start sessions on.'),
}

// T3 Code's thread read bounds; a larger value reads the bound.
const MAX_READ_ITEMS = 100
const MAX_ITEM_CHARS = 50_000

const readSessionFields = {
  session_id: z.string().describe('The session id to read.'),
  view: z.enum(['messages', 'activity']).optional().describe("'messages' (default): user and assistant messages and plans. 'activity': every item, with tool calls and their output, reasoning, subagents and notices."),
  after_position: z.number().int().min(0).optional().describe('Read the items after this position. Omit to read from the start. Pass nextPosition to read on.'),
  limit: z.number().int().min(1).optional().describe(`Max items, 1 to ${MAX_READ_ITEMS}. Defaults to 50.`),
  max_chars_per_item: z.number().int().min(1).optional().describe(`Max chars per item, 1 to ${MAX_ITEM_CHARS}. Defaults to 20000.`),
  item_id: z.string().optional().describe('Read one item by its itemId, such as the item id a search_sessions result names.'),
  text_offset: z.number().int().min(0).optional().describe('With item_id: read its text from this offset. Pass nextTextOffset to read the rest of a cut item.'),
}

const searchSessionsFields = {
  query: z.string().min(1).describe('Full-text query to search for in session messages.'),
  project: z.string().optional().describe("Optional project to scope to (a project name like 'solus' or a path). Scopes to sessions that RAN IN that repo (its git root + worktrees) — NOT sessions that merely mention it; a discussion about repo X held from inside repo Y is filed under Y. Omit it (the default) to search everything by content — that's the reliable way to find a past discussion; a partial name is fine, and if nothing matches the search falls back to all projects."),
  role: z.enum(['user', 'assistant', 'any']).default('any').describe("Message role to search. Defaults to 'any'."),
  after: z
    .string()
    .optional()
    .describe("Only include messages at or after this instant. ISO 8601 — a date like '2026-06-01' (midnight UTC) or a full timestamp '2026-06-01T09:00:00Z'. Omit to leave the lower bound open. Note the default below: to search further back than 2 weeks you MUST pass this."),
  before: z
    .string()
    .optional()
    .describe("Only include messages at or before this instant. ISO 8601; a date like '2026-06-30' covers through the end of that day. Omit to leave the upper bound open. DEFAULT: with BOTH after and before omitted, the search covers only the last 2 weeks (after = now − 14d, before = now)."),
  limit: z.number().int().min(1).optional().describe(`Maximum results to return. Defaults to 10; at most ${MAX_READ_PAGE}, larger values return ${MAX_READ_PAGE}.`),
}

const sendSessionFields = {
  session_id: z.string().describe('The target session id. Cannot be your own session.'),
  message: z.string().describe('The message to send into the target session.'),
  attachments: ATTACHMENTS_FIELD,
  delivery: z
    .enum(['queue', 'steer'])
    .default('queue')
    .describe("How to deliver the prompt when the target is busy. Use 'steer' when this message should interrupt or redirect the target's current line of work—for example to correct its approach, add a missing constraint, or reprioritize what it is doing now. Use 'queue' (default) for additional or sequential work that should wait until the current turn finishes. Steering is consumed at the provider's next decision point and automatically falls back to queueing if the active turn can no longer accept it."),
  report: REPORT_FIELD,
  request_id: REQUEST_ID_FIELD,
  wait_seconds: WAIT_FIELD,
}

const stopSessionFields = {
  session_id: z.string().describe('The target session id. Cannot be your own session.'),
}

const START_SESSION_DESC =
  "Start an independent Solus conversation in its selected workspace. Use delegate_task for child work. Inherits the caller’s provider and model unless selected. Reports default off. It is not stopped with the caller and does not hold the caller’s work open. Set cwd or worktree_base_branch before launch; host selects another machine. Reuse request_id after a lost reply. Continue with send_session; inspect with read_session or read_session_exchange."
const LIST_AGENT_TARGETS_DESC =
  'List the agent providers and models currently configured on this Solus host for Solus sessions and delegated agents, including runtime availability and supported reasoning levels, and the other hosts you can start sessions on. Superseded model generations are left out (`legacyModelsOmitted` counts them); start_session still accepts their ids. This catalog does not establish native subagent model support; consult the built-in tool schema for that. With `host`, list what that host offers instead, and the projects on that host.'
const SEARCH_SESSIONS_DESC =
  "Full-text search over ALL your past Solus conversations (every project and its worktrees). Reach for it WHENEVER the user refers to a prior discussion — 'the X thread', 'when we talked about Y', 'like we decided before' — instead of answering from memory. Put the topic in `query` and leave `project` unset (topic and working directory routinely differ). Every result carries a clickable session link and a `session id`; call `read_session` with that id and the result's `item id` as `item_id` to read the passage, then page around its position, before you answer. When you cite one of these sessions, copy its link exactly as returned."
const READ_SESSION_DESC =
  "Read any Solus session by id: its status, task, pending input, and timeline. `messages` (default): user and assistant messages and plans. `activity`: every item, with tool calls and their output. Reads from the start; page with `after_position=nextPosition`. Keep reads small: low `limit` and `max_chars_per_item`. Cut-off text: `item_id` with `text_offset=nextTextOffset`. To find a passage, use search_sessions and read its item id. A session not on this host is looked up on your other hosts, then on your organizations' Solus APIs. In your reply, name it as its `link` verbatim."
const SEND_SESSION_DESC =
  "Send a message to another Solus session. `delivery` 'queue' (default) runs it after the session's current turn; 'steer' changes the turn in progress now, and falls back to queue if that turn cannot take it. With `report` on, the outcome comes back like start_session's. Cannot target your own session."
const STOP_SESSION_DESC =
  "Stop another running Solus session and clear its queued prompts. Cannot target your own session."

// ─── Helpers ───

function reasoning(value: ReasoningEffort | undefined, fallback: ReasoningEffort): ReasoningEffort {
  return value ?? fallback
}

function fallbackAgentTargets(): AgentTarget[] {
  return AGENT_PROVIDER_VALUES.map((agentProvider) => {
    const profiles = MODEL_PROFILES[agentProvider] ?? {}
    const models = Object.entries(profiles).map(([id, profile]) => ({
      id,
      label: profile.label,
      reasoningLevels: profile.reasoningLevels,
      defaultReasoningEffort: profile.defaultReasoningEffort,
      defaultContextWindow: profile.defaultContextWindow,
    }))
    return {
      provider: agentProvider,
      label: agentProvider === 'claude-code' ? 'Claude Code' : 'Codex',
      available: true,
      defaultModel: models.find((model) => profiles[model.id]?.isDefault)?.id ?? models[0]?.id ?? '',
      models,
    }
  })
}

async function listAgentTargets(): Promise<AgentTarget[]> {
  return sessionController?.listAgentTargets
    ? await sessionController.listAgentTargets()
    : fallbackAgentTargets()
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 1))}…` : oneLine
}

export function sessionLink(meta: Pick<SessionMeta, 'provider' | 'sessionId' | 'slug' | 'cwd' | 'serverId'>): string {
  const label = meta.slug || meta.sessionId.slice(0, 8)
  const serverId = meta.serverId ? `&serverId=${encodeURIComponent(meta.serverId)}` : ''
  const cwd = meta.cwd ? `&cwd=${encodeURIComponent(meta.cwd)}` : ''
  return `[${label}](session://open?provider=${meta.provider}&sessionId=${meta.sessionId}${serverId}${cwd})`
}

/** Match the agent's free-text `project` against the known git-roots. Simple by
 *  design: exact-ish name/path via case-insensitive substring, no fuzzy scoring.
 *  One hit → scope it; several partial hits → hand back candidates so the model
 *  re-picks; zero hits → 'none' so the caller searches all projects rather than
 *  dead-ending on a wall of every known root. */
function resolveProject(
  input: string,
):
  | { kind: 'one'; projectRoot: string; name: string }
  | { kind: 'candidates'; candidates: Array<{ projectRoot: string; name: string; count: number }> }
  | { kind: 'none' } {
  const roots = listProjectRoots()
  const q = input.trim().toLowerCase()
  const exact = roots.filter((r) => r.name.toLowerCase() === q || r.projectRoot.toLowerCase() === q)
  const hits = exact.length ? exact
    : roots.filter((r) => r.name.toLowerCase().includes(q) || r.projectRoot.toLowerCase().includes(q))
  if (hits.length === 1) return { kind: 'one', projectRoot: hits[0].projectRoot, name: hits[0].name }
  if (hits.length === 0) return { kind: 'none' }
  return { kind: 'candidates', candidates: hits }
}

async function taskSummaryForSession(sessionId: string): Promise<string | null> {
  const taskId = await taskIdForSession(ANY_ORGANIZATION, sessionId)
  if (!taskId) return null
  // A link needs no copy of the task: the key still names it.
  const task = await loadTask(taskId)
  return task ? `${task.id} [${task.category}] ${task.title}` : taskId
}

/** The time window of a search. */
interface SearchWindow {
  sinceTs: number | undefined
  untilTs: number | undefined
  rangeNote: string
}

/**
 * Absolute time bounds for a search. A date-only `before` covers through the
 * end of that day. With no bounds at all the search covers the last two weeks;
 * giving either bound leaves the other side open.
 */
function searchWindow(afterArg: string, beforeArg: string): SearchWindow | { error: string } {
  const parseBound = (value: string, endOfDay: boolean): number | null => {
    const base = new Date(value).getTime()
    if (!Number.isFinite(base)) return null
    return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? base + 86_399_999 : base
  }
  const sinceTs = afterArg ? parseBound(afterArg, false) : undefined
  if (sinceTs === null) return { error: `search_sessions: could not parse after="${afterArg}". Use an ISO date like 2026-06-01 or 2026-06-01T09:00:00Z.` }
  const untilTs = beforeArg ? parseBound(beforeArg, true) : undefined
  if (untilTs === null) return { error: `search_sessions: could not parse before="${beforeArg}". Use an ISO date like 2026-06-30 or 2026-06-30T23:59:59Z.` }
  if (sinceTs !== undefined && untilTs !== undefined && sinceTs > untilTs) {
    return { error: `search_sessions: after (${afterArg}) is later than before (${beforeArg}) — no messages can match.` }
  }
  if (sinceTs !== undefined || untilTs !== undefined) return { sinceTs, untilTs, rangeNote: '' }
  const now = Date.now()
  return {
    sinceTs: now - 14 * 24 * 60 * 60 * 1_000,
    untilTs: now,
    rangeNote: 'No time range given — searched the last 2 weeks. Pass after="YYYY-MM-DD" (optionally with before) to search a different window.\n\n',
  }
}

/** Where the outcome goes, in the call's first line. */
function outcomeNote(report: boolean, waitMs: number, waited: OrchestrationItem | null | undefined): string {
  if (waited?.type === 'report') return ' It finished while you waited; its report follows.'
  if (waited?.type === 'notice') return ` It stopped while you waited; the notice follows. It is still open${report ? ', and its outcome comes back here' : ''}.`
  const still = waitMs > 0 ? ` Still running after ${Math.round(waitMs / 1000)} s.` : ''
  return `${still}${report ? ' Its outcome comes back here.' : ''}`
}

/** What arrived while the call waited. Last in the result, after the exchange
 *  tag, so a report's reply runs to the end of the text. */
function waitedBlock(waited: OrchestrationItem | null | undefined): string {
  return waited ? `\n\n${formatOrchestrationItem(waited)}` : ''
}

/** The other host a session the caller started runs on, if any. */
function remoteHostOf(deps: SessionToolDeps, sessionId: string): string | undefined {
  const caller = deps.ctx?.sessionId
  return caller ? sessionOrchestration?.remoteHostOf?.(caller, sessionId) : undefined
}

export async function findSession(sessionId: string): Promise<SessionMeta | null> {
  if (!sessionController) return null
  return sessionController.getSessionInfo(sessionId)
}

// ─── Executor (shared by Claude SDK tool + Codex handler) ───

export interface SessionToolResult {
  ok: boolean
  text: string
}

export async function executeSessionTool<Input>(
  name: string,
  args: Input,
  deps: SessionToolDeps = {},
): Promise<SessionToolResult> {
  const handler = SESSION_TOOL_HANDLERS.get(name)
  if (!handler) return { ok: false, text: `Unknown session tool: ${name}` }
  try {
    return await handler(args, deps)
  } catch (err: any) {
    log.error('session_tool_failed', { tool: name, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, text: `Session tool error: ${String(err?.message ?? err)}` }
  }
}

type SessionToolHandler = <Input>(args: Input, deps: SessionToolDeps) => Promise<SessionToolResult>

/** Validate at dispatch so each handler receives only its schema's output. */
function validatedSessionTool<Args>(
  schema: z.ZodType<Args>,
  handler: (args: Args, deps: SessionToolDeps) => Promise<SessionToolResult>,
  invalidArguments: (error: z.ZodError) => string,
): SessionToolHandler {
  return async (args, deps) => {
    const parsed = schema.safeParse(args)
    if (!parsed.success) {
      return { ok: false, text: invalidArguments(parsed.error) }
    }
    return handler(parsed.data, deps)
  }
}

async function listAgentTargetsTool(args: z.infer<z.ZodObject<typeof listAgentTargetsFields>>, deps: SessionToolDeps): Promise<SessionToolResult> {
  if (args.host) {
    const remote = await connectRemoteHost(args.host, deps.ctx?.sessionId)
    if ('error' in remote) return { ok: false, text: remote.error }
    const targets = await remoteAgentTargets(remote)
    if ('error' in targets) return { ok: false, text: targets.error }
    const projects = await remoteProjects(remote)
    return { ok: true, text: JSON.stringify({ host: remote.label, targets: currentModelsOnly(targets), ...(projects && { projects }) }, null, 2) }
  }
  const targets = currentModelsOnly(await listAgentTargets())
  const request = deps.ctx?.sessionId ? reachRequestOf(deps.ctx.sessionId) : null
  const hosts = remoteHosts && request ? await remoteHosts.list(request) : null
  if (!hosts || 'error' in hosts) return { ok: true, text: JSON.stringify({ targets }, null, 2) }
  const otherHosts = hosts.map((host) => {
    const listed: OtherHost = { id: host.hostId, name: host.label }
    if (host.managedState) listed.state = host.managedState
    return listed
  })
  return { ok: true, text: JSON.stringify({ targets, otherHosts }, null, 2) }
}

/** A target as list_agent_targets prints it: the current models, and how many superseded ones it left out. */
type ListedTarget = AgentTarget & { legacyModelsOmitted?: number }

/** Keep the list short: a superseded model stays valid for start_session, but an agent reading
 *  every generation of every provider picks an old one as often as not. */
function currentModelsOnly(targets: readonly AgentTarget[]): ListedTarget[] {
  return targets.map((target) => {
    const models = target.models.filter((model) => !isLegacyModel(target.provider, model.id))
    const omitted = target.models.length - models.length
    return omitted > 0 ? { ...target, models, legacyModelsOmitted: omitted } : target
  })
}

/** One of the owner's other hosts, as list_agent_targets names it. */
interface OtherHost {
  id: string
  name: string
  /** A managed host's lifecycle; work starts only on a `ready` one. */
  state?: string
}

/** The connection to one of the owner's other hosts, by id or name. */
async function connectRemoteHost(ref: string, callerSessionId: string | undefined): Promise<RemoteHost | { error: string }> {
  if (!remoteHosts) return { error: 'This host cannot reach other hosts.' }
  const request = callerSessionId ? reachRequestOf(callerSessionId) : null
  if (!request) return { error: 'Only a person with access to this host can reach their other hosts from it.' }
  const found = await remoteHosts.find(request, ref)
  if ('error' in found) return found
  return remoteHosts.connect(found)
}

/** What the turn may reach; with no controller (tests, a bare host), the owner's own reach. */
function reachRequestOf(sessionId: string): ReachRequest | null {
  return sessionController?.reachRequestFor ? sessionController.reachRequestFor(sessionId) : { account: null, isOwner: true }
}

/** What another host offers, read the way a client reads it. */
async function remoteAgentTargets(remote: RemoteHost): Promise<AgentTarget[] | { error: string }> {
  try {
    const info = await remote.call('the agent list', () => remote.api.start())
    return info.agents.map(agentTargetFromMetadata)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** The projects on another host, so a session there can start in one; null when that host does not answer. */
async function remoteProjects(remote: RemoteHost): Promise<{ name: string; path: string }[] | null> {
  try {
    const projects = await remote.call('the project list', () => remote.api.listProjects())
    return projects.map((project) => ({ name: project.folderName, path: project.path }))
  } catch (error) {
    log.warn('remote_projects_unavailable', { host: remote.label, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

async function readSessionTool(args: z.infer<z.ZodObject<typeof readSessionFields>>, deps: SessionToolDeps): Promise<SessionToolResult> {
  if (!sessionController) return { ok: false, text: 'read_session is unavailable — no session controller is wired.' }
  const controller = sessionController
  const request: TimelineRequest = {
    view: args.view ?? 'messages',
    afterPosition: args.after_position ?? -1,
    limit: Math.min(args.limit ?? 50, MAX_READ_ITEMS),
    maxCharsPerItem: Math.min(args.max_chars_per_item ?? 20_000, MAX_ITEM_CHARS),
    ...(args.item_id !== undefined && { itemId: args.item_id, textOffset: args.text_offset ?? 0 }),
  }
  const requestedId = args.session_id.trim()
  // A member's or guest's turn reads only a session the person may open.
  if (!(await toolMayRead({ kind: 'session', id: requestedId }))) return { ok: false, text: `No session ${requestedId} that this turn may read.` }
  const meta = await findSession(requestedId)
  if (!meta) {
    const remote = await findOffHost(requestedId, deps.ctx?.sessionId)
    // Its task and pending input stay on the host that holds it.
    if (remote) return readResult({ meta: remote.meta, status: remote.meta.status ?? 'idle', foundOn: remote.source }, await remote.load(), request)
    const remoteHost = remoteHostOf(deps, requestedId)
    if (remoteHost) return { ok: false, text: `Session ${requestedId} runs on ${remoteHost}, which did not answer. Its report comes back here, and read_session_exchange reads it.` }
    return { ok: false, text: `Session ${requestedId} not found on this host, your other hosts, or your organizations' Solus APIs.` }
  }
  // The session read may name a thread; everything below names the session.
  const sessionId = meta.sessionId
  const messages = await controller.loadSessionTail(meta.provider, sessionId, meta.projectPath || deps.ctx?.cwd)
  return readResult({
    meta,
    status: controller.liveStatus(sessionId) ?? meta.status ?? 'idle',
    task: await taskSummaryForSession(sessionId),
    pendingInput: formatPendingInputReport(controller.pendingInputEvents(sessionId)),
  }, messages, request)
}

/** What read_session says about a session beside its timeline. */
interface SessionReadContext {
  meta: SessionMeta
  status: SessionStatus
  task?: string | null
  pendingInput?: string | null
  /** The other host or Solus API that answered, when this host does not hold it. */
  foundOn?: string
}

function readResult(context: SessionReadContext, messages: readonly SessionLoadMessage[], request: TimelineRequest): SessionToolResult {
  const page = readTimeline(messages, request)
  const { meta } = context
  if (request.itemId !== undefined && !page.items.length) return { ok: false, text: `Session ${meta.sessionId} has no item ${request.itemId}.` }
  const session = {
    sessionId: meta.sessionId,
    link: sessionLink(meta),
    title: meta.customTitle || meta.slug || null,
    status: context.status,
    provider: meta.provider,
    model: meta.model ?? null,
    reasoningEffort: meta.reasoningEffort ?? null,
    workingDirectory: meta.cwd,
    branch: meta.branch ?? null,
    parentSessionId: meta.delegation?.parentSessionId ?? null,
    ...(context.foundOn !== undefined && { foundOn: context.foundOn }),
    ...(context.task !== undefined && { task: context.task }),
    ...(context.pendingInput && { pendingInput: context.pendingInput }),
    itemCount: page.itemCount,
    updatedAt: meta.lastTimestamp,
  }
  return { ok: true, text: JSON.stringify({ session, items: page.items, nextPosition: page.nextPosition, hasMore: page.hasMore }, null, 2) }
}

/** The session on one of the person's other hosts or organizations' Solus APIs; null when none has it. */
async function findOffHost(sessionId: string, callerSessionId: string | undefined): Promise<RemoteSession | null> {
  if (!callerSessionId) return null
  const request = reachRequestOf(callerSessionId)
  const targets = remoteHosts && request ? await remoteHosts.list(request) : []
  const hosts = 'error' in targets ? [] : targets.flatMap((target) => {
    const connected = remoteHosts!.connect(target)
    return 'error' in connected ? [] : [connected]
  })
  const apis = sessionController?.organizationApisFor?.(callerSessionId) ?? []
  return findRemoteSession(sessionId, hosts, apis)
}

async function searchSessionsTool(args: z.infer<z.ZodObject<typeof searchSessionsFields>>): Promise<SessionToolResult> {
  const query = args.query.trim()
  if (!query) return { ok: false, text: 'search_sessions requires a non-empty query.' }

  const role = args.role
  const window = searchWindow(args.after?.trim() ?? '', args.before?.trim() ?? '')
  if ('error' in window) return { ok: false, text: window.error }
  const { sinceTs, untilTs, rangeNote } = window
  const limit = Math.min(args.limit ?? 10, MAX_READ_PAGE)

  // Resolve the optional project scope. No project → search all projects.
  let projectRoot: string | undefined
  let scopeNote = ''
  const projectArg = args.project?.trim() ?? ''
  if (projectArg) {
    const resolved = resolveProject(projectArg)
    if (resolved.kind === 'one') {
      projectRoot = resolved.projectRoot
      scopeNote = `Scoped to project ${resolved.name} (${resolved.projectRoot}).\n\n`
    } else if (resolved.kind === 'candidates') {
      const list = resolved.candidates
        .map((c) => `- ${c.name} (${c.projectRoot}) — ${c.count} session${c.count === 1 ? '' : 's'}`)
        .join('\n')
      return { ok: true, text: `"${projectArg}" matched more than one project. Re-call with an exact name from:\n${list}` }
    } else {
      // No known git-root matched — don't dead-end. Search all projects by
      // content (the reliable path anyway) and say so.
      scopeNote = `No project matched "${projectArg}" — searched all projects instead.\n\n`
    }
  }

  const found = searchSessionIndex(query, {
    projectRoot,
    role: role === 'any' ? undefined : role,
    sinceTs,
    untilTs,
    limit,
  }).results
  // A member's or guest's turn finds only sessions the person may open.
  const readable = await Promise.all(found.map((result) => toolMayRead({ kind: 'session', id: result.session.sessionId })))
  const results = found.filter((_, index) => readable[index])
  if (!results.length) return { ok: true, text: `${scopeNote}${rangeNote}No matching sessions.` }
  const lines = results.map(({ session, snippet, ts, target }) => {
    const project = session.projectRoot ? basename(session.projectRoot) : '(unknown)'
    const item = target ? `\nitem id: ${messageItemId(target.role, target.messageId, target.timestamp)}` : ''
    return `${sessionLink(session)}\nproject: ${project} (${session.projectRoot ?? session.cwd})\nprovider: ${session.provider}\nsession id: ${session.sessionId}${item}\ntimestamp: ${new Date(ts).toISOString()}\nsnippet: ${snippet ? truncate(plainSnippet(snippet), 500) : '(matched by its name)'}`
  })
  const nextStep = '→ To read a passage, call read_session with its session id and item_id. Its position tells you where to page from: after_position reads what follows it.'
  return { ok: true, text: `${scopeNote}${rangeNote}Search results:\n\n${lines.join('\n\n')}\n\n${nextStep}` }
}

async function sendSessionTool(args: z.infer<z.ZodObject<typeof sendSessionFields>>, deps: SessionToolDeps): Promise<SessionToolResult> {
  if (!sessionOrchestration) return { ok: false, text: 'send_session is unavailable — no session orchestrator is wired.' }
  const sessionId = args.session_id.trim()
  const callerSessionId = deps.ctx?.sessionId
  if (!callerSessionId) return { ok: false, text: 'send_session is unavailable before the calling session is initialized.' }
  if (sessionId === callerSessionId) return { ok: false, text: 'Cannot message your own session.' }
  const message = args.message
  if (!message.trim()) return { ok: false, text: 'send_session requires a non-empty message.' }
  const report = args.report
  const waitMs = args.wait_seconds * 1000
  const order: SendOrder = { prompt: message, delivery: args.delivery, notify: report, waitMs }
  if (args.request_id) order.requestId = args.request_id
  const recipient = await sendRecipient(sessionId, callerSessionId, deps)
  if ('error' in recipient) return { ok: false, text: recipient.error }
  const attachError = await attachTo(order, args.attachments, deps)
  if (attachError) return { ok: false, text: attachError }
  const sent = await sessionOrchestration.send(callerSessionId, recipient.sessionId, order, recipient.target)
  const dispatch = sent.disposition === 'queued'
    ? 'Queued for'
    : sent.disposition === 'steered'
      ? 'Steered the turn in progress in'
      : 'Sent to'
  const provider = recipient.meta?.provider ?? sessionOrchestration.readExchange?.(callerSessionId, sent.exchangeId)?.provider ?? deps.ctx!.agentProvider
  return {
    ok: true,
    text: `${dispatch} ${recipientLink(recipient, provider)}.${outcomeNote(report, waitMs, sent.waited)}\n${formatExchangeTag({ messageId: sent.exchangeId, sessionId: recipient.sessionId, provider, serverId: recipient.target?.host.installationId })}${waitedBlock(sent.waited)}`,
  }
}

/** Who a message goes to: a session on this host, or one this session started on another. */
type SendRecipient =
  | { sessionId: string; meta: SessionMeta; target?: undefined }
  | { sessionId: string; meta?: undefined; target: RemoteTarget }

async function sendRecipient(sessionId: string, callerSessionId: string, deps: SessionToolDeps): Promise<SendRecipient | { error: string }> {
  const remoteHost = remoteHostOf(deps, sessionId)
  if (remoteHost) {
    // The other host is reached for the turn's person, as for start_session.
    const target = await remoteTarget(remoteHost, callerSessionId)
    return 'error' in target ? target : { sessionId, target }
  }
  const meta = await findSession(sessionId)
  if (!meta) return { error: `Session ${sessionId} not found.` }
  if (meta.sessionId === callerSessionId) return { error: 'Cannot message your own session.' }
  return { sessionId: meta.sessionId, meta }
}

/** A client opens a session on another host by that host's id. */
function recipientLink(recipient: SendRecipient, provider: AgentId): string {
  if (recipient.meta) return sessionLink(recipient.meta)
  const { host } = recipient.target
  return `${sessionLink({ provider, sessionId: recipient.sessionId, slug: null, cwd: '', serverId: host.installationId })} on ${host.label}`
}

/** Adds the files the agent attached to the order. Returns why one cannot be sent, or null. */
async function attachTo(order: { attachments?: string[] }, paths: string[] | undefined, deps: SessionToolDeps): Promise<string | null> {
  if (!paths?.length) return null
  const checked = await checkAttachments(paths, deps.ctx?.cwd ?? resolveHomePath('~'))
  if ('error' in checked) return checked.error
  order.attachments = checked
  return null
}

/** Another host, reached as `start_session` with `host` reaches it. */
async function remoteTarget(hostRef: string, callerSessionId: string): Promise<RemoteTarget | { error: string }> {
  const remote = await connectRemoteHost(hostRef, callerSessionId)
  if ('error' in remote) return remote
  return { host: remote, origin: { kind: 'session', hostLabel: hostDisplayName(), sessionId: callerSessionId } }
}

const readExchangeFields = {
  exchange_id: z.string().min(1).describe('The exchange id returned by delegate_task, start_session, or send_session.'),
  reply_offset: z.number().int().nonnegative().optional().describe('Read the full saved reply in bounded pages. Start at 0, then use the returned next_reply_offset until it is null. Offsets count UTF-16 code units.'),
}

async function readExchangeTool(args: z.infer<z.ZodObject<typeof readExchangeFields>>, deps: SessionToolDeps): Promise<SessionToolResult> {
  const sender = deps.ctx?.sessionId
  if (!sender) return { ok: false, text: 'read_session_exchange requires exchange_id and an initialized calling session.' }
  const exchange = sessionOrchestration?.readExchange?.(sender, args.exchange_id)
  if (!exchange) return { ok: false, text: 'Exchange not found for this calling session.' }
  const lines = [`Exchange ${exchange.exchangeId}: ${exchange.state}. Session ${exchange.targetSessionId}.`]
  if (exchange.deliveryState) lines.push(`Report delivery: ${exchange.deliveryState}.`)
  if (exchange.report) {
    const offset = args.reply_offset
    if (offset === undefined) lines.push(formatOrchestrationItem({ type: 'report', report: exchange.report }))
    else {
      const reply = exchange.report.reply
      if (offset > reply.length) return { ok: false, text: `reply_offset exceeds the saved reply length (${reply.length}).` }
      const end = Math.min(reply.length, offset + ORCHESTRATION_LIMITS.replyPage)
      lines.push(`Reply characters ${offset}-${end} of ${reply.length}:\n${reply.slice(offset, end)}`, `next_reply_offset: ${end < reply.length ? end : 'null'}`)
    }
  }
  return { ok: true, text: lines.join('\n\n') }
}

async function stopSessionTool(args: z.infer<z.ZodObject<typeof stopSessionFields>>, deps: SessionToolDeps): Promise<SessionToolResult> {
  if (!sessionOrchestration) return { ok: false, text: 'stop_session is unavailable — no session orchestrator is wired.' }
  const sessionId = args.session_id.trim()
  if (sessionId === deps.ctx?.sessionId) return { ok: false, text: 'Cannot stop your own session.' }
  const remoteHost = remoteHostOf(deps, sessionId)
  if (remoteHost) {
    return sessionOrchestration.stop(deps.ctx?.sessionId, sessionId)
      ? { ok: true, text: `Asked ${remoteHost} to stop session ${sessionId}. Its report says when it stopped.` }
      : { ok: true, text: `Session ${sessionId} on ${remoteHost} is not running a turn you sent.` }
  }
  const meta = await findSession(sessionId)
  if (!meta) return { ok: false, text: `Session ${sessionId} not found.` }
  return sessionOrchestration.stop(deps.ctx?.sessionId, meta.sessionId)
    ? { ok: true, text: `Stopped session ${sessionId}.` }
    : { ok: true, text: `Session ${sessionId} is not currently running.` }
}

async function startSessionTool(input: z.infer<typeof startSessionSchema>, deps: SessionToolDeps): Promise<SessionToolResult> {
  return launchSession(input, deps, true)
}

/** Resolve defaults and admission for both independent starts and child delegation. */
export async function launchSession(input: z.infer<typeof startSessionSchema>, deps: SessionToolDeps, independent: boolean): Promise<SessionToolResult> {
  if (!input.prompt.trim()) return { ok: false, text: 'A session launch requires a non-empty prompt.' }
  if (!sessionOrchestration) {
    return { ok: false, text: 'Session launch is unavailable — it requires an active control plane.' }
  }
  input = await sessionStartDefaults(input, deps)
  if (input.host) {
    if (!input.permission_mode) return { ok: false, text: 'The caller’s permission policy is unavailable. Remote work was not started.' }
    return startRemoteSessionTool(sessionOrchestration, input, input.host, deps, independent)
  }
  const runner = chooseRunner(await listAgentTargets(), input.agent_provider ?? deps.ctx?.agentProvider ?? 'claude-code', input.model_id, input.reasoning_effort)
  if ('error' in runner) return { ok: false, text: runner.error }
  const binding = await resolveStartTask(input.task, input.task_id, deps.ctx?.sessionId)
  if ('error' in binding) return { ok: false, text: binding.error }
  const { taskId } = binding

  const { modelId, reasoningEffort, contextWindow } = runner
  const cwd = resolveHomePath(input.cwd?.trim() || deps.ctx?.cwd || '~')
  const waitMs = input.wait_seconds * 1000
  const order: SpawnOrder = {
    prompt: input.prompt,
    independent,
    permissionMode: input.permission_mode,
    title: input.title,
    provider: runner.provider,
    modelId,
    reasoningEffort,
    contextWindow,
    cwd,
    worktreeBaseBranch: input.worktree_base_branch?.trim() || null,
    taskId,
  }
  const attachError = await attachTo(order, input.attachments, deps)
  if (attachError) return { ok: false, text: attachError }
  // The orchestrator puts the card in this conversation before the session
  // starts — startup can take a while. The session's id is known from the start.
  const created = await sessionOrchestration.spawn(deps.ctx?.sessionId, order, input.report, waitMs, input.request_id)

  if (created.starting) return { ok: true, text: formatPendingSessionReceipt(created, runner, input.report, waitMs) }
  return { ok: true, text: formatStartedSessionReceipt(created, runner, cwd, input.report, waitMs) }
}

async function sessionStartDefaults(input: z.infer<typeof startSessionSchema>, deps: SessionToolDeps): Promise<z.infer<typeof startSessionSchema>> {
  const caller = deps.ctx?.sessionId ? await sessionController?.getSessionInfo(deps.ctx.sessionId) : null
  const provider = input.agent_provider ?? deps.ctx?.agentProvider ?? 'claude-code'
  const inheritsModel = !input.model_id && caller?.provider === provider
  input = { ...input, agent_provider: provider,
    model_id: input.model_id ?? (inheritsModel ? caller?.model : undefined),
    reasoning_effort: input.reasoning_effort ?? (inheritsModel ? caller?.reasoningEffort : undefined),
  }
  const parentMode = deps.ctx?.sessionId ? sessionController?.permissionModeFor?.(deps.ctx.sessionId) : undefined
  if (parentMode) input.permission_mode = childPermissionMode(parentMode, input.permission_mode)
  return input
}

function formatStartedSessionReceipt(created: SpawnedSession, runner: Runner, cwd: string, report: boolean, waitMs: number): string {
  const { provider, modelId, reasoningEffort } = runner
  return `Session ${sessionLink({ provider, sessionId: created.sessionId, slug: null, cwd })} on ${provider}/${modelId} (reasoning: ${reasoningEffort}).${created.taskId ? ` Task ${created.taskId}.` : ''}${outcomeNote(report, waitMs, created.waited)}\n${formatExchangeTag({ messageId: created.exchangeId, sessionId: created.sessionId, provider })}${waitedBlock(created.waited)}`
}

/** `start_session` with `host`: the session starts on another of the owner's
 *  hosts, as if the owner started it there (docs/plans/cross-host-sessions.md). */
async function startRemoteSessionTool(
  orchestration: SessionOrchestration,
  input: z.infer<typeof startSessionSchema>,
  hostRef: string,
  deps: SessionToolDeps,
  independent: boolean,
): Promise<SessionToolResult> {
  const callerSessionId = deps.ctx?.sessionId
  if (!callerSessionId) return { ok: false, text: 'start_session on another host is unavailable before the calling session is initialized.' }
  if (input.task !== 'none') return { ok: false, text: "A session on another host cannot join a task yet. Use task='none'." }
  const target = await remoteTarget(hostRef, callerSessionId)
  if ('error' in target) return { ok: false, text: target.error }
  const remote = target.host
  const targets = await remoteAgentTargets(remote)
  if ('error' in targets) return { ok: false, text: targets.error }
  const runner = chooseRunner(targets, input.agent_provider ?? deps.ctx?.agentProvider ?? 'claude-code', input.model_id, input.reasoning_effort)
  if ('error' in runner) return { ok: false, text: `${runner.error} (on ${remote.label})` }
  const { provider, modelId, reasoningEffort, contextWindow } = runner
  // A path on the other host: it is resolved there, never here.
  const cwd = input.cwd?.trim() || NEW_CHAT_DIRECTORY
  const waitMs = input.wait_seconds * 1000
  const order: SpawnOrder = {
    prompt: input.prompt,
    independent,
    permissionMode: input.permission_mode,
    title: input.title,
    provider: runner.provider,
    modelId,
    reasoningEffort,
    contextWindow,
    cwd,
    worktreeBaseBranch: input.worktree_base_branch?.trim() || null,
    taskId: null,
  }
  const attachError = await attachTo(order, input.attachments, deps)
  if (attachError) return { ok: false, text: attachError }
  const created = await orchestration.spawn(callerSessionId, order, input.report, waitMs, input.request_id, target)
  // A client opens it on its host, which knows where it runs.
  const link = sessionLink({ provider, sessionId: created.sessionId, slug: null, cwd: '', serverId: remote.installationId })
  return {
    ok: true,
    text: `Session ${link} on ${remote.label}, ${provider}/${modelId} (reasoning: ${reasoningEffort}).${outcomeNote(input.report, waitMs, created.waited)}\n${formatExchangeTag({ messageId: created.exchangeId, sessionId: created.sessionId, provider, serverId: remote.installationId })}${waitedBlock(created.waited)}`,
  }
}

/** A session whose provider has not started yet: its id is real, but there is no transcript to read. */
function formatPendingSessionReceipt(created: SpawnedSession, runner: Runner, report: boolean, waitMs: number): string {
  const startup = created.waited?.type === 'report' ? 'Provider startup ended.' : 'Startup continues in the background.'
  return `Accepted session ${created.sessionId} on ${runner.provider}/${runner.modelId} (reasoning: ${runner.reasoningEffort}). ${startup}${created.taskId ? ` Task ${created.taskId}.` : ''}${outcomeNote(report, waitMs, created.waited)} Use read_session_exchange with exchange_id=${created.exchangeId} for the startup state.\n${formatExchangeTag({ messageId: created.exchangeId, sessionId: created.sessionId, provider: runner.provider })}${waitedBlock(created.waited)}`
}

type StartTaskBinding = { taskId: string | null } | { error: string }

/** An attempt joins an explicit task or the caller's own task. */
async function resolveStartTask(task: 'attempt' | 'none', explicitTaskId: string | undefined, callerSessionId: string | undefined): Promise<StartTaskBinding> {
  if (task === 'none') return { taskId: null }
  const taskId = explicitTaskId?.trim()
    || (callerSessionId ? await taskIdForSession(ANY_ORGANIZATION, callerSessionId) ?? undefined : undefined)
  return taskId ? { taskId } : { error: "This session has no task to join. Use task='none', or task='attempt' with a task_id." }
}

/** The provider, model and reasoning level a started session runs on. */
interface Runner {
  provider: AgentId
  modelId: string
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
}

/** Checks the requested provider, model and reasoning level against what the host offers. */
function chooseRunner(targets: readonly AgentTarget[], requestedProvider: string, requestedModel: string | undefined, requestedEffort: ReasoningEffort | undefined): Runner | { error: string } {
  const target = targets.find((candidate) => candidate.provider === requestedProvider)
  if (!target) return { error: `Unknown agent provider "${requestedProvider}". Call list_agent_targets for current choices.` }
  if (!target.available) {
    return { error: `Agent provider "${requestedProvider}" is unavailable${target.unavailableReason ? `: ${target.unavailableReason}` : '.'}` }
  }
  const modelId = requestedModel?.trim() || target.defaultModel
  if (!modelId) return { error: 'start_session requires model_id.' }
  const profile = target.models.find((model) => model.id === modelId)
  if (!profile) {
    return { error: `Unknown model "${modelId}" for ${target.provider}. Valid models: ${target.models.map((model) => model.id).join(', ') || '(none)'}.` }
  }
  const reasoningEffort = reasoning(requestedEffort, profile.defaultReasoningEffort)
  if (profile.reasoningLevels.length > 0 && !profile.reasoningLevels.includes(reasoningEffort)) {
    return { error: `Model "${modelId}" does not support reasoning level "${reasoningEffort}". Supported: ${profile.reasoningLevels.join(', ')}.` }
  }
  return { provider: target.provider, modelId, reasoningEffort, contextWindow: profile.defaultContextWindow }
}

const SESSION_TOOL_HANDLERS = new Map<string, SessionToolHandler>([
  ['list_agent_targets', validatedSessionTool(z.object(listAgentTargetsFields), listAgentTargetsTool, () => 'list_agent_targets received invalid arguments.')],
  ['read_session', validatedSessionTool(z.object(readSessionFields), readSessionTool,
    (error) => `read_session received invalid arguments: ${error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)],
  ['read_session_exchange', validatedSessionTool(z.object(readExchangeFields), readExchangeTool, () => 'read_session_exchange requires exchange_id and an initialized calling session.')],
  ['search_sessions', validatedSessionTool(z.object(searchSessionsFields), searchSessionsTool, () => 'search_sessions requires a non-empty query.')],
  ['send_session', validatedSessionTool(z.object(sendSessionFields), sendSessionTool, () => 'send_session received invalid arguments.')],
  ['stop_session', validatedSessionTool(z.object(stopSessionFields), stopSessionTool, () => 'stop_session requires session_id.')],
  ['start_session', validatedSessionTool(startSessionSchema, startSessionTool,
    (error) => `Invalid arguments for start_session: ${z.prettifyError(error).slice(0, 1200)}`)],
])

function sessionAgentTool(
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
    execute: async (args, context) => executeSessionTool(name, args, {
      ctx: {
        agentProvider: context.provider,
        cwd: resolveHomePath(context.cwd),
        sessionId: context.sessionId(),
      },
    }),
  }
}

export const searchSessionsAgentTool = sessionAgentTool('search_sessions', SEARCH_SESSIONS_DESC, searchSessionsFields, false)
export const listAgentTargetsAgentTool = sessionAgentTool('list_agent_targets', LIST_AGENT_TARGETS_DESC, listAgentTargetsFields, false)
export const readSessionExchangeAgentTool = sessionAgentTool('read_session_exchange', 'Read the stored state and result of a message this session sent. Use when a result is needed mid-turn, or after a timeout or restart. This read does not consume or cancel a pending report. A completed provider turn can still be waiting_for_children; settled is the final exchange result.', readExchangeFields, false)
export const readSessionAgentTool = sessionAgentTool('read_session', READ_SESSION_DESC, readSessionFields, false)
export const startSessionAgentTool = sessionAgentTool('start_session', START_SESSION_DESC, startSessionFields, false)
startSessionAgentTool.alwaysLoad = true
export const sendSessionAgentTool = sessionAgentTool('send_session', SEND_SESSION_DESC, sendSessionFields, false)
export const stopSessionAgentTool = sessionAgentTool('stop_session', STOP_SESSION_DESC, stopSessionFields, false)

export const sessionAgentTools: AgentTool[] = [
  listAgentTargetsAgentTool,
  searchSessionsAgentTool,
  readSessionAgentTool,
  readSessionExchangeAgentTool,
  startSessionAgentTool,
  sendSessionAgentTool,
  stopSessionAgentTool,
]
