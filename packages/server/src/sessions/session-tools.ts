import { z } from 'zod'
import { createLogger } from '../logger'
import type { AgentTool } from '../agents/tools/agent-tool'
import { basename } from 'node:path'
import { getSessionMessages, listProjectRoots, searchIndexedSessions } from '../db/session-indexer'
import { formatPendingInputReport } from './pending-input'
import { plainSnippet } from '@solus/contracts/search-snippet'
import { MODEL_PROFILES } from '@solus/contracts/types'
import { formatExchangeTag, formatOrchestrationItem, type OrchestrationItem } from '@solus/contracts/session-exchange'
import type { AgentId, AgentTarget, NormalizedEvent, PlanDescriptor, PromptDelivery, ReasoningEffort, SessionMeta, SessionStatus } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { Task } from '../tasks/task'
import { listTaskChildren } from '../tasks/task-store'
import { LOCAL_ORGANIZATION_ID } from '../server/principal'
import { MAX_WAIT_MS } from '../orchestration/session-orchestrator'
import { formatTaskSessions } from '../orchestration/task-view'

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
    senderAgentSessionId: string | undefined,
    order: {
      prompt: string
      provider: AgentId
      modelId: string
      reasoningEffort: ReasoningEffort
      contextWindow: number | null
      cwd: string
      worktreeBaseBranch?: string | null
      taskId?: string | null
      parentTaskId?: string | null
    },
    report: boolean,
    waitMs?: number,
  ): Promise<{ exchangeId: string; agentSessionId: string; taskId?: string; waited?: OrchestrationItem | null }>
  send(
    senderAgentSessionId: string,
    targetAgentSessionId: string,
    message: { prompt: string; delivery: PromptDelivery; notify: boolean; waitMs?: number },
  ): Promise<{ exchangeId: string; disposition: 'started' | 'steered' | 'queued'; waited?: OrchestrationItem | null }>
  stop(senderAgentSessionId: string | undefined, targetAgentSessionId: string): boolean
}

let sessionOrchestration: SessionOrchestration | null = null
export function setSessionOrchestration(orchestration: SessionOrchestration): void {
  sessionOrchestration = orchestration
}

export interface SessionController {
  listAgentTargets?(): Promise<AgentTarget[]>
  getSessionInfo(sessionId: string): Promise<SessionMeta | null>
  /** The last `limit` messages; without a limit, the whole transcript. */
  loadSessionTail(provider: AgentId, sessionId: string, projectPath: string | undefined, limit?: number): Promise<SessionLoadMessage[]>
  liveStatus(agentSessionId: string): SessionStatus | null
  pendingInputEvents(agentSessionId: string): NormalizedEvent[]
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
  /** Provider thread id — provenance on durable rows. */
  sessionId: string | undefined
  /** Solus session id — keys a dispatched session's shipped task snapshot. */
  solusSessionId?: string
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

const startSessionFields = {
  prompt: z.string().describe('The prompt the new session starts running immediately.'),
  task: z
    .enum(['subtask', 'attempt', 'independent'])
    .describe("Required; no default. 'subtask': a new subtask under your task's root task — use this to break your task into parts. 'attempt': another session on the existing task in task_id. 'independent': a new top-level task."),
  task_id: z.string().optional().describe("The existing task for task='attempt'."),
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
  wait_seconds: WAIT_FIELD,
}

const listAgentTargetsFields = {}

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
  delivery: z
    .enum(['queue', 'steer'])
    .default('queue')
    .describe("How to deliver the prompt when the target is busy. Use 'steer' when this message should interrupt or redirect the target's current line of work—for example to correct its approach, add a missing constraint, or reprioritize what it is doing now. Use 'queue' (default) for additional or sequential work that should wait until the current turn finishes. Steering is consumed at the provider's next decision point and automatically falls back to queueing if the active turn can no longer accept it."),
  report: REPORT_FIELD,
  wait_seconds: WAIT_FIELD,
}

const stopSessionFields = {
  session_id: z.string().describe('The target session id. Cannot be your own session.'),
}

