import { z } from 'zod'
import { createLogger } from '../../../logger'
import type { AgentTool } from './agent-tool'
import { basename } from 'node:path'
import { resolveHomePath } from '../../../platform/paths'
import { getSessionMessages, listProjectRoots } from '../../../db/session-indexer'
import { searchSessionIndex } from '../../../db/session-search'
import { formatPendingInputReport } from '../../sessions/pending-input'
import { plainSnippet } from '@solus/contracts/search-snippet'
import { MODEL_PROFILES } from '@solus/contracts/types'
import { formatExchangeTag, formatOrchestrationItem, ORCHESTRATION_LIMITS, type OrchestrationItem } from '@solus/contracts/session-exchange'
import type { AgentId, AgentTarget, NormalizedEvent, PlanDescriptor, ReasoningEffort, SessionMeta, SessionStatus } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { Task } from '../../../data/tasks/task'
import { ANY_ORGANIZATION } from '../../../admission/principal'
import type { Exchange } from '../../orchestration/exchange'
import { MAX_WAIT_MS, type RemoteTarget, type SendOrder, type SpawnedSession, type SpawnOrder } from '../../orchestration/session-orchestrator'
import { formatTaskSessions } from '../../orchestration/task-view'
import type { ReachRequest, RemoteHost, RemoteHosts } from '../../orchestration/remote-hosts'
import { agentTargetFromMetadata } from '../agent-targets'
import { hostDisplayName } from '../../../platform/host-display-name'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { MAX_ATTACHMENT_UPLOAD_COUNT } from '@solus/contracts/rpc'
import { checkAttachments } from '../../orchestration/prompt-attachments'
import { findRemoteSession, type OrganizationApi, type RemoteSession } from '../../orchestration/remote-session-read'

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

interface SessionToolArgs {
  after?: unknown
  agent_provider?: unknown
  since?: unknown
  before?: unknown
  cwd?: unknown
  delivery?: unknown
  limit?: unknown
  match?: unknown
  message?: unknown
  model_id?: unknown
  project?: unknown
  prompt?: unknown
  query?: unknown
  reasoning_effort?: unknown
  report?: unknown
  request_id?: unknown
  exchange_id?: unknown
  host?: unknown
  reply_offset?: unknown
  role?: unknown
  session_id?: unknown
  tail?: unknown
  task?: unknown
  task_id?: unknown
  wait_seconds?: unknown
  worktree_base_branch?: unknown
}

// ─── Schema ───

const REPORT_FIELD = z
  .boolean()
  .default(true)
  .describe('Whether its outcome comes back to this conversation: a [session notice] at once when it waits on the user or is rate limited, and a [session report] when its turn ends. Defaults to true.')

const WAIT_FIELD = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_MS / 1000)
  .default(0)
  .describe(`Seconds to wait for the outcome inside this call, up to ${MAX_WAIT_MS / 1000}. 0 (default) returns at once. If the turn ends in time its report is this call's result; if it waits on the user or is rate limited, that notice is the result at once; otherwise the call returns and the outcome comes back later. The session is never stopped by the wait ending.`)

const REQUEST_ID_FIELD = z.string().trim().min(1).max(200).optional()
  .describe('Stable ID for this request, scoped to the calling session. Reuse it when retrying the same work; use a new ID for a new request or review round. A retry returns the original exchange and never starts duplicate work. Closed receipts are kept for 30 days.')

const HOST_FIELD = z.string().trim().min(1).optional()

const ATTACHMENTS_FIELD = z
  .array(z.string().min(1))
  .max(MAX_ATTACHMENT_UPLOAD_COUNT)
  .optional()
  .describe(`Files on this host to send with the message, as absolute paths or paths relative to your working directory; up to ${MAX_ATTACHMENT_UPLOAD_COUNT}, 10 MB each. The session receives a copy taken now, also on another host. PNG, JPEG, GIF and WebP images arrive as images it can see; any other file arrives as a path it can read.`)