const START_SESSION_DESC = [
  "Start a new Solus session that runs `prompt` right away on its own agent, model and reasoning level, filed under the task you choose with `task`. Returns the new session id and its task id.",
  "How orchestration works: with `report` on, the session's outcome comes back to this conversation on its own — a [session notice] as soon as it waits on the user or is rate limited, and a [session report] when its turn ends, with its last message and references to what it produced. Do not poll for it; end your turn and you are woken. Use `wait_seconds` only when you cannot continue without the answer.",
  "Only the user answers a session's questions, plans and permissions, from the cards in this conversation or in that session's tab. When a notice says a session waits on the user, tell the user what it asks. A rate-limited session resumes on its own at the reset; you can wait, stop it, or start the work on another provider.",
  "A report names what the session produced by id, not by content: read a plan with read_plan, a work with read_work, the transcript with read_session; link any of them to a task with link_task; show one to the user by putting its link in your reply. read_task_sessions shows every session in your task and what each produced.",
  "Give each session everything it needs in `prompt`: it does not see this conversation.",
].join(' ')
const LIST_AGENT_TARGETS_DESC =
  'List the agent providers and models currently configured on this Solus host for start_session, including runtime availability and supported reasoning levels. Use this before choosing a cross-provider target.'
const SEARCH_SESSIONS_DESC =
  "Full-text search over ALL your past Solus conversations (every project and its worktrees). Reach for it WHENEVER the user refers to a prior discussion — 'the X thread', 'when we talked about Y', 'like we decided before' — instead of answering from memory. Put the topic in `query` and leave `project` unset (topic and working directory routinely differ). Every result carries a clickable session link and a `session id`; call `read_session` with that id (pass your query as `match`) to load the conversation before you answer. When you cite one of these sessions, copy its link exactly as returned."
const READ_SESSION_DESC =
  'Load a Solus session by id: its status, bound task/subtask context, and message bodies. Two uses — (1) inspect a worker\'s progress or whether it awaits input; (2) after search_sessions surfaces a past conversation, read it in full to ground your answer. By default returns the latest tail; pass `match` (typically the same text you searched for) to jump to the relevant passage of a long session instead. When you cite this session in a reply, copy the returned session link verbatim rather than rebuilding it.'
const SEND_SESSION_DESC =
  "Send a message to another Solus session. `delivery` 'queue' (default) runs it after the session's current turn; 'steer' changes the turn in progress now, and falls back to queue if that turn cannot take it. With `report` on, the outcome comes back like start_session's. Cannot target your own session."
const READ_TASK_SESSIONS_DESC =
  "Show everything that happened in a task: the root task and its subtasks, and every session working on any of them, whoever started it — its status, what it waits on the user for, its last message, and references to what it produced (plans, works, sessions it started). Read it to catch up after a restart or before deciding what to do next; read one session in full with read_session."
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
  const boundTask = await Task.forSession(LOCAL_ORGANIZATION_ID, sessionId)
  if (!boundTask) return null
  const task = boundTask.record()
  const parent = task.parentId ? (await Task.byId(LOCAL_ORGANIZATION_ID, task.parentId)).record() : null
  const subtasks = await listTaskChildren(LOCAL_ORGANIZATION_ID, parent?.id ?? task.id)
  const siblings = parent ? subtasks.filter((candidate) => candidate.id !== task.id) : []
  const relationship = parent ? `subtask of ${parent.id}` : 'top-level task'
  const details = [`task: ${task.id} [${task.status}] ${task.title} (${relationship})`]
  if (parent) details.push(`parent task: ${parent.id} [${parent.status}] ${parent.title}`)
  const related = parent ? siblings : subtasks
  if (related.length) {
    details.push(parent ? 'sibling subtasks:' : 'subtasks:')
    for (const relatedTask of related) {
      details.push(`- ${relatedTask.id} [${relatedTask.status}] ${relatedTask.title}`)
    }
  }
  return {
    summary: `${task.id} [${task.status}] ${task.title} (${relationship})`,
    details,
  }
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

/** Where a started session's task goes. A subtask hangs under the caller's
 *  root task: tasks have two levels, so a caller on a subtask gets a sibling. */
async function taskPlacement(
  choice: 'subtask' | 'attempt' | 'independent',
  taskId: string | undefined,
  callerSessionId: string | undefined,
): Promise<{ taskId?: string; parentTaskId?: string } | { error: string }> {
  if (choice === 'independent') return {}
  if (choice === 'attempt') {
    const existing = taskId?.trim()
    return existing ? { taskId: existing } : { error: "start_session with task='attempt' requires task_id." }
  }
  const callerTask = callerSessionId ? await Task.forSession(LOCAL_ORGANIZATION_ID, callerSessionId) : null
  if (!callerTask) return { error: "This session has no task to add a subtask to. Use task='independent', or task='attempt' with a task_id." }
  const record = callerTask.record()
  return { parentTaskId: record.parentId ?? record.id }
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
  controller: SessionController
  meta: SessionMeta
  sessionId: string
  projectPath: string | undefined
  tail: number
}

/** The body of a read_session result, what it is, and the cursor after it. */
interface SessionBody {
  body: string
  bodyNote?: string
  cursor?: number
}

async function readTail(read: SessionRead): Promise<SessionBody> {
  const messages = await read.controller.loadSessionTail(read.meta.provider, read.sessionId, read.projectPath, read.tail)
  return { body: formatTail(messages), cursor: cursorAfter(messages) }
}