const startSessionFields = {
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
    .describe("Required. Use 'none' outside task mode. In task mode, 'attempt' joins the existing task in task_id, or your current task when task_id is omitted. 'attempt' means task membership, not retrying a launch. Native and wrapper subagents do not use this field."),
  task_id: z.string().trim().min(1).optional().describe("The existing task for task='attempt'. Defaults to your current task. Omit with task='none'."),
  agent_provider: z
    .string()
    .optional()
    .describe("Which configured agent runs the session. Defaults to the calling session's provider; call list_agent_targets for current provider and model ids."),
  model_id: z
    .string()
    .min(1)
    .describe("Required model id to run with (e.g. 'claude-opus-5', 'gpt-5.5'). Must be valid for the chosen provider."),
  reasoning_effort: z
    .enum(REASONING_VALUES)
    .optional()
    .describe("Reasoning effort for the session. Defaults to the model's default level."),
  cwd: z
    .string()
    .optional()
    .describe('Working directory the session runs in. Defaults to the calling session\'s directory.'),
  worktree_base_branch: z
    .string()
    .optional()
    .describe('Optional base branch to create an isolated worktree for the new session.'),
  report: REPORT_FIELD,
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

const readTaskSessionsFields = {
  task_id: z.string().optional().describe('The task to show. Defaults to the task this session works on.'),
}

const readSessionFields = {
  session_id: z.string().describe('The session id to inspect.'),
  tail: z.number().int().min(1).max(50).optional().describe('Number of tail messages to return. Defaults to 10.'),
  match: z
    .string()
    .optional()
    .describe('Optional text to locate inside the session (e.g. the query you searched for). Returns the matching messages with surrounding context instead of the latest tail — use it to jump straight to the relevant passage of a long session.'),
  since: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('A cursor from an earlier read_session of this session. Returns only the messages after it, oldest first (up to `tail`), and a new cursor — read what is new without reading the transcript again.'),
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
  limit: z.number().int().min(1).max(50).optional().describe('Maximum results to return. Defaults to 10.'),
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

const START_SESSION_DESC = [
  "Start a separate durable Solus session for work that needs its own conversation, worktree, another host, or independent continuation. Use task='none' outside task mode; task leads follow their Working On Task packet. Native and wrapper subagents need no task fields. With wait_seconds=0, return an accepted exchange before provider startup finishes. The session ID names the card from the start; use read_session_exchange to read startup state. Startup failures return through the same report path.",
  "How orchestration works: with `report` on, the session's outcome comes back to this conversation on its own — a [session notice] as soon as it waits on the user or is rate limited, and a [session report] when its turn ends, with its last message and references to what it produced. Do not poll for it; end your turn and you are woken. Use `wait_seconds` only when you cannot continue without the answer.",
  "Only the user answers a session's questions, plans and permissions, from the cards in this conversation or in that session's tab. When a notice says a session waits on the user, tell the user what it asks. A rate-limited session resumes on its own at the reset; you can wait, stop it, or start the work on another provider.",
  "A report names what the session produced by id, not by content: read a plan with read_plan, a work with read_work, the transcript with read_session; link any of them to a task with link; show one to the user by putting its link in your reply. read_task_sessions shows every session in your task and what each produced.",
  "Give each session everything it needs in `prompt`: it does not see this conversation.",
  "Prefer async work: keep wait_seconds=0 and report=true, end your turn, and let the report wake you. A request stays open while its nested reported work or completion follow-up is pending. read_session_exchange reads the stored state and result by exchange id when needed mid-turn; do not poll in a loop.",
  "Use the built-in subagent tool for supported work on the current provider, including a different model when its schema permits it. Use an available provider wrapper subagent for temporary work on the other provider. A different model or provider alone does not require a separate session. Use send_session to continue an existing Solus session; each new request and review round has its own exchange. Include the full brief, prior findings, responses, and unresolved issues for each review round.",
  "Choose the workspace before starting: worktree_base_branch creates an isolated worktree, otherwise cwd selects the checkout. A shell command in the prompt does not change the session's workspace binding. Use request_id for safe retries. Start an unrelated conversation only when the user asks for it.",
  "Use `host` only when the user asks for the work to run on another of their machines; list_agent_targets names them, and with `host` it names that host's projects to pass as cwd. A session on another host reports back here like any other, and stop_session stops it.",
].join(' ')
const LIST_AGENT_TARGETS_DESC =
  'List the agent providers and models currently configured on this Solus host for Solus sessions and wrapper subagents, including runtime availability and supported reasoning levels, and the other hosts you can start sessions on. This catalog does not establish native subagent model support; consult the built-in tool schema for that. With `host`, list what that host offers instead, and the projects on that host.'
const SEARCH_SESSIONS_DESC =
  "Full-text search over ALL your past Solus conversations (every project and its worktrees). Reach for it WHENEVER the user refers to a prior discussion — 'the X thread', 'when we talked about Y', 'like we decided before' — instead of answering from memory. Put the topic in `query` and leave `project` unset (topic and working directory routinely differ). Every result carries a clickable session link and a `session id`; call `read_session` with that id (pass your query as `match`) to load the conversation before you answer. When you cite one of these sessions, copy its link exactly as returned."
const READ_SESSION_DESC =
  'Load a Solus session by id: its status, bound task context, and message bodies. A session that is not on this host is looked up on your other linked hosts, then on your organizations\' Solus APIs. Two uses — (1) inspect a worker\'s progress or whether it awaits input; (2) after search_sessions surfaces a past conversation, read it in full to ground your answer. By default returns the latest tail; pass `match` (typically the same text you searched for) to jump to the relevant passage of a long session instead. When you cite this session in a reply, copy the returned session link verbatim rather than rebuilding it.'
const SEND_SESSION_DESC =
  "Send a message to another Solus session. `delivery` 'queue' (default) runs it after the session's current turn; 'steer' changes the turn in progress now, and falls back to queue if that turn cannot take it. With `report` on, the outcome comes back like start_session's. Cannot target your own session."
const READ_TASK_SESSIONS_DESC =
  "Show everything that happened in a task: every session working on it, whoever started it — its status, what it waits on the user for, its last message, and references to what it produced (plans, works, sessions it started). Read it to catch up after a restart or before deciding what to do next; read one session in full with read_session."
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

async function taskContextForSession(sessionId: string): Promise<{
  summary: string
  details: string[]
} | null> {
  const boundTask = await Task.forSession(ANY_ORGANIZATION, sessionId)
  if (!boundTask) return null
  const task = boundTask.record()
  const summary = `${task.id} [${task.status}] ${task.title}`
  return { summary, details: [`task: ${summary}`] }
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

function formatTail(messages: SessionLoadMessage[]): string {
  // Reasoning/thinking turns are carried in the transcript for provider handoffs,
  // not for reading back a session — drop them so they don't crowd the tail.
  const visible = messages.filter((m) => m.role !== 'reasoning')
  if (!visible.length) return '(no messages)'
  return visible.map((m) => {
    if (m.toolName) return `[tool: ${m.toolName}]`
    const content = truncate(m.content || m.toolInput || m.toolResultForId || '', 500)
    return `[${m.role || 'message'}] ${content || '(empty)'}`
  }).join('\n')
}

/** What one read_session call reads from. */
interface SessionRead {
  /** The last `limit` messages; without a limit, the whole transcript. */
  load(limit?: number): Promise<SessionLoadMessage[]>
  /** The text messages `match` searches. */
  matchable(): Promise<Array<{ role: string; text: string }>>
  tail: number
}

/** The body of a read_session result, what it is, and the cursor after it. */
interface SessionBody {
  body: string
  bodyNote?: string
  cursor?: number
}

async function readTail(read: SessionRead): Promise<SessionBody> {
  const messages = await read.load(read.tail)
  return { body: formatTail(messages), cursor: cursorAfter(messages) }
}

async function readSince(read: SessionRead, since: number): Promise<SessionBody> {
  const page = messagesSince(await read.load(), since, read.tail)
  if (!page.messages.length) return { body: '(nothing new)', bodyNote: `new since ${since}:`, cursor: since }
  const cursor = cursorAfter(page.messages)
  return {
    body: formatTail(page.messages),
    bodyNote: page.remaining
      ? `${page.messages.length} new messages since ${since}; ${page.remaining} more after these — call again with since=${cursor}:`
      : `new since ${since}:`,
    cursor,
  }
}

/** The indexed messages matching `match`; the latest tail when nothing
 *  matches or the body is not indexed yet. */
async function readMatch(read: SessionRead, match: string): Promise<SessionBody> {
  const indexed = await read.matchable()
  const matched = formatMatchedMessages(indexed, match, read.tail)
  if (matched) {
    return {
      body: matched.text,
      bodyNote: matched.total > matched.shown
        ? `matched ${matched.total} messages for "${match}" — showing first ${matched.shown} (±1 for context):`
        : `matched ${matched.shown} message${matched.shown === 1 ? '' : 's'} for "${match}" (±1 for context):`,
    }
  }
  const tail = await readTail(read)
  return {
    ...tail,
    bodyNote: indexed.length
      ? `no messages matched "${match}" — showing latest ${read.tail}:`
      : `session body not indexed for matching — showing latest ${read.tail}:`,
  }
}

/** The cursor after `messages`: the time of the last one. */
function cursorAfter(messages: readonly SessionLoadMessage[]): number | undefined {
  return messages.reduce<number | undefined>((latest, message) => (latest === undefined || message.timestamp > latest ? message.timestamp : latest), undefined)
}

/** One page of messages after a cursor, and how many more follow it. */
interface MessagePage {
  messages: SessionLoadMessage[]
  remaining: number
}

/**
 * The messages after cursor `since`, oldest first, at most `limit`. A page never
 * ends inside a run of messages with one timestamp: the next cursor would skip
 * the rest of that run.
 */
function messagesSince(messages: readonly SessionLoadMessage[], since: number, limit: number): MessagePage {
  const after = messages.filter((message) => message.timestamp > since && message.role !== 'reasoning')
  let end = Math.min(limit, after.length)
  while (end < after.length && after[end]!.timestamp === after[end - 1]!.timestamp) end++
  return { messages: after.slice(0, end), remaining: after.length - end }
}

/** For `read_session`'s `match` mode: from a session's indexed text messages,
 *  return the ones containing every query token (FTS-style AND) plus one message
 *  of context on each side, with `⋯` marking gaps. Null when nothing matches, so
 *  the caller can fall back to the latest tail. */
function formatMatchedMessages(
  messages: Array<{ role: string; text: string }>,
  match: string,
  maxMatches: number,
): { text: string; total: number; shown: number } | null {
  const tokens = match.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean)
  if (!tokens.length) return null
  const matchIdx: number[] = []
  messages.forEach((m, i) => {
    const hay = m.text.toLowerCase()
    if (tokens.every((t) => hay.includes(t))) matchIdx.push(i)
  })
  if (!matchIdx.length) return null
  const shown = matchIdx.slice(0, maxMatches)
  const hits = new Set(shown)
  const include = new Set<number>()
  for (const i of shown) {
    for (let j = i - 1; j <= i + 1; j += 1) if (j >= 0 && j < messages.length) include.add(j)
  }
  const ordered = [...include].sort((a, b) => a - b)
  const lines: string[] = []
  let prev = -2
  for (const i of ordered) {
    if (lines.length && i !== prev + 1) lines.push('⋯')
    const marker = hits.has(i) ? '» ' : '  '
    lines.push(`${marker}[${messages[i].role || 'message'}] ${truncate(messages[i].text, 500)}`)
    prev = i
  }
  return { text: lines.join('\n'), total: matchIdx.length, shown: shown.length }
}

// ─── Executor (shared by Claude SDK tool + Codex handler) ───

export interface SessionToolResult {
  ok: boolean
  text: string
}

export async function executeSessionTool(
  name: string,
  args: SessionToolArgs,
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

type SessionToolHandler = (args: SessionToolArgs, deps: SessionToolDeps) => Promise<SessionToolResult>

async function listAgentTargetsTool(args: SessionToolArgs, deps: SessionToolDeps): Promise<SessionToolResult> {
  const parsed = z.object(listAgentTargetsFields).safeParse(args)
  if (!parsed.success) return { ok: false, text: 'list_agent_targets received invalid arguments.' }
  if (parsed.data.host) {
    const remote = await connectRemoteHost(parsed.data.host, deps.ctx?.sessionId)
    if ('error' in remote) return { ok: false, text: remote.error }
    const targets = await remoteAgentTargets(remote)
    if ('error' in targets) return { ok: false, text: targets.error }
    const projects = await remoteProjects(remote)
    return { ok: true, text: JSON.stringify({ host: remote.label, targets, ...(projects && { projects }) }, null, 2) }
  }
  const targets = await listAgentTargets()
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

async function readSessionTool(args: SessionToolArgs, deps: SessionToolDeps): Promise<SessionToolResult> {
  if (!sessionController) return { ok: false, text: 'read_session is unavailable — no session controller is wired.' }
  const controller = sessionController
  const parsed = z.object(readSessionFields).safeParse(args)
  if (!parsed.success) return { ok: false, text: 'read_session requires a valid session_id.' }
  const requestedId = parsed.data.session_id.trim()
  const tail = parsed.data.tail ?? 10
  const meta = await findSession(requestedId)
  if (!meta) {
    const remote = await findOffHost(requestedId, deps.ctx?.sessionId)
    if (remote) return readRemoteSession(remote, parsed.data, tail)
    const remoteHost = remoteHostOf(deps, requestedId)
    if (remoteHost) return { ok: false, text: `Session ${requestedId} runs on ${remoteHost}, which did not answer. Its report comes back here, and read_session_exchange reads it.` }
    return { ok: false, text: `Session ${requestedId} not found on this host, your other hosts, or your organizations' Solus APIs.` }
  }
  // The session read may name a thread; everything below names the session.
  const sessionId = meta.sessionId
  const status = controller.liveStatus(sessionId) ?? meta.status ?? 'idle'
  const projectPath = meta.projectPath || deps.ctx?.cwd
  const { body, bodyNote = '', cursor } = await readBody({
    load: (limit) => controller.loadSessionTail(meta.provider, sessionId, projectPath, limit),
    matchable: async () => getSessionMessages(sessionId),
    tail,
  }, parsed.data)
  const pendingInput = formatPendingInputReport(controller.pendingInputEvents(sessionId))
  const taskContext = await taskContextForSession(sessionId)
  return {
    ok: true,
    text: [
      ...sessionHeader(meta, status, taskContext ? taskContext.details : ['task: (unbound)']),
      ...(pendingInput ? [`Pending input:\n${pendingInput}`, ''] : []),
      ...bodyLines(body, bodyNote, cursor),
    ].join('\n'),
  }
}

/** A session on another host or an organization's Solus API. Its task and pending input stay there. */
async function readRemoteSession(remote: RemoteSession, request: { match?: string; since?: number }, tail: number): Promise<SessionToolResult> {
  const { body, bodyNote = '', cursor } = await readBody({
    load: (limit) => remote.load(limit),
    matchable: async () => (await remote.load())
      .filter((message) => message.role !== 'reasoning' && message.content)
      .map((message) => ({ role: message.role, text: message.content })),
    tail,
  }, request)
  return {
    ok: true,
    text: [
      ...sessionHeader(remote.meta, remote.meta.status ?? 'idle', [`found on: ${remote.source}`]),
      ...bodyLines(body, bodyNote, cursor),
    ].join('\n'),
  }
}

/** With `match`, the relevant passage; with `since`, only what came after the cursor; otherwise the latest tail. */
async function readBody(read: SessionRead, request: { match?: string; since?: number }): Promise<SessionBody> {
  const match = request.match?.trim() ?? ''
  if (match) return readMatch(read, match)
  return request.since !== undefined ? readSince(read, request.since) : readTail(read)
}

function bodyLines(body: string, bodyNote: string, cursor: number | undefined): string[] {
  return [
    ...(bodyNote ? [bodyNote] : []),
    body,
    ...(cursor !== undefined ? ['', `cursor: ${cursor} (pass since=${cursor} to read only what comes after)`] : []),
  ]
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

/** The lines that say which session this is, where it stands, and where it belongs. */
function sessionHeader(meta: SessionMeta, status: SessionStatus, context: string[]): string[] {
  const stuck = status === 'awaiting_input' ? ' — awaiting input/permission' : status === 'awaiting_plan' ? ' — awaiting plan approval' : ''
  return [
    `Session ${sessionLink(meta)}`,
    `status: ${status}${stuck}`,
    `provider: ${meta.provider}`,
    ...(meta.model ? [`model: ${meta.model}${meta.reasoningEffort ? ` (reasoning: ${meta.reasoningEffort})` : ''}`] : []),
    `cwd: ${meta.cwd}`,
    `lastTimestamp: ${meta.lastTimestamp}`,
    ...context,
    '',
  ]
}

async function readTaskSessionsTool(args: SessionToolArgs, deps: SessionToolDeps): Promise<SessionToolResult> {
  if (!sessionController) return { ok: false, text: 'read_task_sessions is unavailable — no session controller is wired.' }
  const parsed = z.object(readTaskSessionsFields).safeParse(args)
  if (!parsed.success) return { ok: false, text: 'read_task_sessions received invalid arguments.' }
  const own = deps.ctx?.sessionId ? await Task.forSession(ANY_ORGANIZATION, deps.ctx.sessionId) : null
  const taskId = parsed.data.task_id?.trim() || own?.id
  if (!taskId) return { ok: false, text: 'This session has no task. Pass task_id.' }
  const controller = sessionController
  const view = await formatTaskSessions(taskId, {
    liveStatus: (sessionId) => controller.liveStatus(sessionId),
    pendingInputEvents: (sessionId) => controller.pendingInputEvents(sessionId),
    loadSessionTail: (provider, sessionId, projectPath, limit) => controller.loadSessionTail(provider, sessionId, projectPath, limit),
    link: sessionLink,
  })
  return view ? { ok: true, text: view } : { ok: false, text: `Task ${taskId} not found.` }
}

async function searchSessionsTool(args: SessionToolArgs): Promise<SessionToolResult> {
  const parsed = z.object(searchSessionsFields).safeParse(args)
  if (!parsed.success) return { ok: false, text: 'search_sessions requires a non-empty query.' }
  const query = parsed.data.query.trim()
  if (!query) return { ok: false, text: 'search_sessions requires a non-empty query.' }

  const role = parsed.data.role
  const window = searchWindow(parsed.data.after?.trim() ?? '', parsed.data.before?.trim() ?? '')
  if ('error' in window) return { ok: false, text: window.error }
  const { sinceTs, untilTs, rangeNote } = window
  const limit = parsed.data.limit ?? 10

  // Resolve the optional project scope. No project → search all projects.
  let projectRoot: string | undefined
  let scopeNote = ''
  const projectArg = parsed.data.project?.trim() ?? ''
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

  const { results } = searchSessionIndex(query, {
    projectRoot,
    role: role === 'any' ? undefined : role,
    sinceTs,
    untilTs,
    limit,
  })
  if (!results.length) return { ok: true, text: `${scopeNote}${rangeNote}No matching sessions.` }
  const lines = results.map(({ session, snippet, ts }) => {
    const project = session.projectRoot ? basename(session.projectRoot) : '(unknown)'
    return `${sessionLink(session)}\nproject: ${project} (${session.projectRoot ?? session.cwd})\nprovider: ${session.provider}\nsession id: ${session.sessionId}\ntimestamp: ${new Date(ts).toISOString()}\nsnippet: ${snippet ? truncate(plainSnippet(snippet), 500) : '(matched by its name)'}`
  })
  const nextStep = '→ To read any result in full, call read_session with its session id (add match:"…" to jump to the relevant passage).'
  return { ok: true, text: `${scopeNote}${rangeNote}Search results:\n\n${lines.join('\n\n')}\n\n${nextStep}` }
}

async function sendSessionTool(args: SessionToolArgs, deps: SessionToolDeps): Promise<SessionToolResult> {
  if (!sessionOrchestration) return { ok: false, text: 'send_session is unavailable — no session orchestrator is wired.' }
  const parsed = z.object(sendSessionFields).safeParse(args)
  if (!parsed.success) return { ok: false, text: 'send_session received invalid arguments.' }
  const sessionId = parsed.data.session_id.trim()
  const callerSessionId = deps.ctx?.sessionId
  if (!callerSessionId) return { ok: false, text: 'send_session is unavailable before the calling session is initialized.' }
  if (sessionId === callerSessionId) return { ok: false, text: 'Cannot message your own session.' }
  const message = parsed.data.message
  if (!message.trim()) return { ok: false, text: 'send_session requires a non-empty message.' }
  const report = parsed.data.report
  const waitMs = parsed.data.wait_seconds * 1000
  const order: SendOrder = { prompt: message, delivery: parsed.data.delivery, notify: report, waitMs }
  if (parsed.data.request_id) order.requestId = parsed.data.request_id
  const recipient = await sendRecipient(sessionId, callerSessionId, deps)
  if ('error' in recipient) return { ok: false, text: recipient.error }
  const attachError = await attachTo(order, parsed.data.attachments, deps)
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
  return { host: remote, origin: { hostLabel: hostDisplayName(), sessionId: callerSessionId } }
}

const readExchangeFields = {
  exchange_id: z.string().min(1).describe('The exchange id returned by start_session or send_session.'),
  reply_offset: z.number().int().nonnegative().optional().describe('Read the full saved reply in bounded pages. Start at 0, then use the returned next_reply_offset until it is null. Offsets count UTF-16 code units.'),
}

async function readExchangeTool(args: SessionToolArgs, deps: SessionToolDeps): Promise<SessionToolResult> {
  const parsed = z.object(readExchangeFields).safeParse(args)
  const sender = deps.ctx?.sessionId
  if (!parsed.success || !sender) return { ok: false, text: 'read_session_exchange requires exchange_id and an initialized calling session.' }
  const exchange = sessionOrchestration?.readExchange?.(sender, parsed.data.exchange_id)
  if (!exchange) return { ok: false, text: 'Exchange not found for this calling session.' }
  const lines = [`Exchange ${exchange.exchangeId}: ${exchange.state}. Session ${exchange.targetSessionId}.`]
  if (exchange.deliveryState) lines.push(`Report delivery: ${exchange.deliveryState}.`)
  if (exchange.report) {
    const offset = parsed.data.reply_offset
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

async function stopSessionTool(args: SessionToolArgs, deps: SessionToolDeps): Promise<SessionToolResult> {
  if (!sessionOrchestration) return { ok: false, text: 'stop_session is unavailable — no session orchestrator is wired.' }
  const parsed = z.object(stopSessionFields).safeParse(args)
  if (!parsed.success) return { ok: false, text: 'stop_session requires session_id.' }
  const sessionId = parsed.data.session_id.trim()
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

async function startSessionTool(args: SessionToolArgs, deps: SessionToolDeps): Promise<SessionToolResult> {
  const parsed = startSessionSchema.safeParse(args)
  if (!parsed.success) return { ok: false, text: `Invalid arguments for start_session: ${z.prettifyError(parsed.error).slice(0, 1200)}` }
  const input = parsed.data
  if (!input.prompt.trim()) return { ok: false, text: 'start_session requires a non-empty prompt.' }
  if (!sessionOrchestration) {
    return { ok: false, text: 'start_session is unavailable — it requires the app to be running with an active control plane.' }
  }
  if (input.host) return startRemoteSessionTool(sessionOrchestration, input, input.host, deps)
  const runner = chooseRunner(await listAgentTargets(), input.agent_provider ?? deps.ctx?.agentProvider ?? 'claude-code', input.model_id, input.reasoning_effort)
  if ('error' in runner) return { ok: false, text: runner.error }
  const binding = await resolveStartTask(input.task, input.task_id, deps.ctx?.sessionId)
  if ('error' in binding) return { ok: false, text: binding.error }
  const { taskId } = binding

  const { provider, modelId, reasoningEffort, contextWindow } = runner
  const cwd = resolveHomePath(input.cwd?.trim() || deps.ctx?.cwd || '~')
  const waitMs = input.wait_seconds * 1000
  const order: SpawnOrder = {
    prompt: input.prompt,
    title: input.title,
    provider,
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

function formatStartedSessionReceipt(created: SpawnedSession, runner: Runner, cwd: string, report: boolean, waitMs: number): string {
  const { provider, modelId, reasoningEffort } = runner
  return `Session ${sessionLink({ provider, sessionId: created.sessionId, slug: null, cwd })} on ${provider}/${modelId} (reasoning: ${reasoningEffort}).${created.taskId ? ` Task ${created.taskId}.` : ''}${outcomeNote(report, waitMs, created.waited)}\n${formatExchangeTag({ messageId: created.exchangeId, sessionId: created.sessionId, provider })}${waitedBlock(created.waited)}`
}

/** `start_session` with `host`: the session starts on another of the owner's
 *  hosts, as if the owner started it there (docs/plans/cross-host-sessions.md). */
async function startRemoteSessionTool(
  orchestration: SessionOrchestration,
  input: z.infer<z.ZodObject<typeof startSessionFields>>,
  hostRef: string,
  deps: SessionToolDeps,
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
    title: input.title,
    provider,
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
    || (callerSessionId ? (await Task.forSession(ANY_ORGANIZATION, callerSessionId))?.id : undefined)
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
function chooseRunner(targets: readonly AgentTarget[], requestedProvider: string, requestedModel: string, requestedEffort: ReasoningEffort | undefined): Runner | { error: string } {
  const target = targets.find((candidate) => candidate.provider === requestedProvider)
  if (!target) return { error: `Unknown agent provider "${requestedProvider}". Call list_agent_targets for current choices.` }
  if (!target.available) {
    return { error: `Agent provider "${requestedProvider}" is unavailable${target.unavailableReason ? `: ${target.unavailableReason}` : '.'}` }
  }
  const modelId = requestedModel.trim()
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
  ['list_agent_targets', listAgentTargetsTool],
  ['read_session', readSessionTool],
  ['read_session_exchange', readExchangeTool],
  ['read_task_sessions', readTaskSessionsTool],
  ['search_sessions', searchSessionsTool],
  ['send_session', sendSessionTool],
  ['stop_session', stopSessionTool],
  ['start_session', startSessionTool],
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
export const readTaskSessionsAgentTool = sessionAgentTool('read_task_sessions', READ_TASK_SESSIONS_DESC, readTaskSessionsFields, false)
export const startSessionAgentTool = sessionAgentTool('start_session', START_SESSION_DESC, startSessionFields, false)
startSessionAgentTool.alwaysLoad = true
export const sendSessionAgentTool = sessionAgentTool('send_session', SEND_SESSION_DESC, sendSessionFields, false)
export const stopSessionAgentTool = sessionAgentTool('stop_session', STOP_SESSION_DESC, stopSessionFields, false)

export const sessionAgentTools: AgentTool[] = [
  listAgentTargetsAgentTool,
  searchSessionsAgentTool,
  readSessionAgentTool,
  readSessionExchangeAgentTool,
  readTaskSessionsAgentTool,
  startSessionAgentTool,
  sendSessionAgentTool,
  stopSessionAgentTool,
]