async function readSince(read: SessionRead, since: number): Promise<SessionBody> {
  const page = messagesSince(await read.controller.loadSessionTail(read.meta.provider, read.sessionId, read.projectPath), since, read.tail)
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
  const indexed = getSessionMessages(read.sessionId)
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

async function listAgentTargetsTool(): Promise<SessionToolResult> {
  const targets = await listAgentTargets()
  return { ok: true, text: JSON.stringify({ targets }, null, 2) }
}

async function readSessionTool(args: SessionToolArgs, deps: SessionToolDeps): Promise<SessionToolResult> {
  if (!sessionController) return { ok: false, text: 'read_session is unavailable — no session controller is wired.' }
  const parsed = z.object(readSessionFields).safeParse(args)
  if (!parsed.success) return { ok: false, text: 'read_session requires a valid session_id.' }
  const sessionId = parsed.data.session_id.trim()
  const tail = parsed.data.tail ?? 10
  const match = parsed.data.match?.trim() ?? ''
  const meta = await findSession(sessionId)
  if (!meta) return { ok: false, text: `Session ${sessionId} not found.` }
  const status = sessionController.liveStatus(sessionId) ?? meta.status ?? 'idle'
  const read = { controller: sessionController, meta, sessionId, projectPath: meta.projectPath || deps.ctx?.cwd, tail }
  const since = parsed.data.since
  // With `match`, jump to the relevant passage; with `since`, only what came
  // after the cursor; otherwise the latest tail.
  const { body, bodyNote = '', cursor } = match
    ? await readMatch(read, match)
    : since !== undefined ? await readSince(read, since) : await readTail(read)
  const pendingInput = formatPendingInputReport(sessionController.pendingInputEvents(sessionId))
  return {
    ok: true,
    text: [
      ...await sessionHeader(meta, sessionId, status),
      ...(pendingInput ? [`Pending input:\n${pendingInput}`, ''] : []),
      ...(bodyNote ? [bodyNote] : []),
      body,
      ...(cursor !== undefined ? ['', `cursor: ${cursor} (pass since=${cursor} to read only what comes after)`] : []),
    ].join('\n'),
  }
}

/** The lines that say which session this is, where it stands and its task. */
async function sessionHeader(meta: SessionMeta, sessionId: string, status: SessionStatus): Promise<string[]> {
  const stuck = status === 'awaiting_input' ? ' — awaiting input/permission' : status === 'awaiting_plan' ? ' — awaiting plan approval' : ''
  const taskContext = await taskContextForSession(sessionId)
  return [
    `Session ${sessionLink(meta)}`,
    `status: ${status}${stuck}`,
    `provider: ${meta.provider}`,
    ...(meta.model ? [`model: ${meta.model}${meta.reasoningEffort ? ` (reasoning: ${meta.reasoningEffort})` : ''}`] : []),
    `cwd: ${meta.cwd}`,
    `lastTimestamp: ${meta.lastTimestamp}`,
    ...(taskContext ? taskContext.details : ['task: (unbound)']),
    '',
  ]
}

async function readTaskSessionsTool(args: SessionToolArgs, deps: SessionToolDeps): Promise<SessionToolResult> {
  if (!sessionController) return { ok: false, text: 'read_task_sessions is unavailable — no session controller is wired.' }
  const parsed = z.object(readTaskSessionsFields).safeParse(args)
  if (!parsed.success) return { ok: false, text: 'read_task_sessions received invalid arguments.' }
  const own = deps.ctx?.sessionId ? await Task.forSession(LOCAL_ORGANIZATION_ID, deps.ctx.sessionId) : null
  const taskId = parsed.data.task_id?.trim() || own?.id
  if (!taskId) return { ok: false, text: 'This session has no task. Pass task_id.' }
  const controller = sessionController
  const view = await formatTaskSessions(taskId, {
    liveStatus: (agentSessionId) => controller.liveStatus(agentSessionId),
    pendingInputEvents: (agentSessionId) => controller.pendingInputEvents(agentSessionId),
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

  const results = searchIndexedSessions(query, {
    projectRoot,
    role: role === 'any' ? undefined : role,
    sinceTs,
    untilTs,
  }, limit)
  if (!results.length) return { ok: true, text: `${scopeNote}${rangeNote}No matching sessions.` }
  const lines = results.map(({ session, snippet, ts }) => {
    const project = session.projectRoot ? basename(session.projectRoot) : '(unknown)'
    return `${sessionLink(session)}\nproject: ${project} (${session.projectRoot ?? session.cwd})\nprovider: ${session.provider}\nsession id: ${session.sessionId}\ntimestamp: ${new Date(ts).toISOString()}\nsnippet: ${truncate(plainSnippet(snippet), 500)}`
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
  const meta = await findSession(sessionId)
  if (!meta) return { ok: false, text: `Session ${sessionId} not found.` }
  const report = parsed.data.report
  const waitMs = parsed.data.wait_seconds * 1000
  const sent = await sessionOrchestration.send(callerSessionId, sessionId, { prompt: message, delivery: parsed.data.delivery, notify: report, waitMs })
  const dispatch = sent.disposition === 'queued'
    ? 'Queued for'
    : sent.disposition === 'steered'
      ? 'Steered the turn in progress in'
      : 'Sent to'
  return {
    ok: true,
    text: `${dispatch} ${sessionLink(meta)}.${outcomeNote(report, waitMs, sent.waited)}\n${formatExchangeTag({ messageId: sent.exchangeId, agentSessionId: sessionId, provider: meta.provider })}${waitedBlock(sent.waited)}`,
  }
}

async function stopSessionTool(args: SessionToolArgs, deps: SessionToolDeps): Promise<SessionToolResult> {
  if (!sessionOrchestration) return { ok: false, text: 'stop_session is unavailable — no session orchestrator is wired.' }
  const parsed = z.object(stopSessionFields).safeParse(args)
  if (!parsed.success) return { ok: false, text: 'stop_session requires session_id.' }
  const sessionId = parsed.data.session_id.trim()
  if (sessionId === deps.ctx?.sessionId) return { ok: false, text: 'Cannot stop your own session.' }
  const meta = await findSession(sessionId)
  if (!meta) return { ok: false, text: `Session ${sessionId} not found.` }
  return sessionOrchestration.stop(deps.ctx?.sessionId, sessionId)
    ? { ok: true, text: `Stopped session ${sessionId}.` }
    : { ok: true, text: `Session ${sessionId} is not currently running.` }
}

async function startSessionTool(args: SessionToolArgs, deps: SessionToolDeps): Promise<SessionToolResult> {
  const parsed = z.object(startSessionFields).safeParse(args)
  if (!parsed.success) return { ok: false, text: 'start_session received invalid arguments.' }
  const input = parsed.data
  if (!input.prompt.trim()) return { ok: false, text: 'start_session requires a non-empty prompt.' }
  if (!sessionOrchestration) {
    return { ok: false, text: 'start_session is unavailable — it requires the app to be running with an active control plane.' }
  }
  const runner = await chooseRunner(input.agent_provider ?? deps.ctx?.agentProvider ?? 'claude-code', input.model_id, input.reasoning_effort)
  if ('error' in runner) return { ok: false, text: runner.error }
  const placement = await taskPlacement(input.task, input.task_id, deps.ctx?.sessionId)
  if ('error' in placement) return { ok: false, text: placement.error }

  const { provider, modelId, reasoningEffort, contextWindow } = runner
  const cwd = input.cwd?.trim() || deps.ctx?.cwd || '~'
  const waitMs = input.wait_seconds * 1000
  // The orchestrator puts the card in this conversation before the session
  // starts — startup can take a while — and binds it to the session once it does.
  const created = await sessionOrchestration.spawn(deps.ctx?.sessionId, {
    prompt: input.prompt,
    provider,
    modelId,
    reasoningEffort,
    contextWindow,
    cwd,
    worktreeBaseBranch: input.worktree_base_branch?.trim() || null,
    taskId: placement.taskId ?? null,
    parentTaskId: placement.parentTaskId ?? null,
  }, input.report, waitMs)

  return {
    ok: true,
    text: `Started ${sessionLink({ provider, sessionId: created.agentSessionId, slug: null, cwd })} on ${provider}/${modelId} (reasoning: ${reasoningEffort}).${taskNote(created.taskId, placement.parentTaskId)}${outcomeNote(input.report, waitMs, created.waited)}\n${formatExchangeTag({ messageId: created.exchangeId, agentSessionId: created.agentSessionId, provider })}${waitedBlock(created.waited)}`,
  }
}

/** Which task a started session was filed under. */
function taskNote(taskId: string | undefined, parentTaskId: string | undefined): string {
  if (!taskId) return ''
  return ` Task ${taskId}${parentTaskId ? `, a subtask of ${parentTaskId}` : ''}.`
}

/** The provider, model and reasoning level a started session runs on. */
interface Runner {
  provider: AgentId
  modelId: string
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
}

/** Checks the requested provider, model and reasoning level against what this host offers. */
async function chooseRunner(requestedProvider: string, requestedModel: string, requestedEffort: ReasoningEffort | undefined): Promise<Runner | { error: string }> {
  const target = (await listAgentTargets()).find((candidate) => candidate.provider === requestedProvider)
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
        cwd: context.cwd,
        sessionId: context.sessionId(),
      },
    }),
  }
}

export const searchSessionsAgentTool = sessionAgentTool('search_sessions', SEARCH_SESSIONS_DESC, searchSessionsFields, false)
export const listAgentTargetsAgentTool = sessionAgentTool('list_agent_targets', LIST_AGENT_TARGETS_DESC, listAgentTargetsFields, false)
export const readSessionAgentTool = sessionAgentTool('read_session', READ_SESSION_DESC, readSessionFields, false)
export const readTaskSessionsAgentTool = sessionAgentTool('read_task_sessions', READ_TASK_SESSIONS_DESC, readTaskSessionsFields, false)
export const startSessionAgentTool = sessionAgentTool('start_session', START_SESSION_DESC, startSessionFields, false)
export const sendSessionAgentTool = sessionAgentTool('send_session', SEND_SESSION_DESC, sendSessionFields, false)
export const stopSessionAgentTool = sessionAgentTool('stop_session', STOP_SESSION_DESC, stopSessionFields, false)

export const sessionAgentTools: AgentTool[] = [
  listAgentTargetsAgentTool,
  searchSessionsAgentTool,
  readSessionAgentTool,
  readTaskSessionsAgentTool,
  startSessionAgentTool,
  sendSessionAgentTool,
  stopSessionAgentTool,
]
