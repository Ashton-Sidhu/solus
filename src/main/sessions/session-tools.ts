import { z } from 'zod'
import { createLogger } from '../logger'
import type { AgentTool } from '../agents/tools/agent-tool'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getSessionMessages, listProjectRoots, searchIndexedSessions } from '../db/session-indexer'
import { formatPendingInputReport } from './session-report'
import { MODEL_PROFILES } from '../../shared/types'
import type { AgentConversationUpdate, AgentId, AgentTarget, NormalizedEvent, PlanDescriptor, PromptDelivery, ReasoningEffort, SessionMeta, SessionStatus } from '../../shared/types'
import type { SessionLoadMessage } from '../../shared/session-history'

const log = createLogger('sessions', 'session-tools.ts')

/**
 * Single source of truth for the agent-facing `create_session` tool, which spawns
 * a brand-new Solus chat session running a given prompt. Tools return error
 * text rather than throwing so a bad call remains recoverable.
 *
 * The session is created via an injected `SessionCreator` (wired to the
 * ControlPlane in the server layer) so this module stays decoupled from the
 * control plane — mirroring `setAutomationSessionDispatcher`.
 */

const REASONING_VALUES = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'] as const
// Providers that can start a session. 'opencode' is excluded — same constraint
// the automation runner applies (no headless runner yet).
const AGENT_PROVIDER_VALUES = ['claude-code', 'codex'] as const

// ─── Injected session creator (wired to the ControlPlane in server/index.ts) ───

export interface SessionCreateRequest {
  prompt: string
  provider: AgentId
  modelId: string
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
  cwd: string
  worktreeBaseBranch?: string | null
}

export type SessionCreator = (req: SessionCreateRequest) => Promise<{ agentSessionId: string }>

let sessionCreator: SessionCreator | null = null
export function setSessionCreator(creator: SessionCreator): void {
  sessionCreator = creator
}

/** An armed agent exchange: settle/awaiting reports for `targetSessionId`
 *  will be correlated back to this exchange in the caller's thread. */
export interface AgentConversationWatchRequest {
  exchangeId: string
  dispatchedAt: number
  /** When false the renderer still receives agent-conversation updates, but no [session
   *  report] prose is injected into the caller's turn input. */
  notifyModel: boolean
  /** Which run settles this exchange: 'active' = the run in flight when the
   *  exchange was armed (started/steered dispatches, watches, created
   *  sessions); otherwise the queueId whose future run it awaits. */
  runKey: 'active' | (string & {})
}

export interface SessionController {
  listAgentTargets?(): Promise<AgentTarget[]>
  listSessions(providers: AgentId[], projectPath: string): Promise<SessionMeta[]>
  getSessionInfo(sessionId: string): Promise<SessionMeta | null>
  loadSessionTail(provider: AgentId, sessionId: string, projectPath: string | undefined, limit: number): Promise<SessionLoadMessage[]>
  liveStatus(agentSessionId: string): SessionStatus | null
  pendingInputEvents(agentSessionId: string): NormalizedEvent[]
  promptSession(
    agentSessionId: string,
    prompt: string,
    delivery?: PromptDelivery,
    options?: { permissionMode?: 'ask' | 'auto' | 'plan' },
  ): Promise<{ disposition: 'started' | 'steered' | 'queued'; queueId?: string }>
  watchSessionSettled(targetSessionId: string, callerSessionId: string, watch: AgentConversationWatchRequest): void
  stopSession(agentSessionId: string): boolean
  /** Resolve a peer's pending question / plan permission. Both key on the
   *  questionId carried by the pending input event, so no tab is involved. */
  answerQuestion(questionId: string, answers: Record<string, string>): boolean
  respondPermission(questionId: string, optionId: string, revisedPlan?: string): boolean
  loadPlanContent(provider: AgentId, sessionId: string, projectPath: string, planToolUseId: string): Promise<string | null>
  listPlans(provider: AgentId, projectPath: string | undefined, allProjects: boolean): Promise<PlanDescriptor[]>
  invalidatePlanCaches(sessionId: string): void
  recordSessionDelegation?(input: {
    childSessionId: string
    parentSessionId: string
    exchangeId: string
    intent: 'delegate' | 'fire_and_forget'
    createdAt: number
  }): boolean | Promise<boolean>
}

let sessionController: SessionController | null = null
export function setSessionController(controller: SessionController): void {
  sessionController = controller
}

/** The same controller `session-review-tools` acts through — one wiring point
 *  in `server/index.ts` serves both modules. */
export function getSessionController(): SessionController | null {
  return sessionController
}

// ─── Side-effect callback + per-call context ───

export interface SessionToolCtx {
  agentProvider: AgentId
  cwd: string
  sessionId: string | undefined
}

export interface SessionToolDeps {
  ctx?: SessionToolCtx
  /** Fired for each lifecycle step so the calling thread updates its
   *  agent-conversation card. */
  onAgentConversationUpdate?: (update: AgentConversationUpdate) => void
}

// ─── Schema ───

const createSessionShape = {
  prompt: z.string().describe('The prompt the new session starts running immediately.'),
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
  mode: z
    .enum(['delegate', 'fire_and_forget'])
    .describe("Required intent — there is no default; choose deliberately. 'delegate': you need the new session's reply to continue your own work — finish your turn and its first reply arrives here later as a [session report]. 'fire_and_forget': the user just wants the task started ('kick off', 'launch', 'in the background', 'don't wait') — no report will arrive and you must not wait or poll for one; if you genuinely need to catch up later, use read_session."),
}

const listAgentTargetsShape = {}

const listSessionsShape = {
  project_path: z.string().optional().describe('Project path to list sessions for. Defaults to the calling session cwd.'),
  status: z.enum(['active', 'all']).optional().describe("Default 'active' lists only busy/rate-limited sessions; 'all' includes historical sessions."),
  limit: z.number().int().min(1).max(50).optional().describe('Maximum sessions to return. Defaults to 15.'),
}

const readSessionShape = {
  session_id: z.string().describe('The session id to inspect.'),
  tail: z.number().int().min(1).max(50).optional().describe('Number of tail messages to return. Defaults to 10.'),
  match: z
    .string()
    .optional()
    .describe('Optional text to locate inside the session (e.g. the query you searched for). Returns the matching messages with surrounding context instead of the latest tail — use it to jump straight to the relevant passage of a long session.'),
}

const searchSessionsShape = {
  query: z.string().describe('Full-text query to search for in session messages.'),
  project: z.string().optional().describe("Optional project to scope to (a project name like 't3code' or a path). Scopes to sessions that RAN IN that repo (its git root + worktrees) — NOT sessions that merely mention it; a discussion about repo X held from inside repo Y is filed under Y. Omit it (the default) to search everything by content — that's the reliable way to find a past discussion. A partial name is fine; if nothing matches, the search falls back to all projects."),
  role: z.enum(['user', 'assistant', 'any']).default('any').describe("Message role to search. Defaults to 'any'."),
  after: z
    .string()
    .optional()
    .describe("Only include messages at or after this instant. ISO 8601 — a date like '2026-06-01' (midnight UTC) or a full timestamp '2026-06-01T09:00:00Z'. Omit to leave the lower bound open. Note the default below: to search further back than 2 weeks you MUST pass this."),
  before: z
    .string()
    .optional()
    .describe("Only include messages at or before this instant. ISO 8601; a date like '2026-06-30' covers through the end of that day. Omit to leave the upper bound open. DEFAULT: with BOTH after and before omitted, the search covers only the last 2 weeks (after = now − 14d, before = now)."),
  limit: z.number().int().min(1).max(20).default(10).describe('Maximum results to return. Defaults to 10.'),
}

const promptSessionShape = {
  session_id: z.string().describe('The target session id. Cannot be your own session.'),
  prompt: z.string().describe('Prompt to send into the target session.'),
  delivery: z
    .enum(['queue', 'steer'])
    .default('queue')
    .describe("How to deliver the prompt when the target is busy. Use 'steer' when this message should interrupt or redirect the target's current line of work—for example to correct its approach, add a missing constraint, or reprioritize what it is doing now. Use 'queue' (default) for additional or sequential work that should wait until the current turn finishes. Steering is consumed at the provider's next decision point and automatically falls back to queueing if the active turn can no longer accept it."),
  notify_on_completion: z.boolean().default(true).describe("When true, this conversation receives the target session's reply later as a [session report]. Defaults to true."),
}

const waitForSessionShape = {
  session_id: z.string().describe('The running target session id to watch. Cannot be your own session.'),
}

const stopSessionShape = {
  session_id: z.string().describe('The target session id. Cannot be your own session.'),
}

export const CREATE_SESSION_DESC =
  "Create a NEW Solus chat session that starts running the given prompt right away on its own agent, model, and reasoning level. The required `mode` declares your intent: 'delegate' when you need the new session's answer to continue your own work — finish your turn and its first reply arrives here later as a [session report]; 'fire_and_forget' when the user asked to kick off / launch / run something in the background and does not need you to see the result — tell the user the session was started and move on; no report will come, and you must NOT poll read_session or wait for it; the user follows the session through its card. model_id is required and must be valid for the chosen configured provider; call list_agent_targets for current choices. A live agent-conversation card tracks the session's progress in this conversation in both modes. Call it once per session you want to start. Returns the new session id."
const LIST_AGENT_TARGETS_DESC =
  'List the agent providers and models currently configured on this Solus host for create_session, including runtime availability and supported reasoning levels. Use this before choosing a cross-provider target.'
const LIST_SESSIONS_DESC =
  'List Solus sessions for this project so an orchestrator can observe worker status. By default excludes the calling session and returns only active/busy sessions.'
const SEARCH_SESSIONS_DESC =
  "Full-text search over ALL your past Solus conversations (every project and its worktrees). Reach for this WHENEVER the user refers to a prior discussion — 'the X thread', 'when we talked about Y', 'like we decided before', 'that thing we found' — instead of answering from memory. Put the topic in `query`; leave `project` unset (topic and working directory routinely differ — see that param). Each result carries a clickable session link and a `session id`; take that id and call `read_session` (pass your query as `match`) to load the full conversation before you answer."
const READ_SESSION_DESC =
  'Load a Solus session by id: its status plus message bodies. Two uses — (1) inspect a worker\'s progress or whether it awaits input; (2) after search_sessions surfaces a past conversation, read it in full to ground your answer. By default returns the latest tail; pass `match` (typically the same text you searched for) to jump to the relevant passage of a long session instead.'
const PROMPT_SESSION_DESC =
  "Send a prompt into another Solus session by session id. Choose delivery: 'steer' only when the target's work in progress should change now—for example to correct, interrupt, redirect, constrain, or reprioritize its current approach. Choose 'queue' for independent or sequential follow-up that should begin after the current turn; queue is the default. Steering is consumed at the provider's next decision point rather than cancelling the session, and automatically falls back to queueing if the turn is ending or cannot be steered. By default, the target's reply arrives later in this conversation as a [session report]; set notify_on_completion to false for fire-and-forget. Completion watchers do not survive app restart, so use read_session to catch up. Cannot target your own session."
const WAIT_FOR_SESSION_DESC =
  "Watch an already-running Solus session for its next completion or request for human input. Returns immediately with the current status; the reply arrives later in this conversation as a [session report]. Watchers do not survive app restart, so fall back to read_session. Does not register if the target is not currently running/busy. Cannot target your own session."
const STOP_SESSION_DESC =
  "Stop another running Solus session and clear its queued prompts. Cannot target your own session."

// ─── Helpers ───

function reasoning(value: unknown, fallback: ReasoningEffort): ReasoningEffort {
  return (REASONING_VALUES as readonly string[]).includes(String(value)) ? (value as ReasoningEffort) : fallback
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

export function sessionLink(meta: Pick<SessionMeta, 'provider' | 'sessionId' | 'slug' | 'cwd'>): string {
  const label = meta.slug || meta.sessionId.slice(0, 8)
  const cwd = meta.cwd ? `&cwd=${encodeURIComponent(meta.cwd)}` : ''
  return `[${label}](session://open?provider=${meta.provider}&sessionId=${meta.sessionId}${cwd})`
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

function isBusy(status: SessionStatus | undefined): boolean {
  return status === 'connecting' || status === 'running' || status === 'awaiting_input' || status === 'awaiting_plan' || status === 'rate_limited'
}

export async function findSession(sessionId: string): Promise<SessionMeta | null> {
  if (!sessionController) return null
  return sessionController.getSessionInfo(sessionId)
}

/** Display title for the other agent: CLI slug once it exists, else the first
 *  message, else the short id. */
export function peerTitle(meta: SessionMeta): string {
  return meta.slug || truncate(meta.firstMessage ?? '', 80) || meta.sessionId.slice(0, 8)
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
  args: Record<string, unknown>,
  deps: SessionToolDeps = {},
): Promise<SessionToolResult> {
  try {
    if (name === 'list_agent_targets') {
      const targets = await listAgentTargets()
      return { ok: true, text: JSON.stringify({ targets }, null, 2) }
    }

    if (name === 'list_sessions') {
      if (!sessionController) return { ok: false, text: 'list_sessions is unavailable — no session controller is wired.' }
      const projectPath = typeof args.project_path === 'string' && args.project_path.trim()
        ? args.project_path.trim()
        : (deps.ctx?.cwd ?? '~')
      const status = String(args.status ?? 'active')
      if (status !== 'active' && status !== 'all') return { ok: false, text: "list_sessions status must be 'active' or 'all'." }
      const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, Math.floor(args.limit))) : 15
      const sessions = await sessionController.listSessions([...AGENT_PROVIDER_VALUES], projectPath)
      const calling = deps.ctx?.sessionId
      const filtered = sessions
        .map((meta) => ({ ...meta, status: sessionController!.liveStatus(meta.sessionId) ?? meta.status ?? 'idle' as SessionStatus }))
        .filter((meta) => status === 'all' || (meta.sessionId !== calling && isBusy(meta.status)))
        .slice(0, limit)
      if (!filtered.length) return { ok: true, text: 'No matching sessions.' }
      const lines = filtered.map((meta) => {
        const self = meta.sessionId === calling ? ' (this session)' : ''
        return `${sessionLink(meta)}${self}  [${meta.status ?? 'idle'}]  ${meta.provider}  ${meta.cwd}  "${truncate(meta.firstMessage ?? '', 80)}"  (${meta.lastTimestamp})`
      })
      return { ok: true, text: `Sessions:\n${lines.join('\n')}` }
    }

    if (name === 'read_session') {
      if (!sessionController) return { ok: false, text: 'read_session is unavailable — no session controller is wired.' }
      const sessionId = String(args.session_id ?? '').trim()
      if (!sessionId) return { ok: false, text: 'read_session requires session_id.' }
      const tail = typeof args.tail === 'number' ? Math.min(50, Math.max(1, Math.floor(args.tail))) : 10
      const match = typeof args.match === 'string' ? args.match.trim() : ''
      const meta = await findSession(sessionId)
      if (!meta) return { ok: false, text: `Session ${sessionId} not found.` }
      const status = sessionController.liveStatus(sessionId) ?? meta.status ?? 'idle'
      const loadTail = async () =>
        formatTail(await sessionController!.loadSessionTail(meta.provider, sessionId, meta.projectPath || deps.ctx?.cwd, tail))

      // With `match`, jump to the relevant passage from the indexed message
      // bodies; fall back to the latest tail when nothing matches or the body
      // isn't indexed yet.
      let bodyNote = ''
      let body: string
      if (match) {
        const indexed = getSessionMessages(sessionId)
        const matched = formatMatchedMessages(indexed, match, tail)
        if (matched) {
          body = matched.text
          bodyNote = matched.total > matched.shown
            ? `matched ${matched.total} messages for "${match}" — showing first ${matched.shown} (±1 for context):`
            : `matched ${matched.shown} message${matched.shown === 1 ? '' : 's'} for "${match}" (±1 for context):`
        } else {
          body = await loadTail()
          bodyNote = indexed.length
            ? `no messages matched "${match}" — showing latest ${tail}:`
            : `session body not indexed for matching — showing latest ${tail}:`
        }
      } else {
        body = await loadTail()
      }
      const stuck = status === 'awaiting_input' ? ' — awaiting input/permission' : status === 'awaiting_plan' ? ' — awaiting plan approval' : ''
      const pendingInput = formatPendingInputReport(sessionController.pendingInputEvents(sessionId))
      return {
        ok: true,
        text: [
          `Session ${sessionLink(meta)}`,
          `status: ${status}${stuck}`,
          `provider: ${meta.provider}`,
          ...(meta.model ? [`model: ${meta.model}${meta.reasoningEffort ? ` (reasoning: ${meta.reasoningEffort})` : ''}`] : []),
          `cwd: ${meta.cwd}`,
          `lastTimestamp: ${meta.lastTimestamp}`,
          '',
          ...(pendingInput ? [`Pending input:\n${pendingInput}`, ''] : []),
          ...(bodyNote ? [bodyNote] : []),
          body,
        ].join('\n'),
      }
    }

    if (name === 'search_sessions') {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) return { ok: false, text: 'search_sessions requires a non-empty query.' }
      const role = String(args.role ?? 'any')
      if (role !== 'user' && role !== 'assistant' && role !== 'any') {
        return { ok: false, text: "search_sessions role must be 'user', 'assistant', or 'any'." }
      }
      // Absolute time bounds. A date-only `before` covers through the end of
      // that day; both omitted → search all of time.
      const parseBound = (value: string, endOfDay: boolean): number | null => {
        const base = new Date(value).getTime()
        if (!Number.isFinite(base)) return null
        return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? base + 86_399_999 : base
      }
      const afterArg = typeof args.after === 'string' ? args.after.trim() : ''
      const beforeArg = typeof args.before === 'string' ? args.before.trim() : ''
      let sinceTs: number | undefined
      let untilTs: number | undefined
      if (afterArg) {
        const t = parseBound(afterArg, false)
        if (t === null) return { ok: false, text: `search_sessions: could not parse after="${afterArg}". Use an ISO date like 2026-06-01 or 2026-06-01T09:00:00Z.` }
        sinceTs = t
      }
      if (beforeArg) {
        const t = parseBound(beforeArg, true)
        if (t === null) return { ok: false, text: `search_sessions: could not parse before="${beforeArg}". Use an ISO date like 2026-06-30 or 2026-06-30T23:59:59Z.` }
        untilTs = t
      }
      if (sinceTs !== undefined && untilTs !== undefined && sinceTs > untilTs) {
        return { ok: false, text: `search_sessions: after (${afterArg}) is later than before (${beforeArg}) — no messages can match.` }
      }
      // No bounds at all → default to the last 2 weeks (before = now, after =
      // now − 14d). Giving either bound leaves the other side open.
      let defaultedRange = false
      if (sinceTs === undefined && untilTs === undefined) {
        const now = Date.now()
        untilTs = now
        sinceTs = now - 14 * 24 * 60 * 60 * 1_000
        defaultedRange = true
      }
      const rangeNote = defaultedRange
        ? 'No time range given — searched the last 2 weeks. Pass after="YYYY-MM-DD" (optionally with before) to search a different window.\n\n'
        : ''
      const limit = typeof args.limit === 'number' ? Math.min(20, Math.max(1, Math.floor(args.limit))) : 10

      // Resolve the optional project scope. No project → search all projects.
      let projectRoot: string | undefined
      let scopeNote = ''
      const projectArg = typeof args.project === 'string' ? args.project.trim() : ''
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
        return `${sessionLink(session)}\nproject: ${project} (${session.projectRoot ?? session.cwd})\nprovider: ${session.provider}\nsession id: ${session.sessionId}\ntimestamp: ${new Date(ts).toISOString()}\nsnippet: ${truncate(snippet, 500)}`
      })
      const nextStep = '→ To read any result in full, call read_session with its session id (add match:"…" to jump to the relevant passage).'
      return { ok: true, text: `${scopeNote}${rangeNote}Search results:\n\n${lines.join('\n\n')}\n\n${nextStep}` }
    }

    if (name === 'prompt_session') {
      if (!sessionController) return { ok: false, text: 'prompt_session is unavailable — no session controller is wired.' }
      const sessionId = String(args.session_id ?? '').trim()
      if (!sessionId) return { ok: false, text: 'prompt_session requires session_id.' }
      if (sessionId === deps.ctx?.sessionId) return { ok: false, text: 'Cannot prompt your own session.' }
      const notifyOnCompletion = args.notify_on_completion !== false
      const callerSessionId = deps.ctx?.sessionId
      if (notifyOnCompletion && !callerSessionId) {
        return { ok: false, text: 'prompt_session cannot notify on completion before the calling session is initialized.' }
      }
      const prompt = typeof args.prompt === 'string' ? args.prompt : ''
      if (!prompt.trim()) return { ok: false, text: 'prompt_session requires a non-empty prompt.' }
      const delivery: PromptDelivery = args.delivery === 'steer' ? 'steer' : 'queue'
      const meta = await findSession(sessionId)
      if (!meta) return { ok: false, text: `Session ${sessionId} not found.` }
      const result = await sessionController.promptSession(sessionId, prompt, delivery)
      const exchangeId = randomUUID()
      const dispatchedAt = Date.now()
      // Always arm the exchange when we know the caller — the renderer's
      // agent-conversation card needs the settle even when the model opted out.
      // Queued dispatches bind to their queueId's future run; started/steered
      // ones ride the run now in flight.
      if (callerSessionId) {
        sessionController.watchSessionSettled(sessionId, callerSessionId, {
          exchangeId,
          dispatchedAt,
          notifyModel: notifyOnCompletion,
          runKey: result.disposition === 'queued' && result.queueId ? result.queueId : 'active',
        })
      }
      deps.onAgentConversationUpdate?.({
        phase: 'dispatched',
        agentSessionId: sessionId,
        exchangeId,
        origin: 'prompted',
        prompt,
        delivery,
        provider: meta.provider,
        title: peerTitle(meta),
        cwd: meta.cwd,
        model: meta.model,
        reasoningEffort: meta.reasoningEffort,
        dispatchedAt,
      })
      const dispatch = result.disposition === 'queued'
        ? 'Queued prompt for'
        : result.disposition === 'steered'
          ? 'Steered the active turn in'
          : 'Prompt dispatched to'
      const completion = notifyOnCompletion
        ? " You'll receive its reply in this conversation when it finishes (note: pending replies are lost if the app restarts — use read_session to catch up)."
        : ''
      return { ok: true, text: `${dispatch} ${sessionLink(meta)}.${completion}` }
    }

    if (name === 'wait_for_session') {
      if (!sessionController) return { ok: false, text: 'wait_for_session is unavailable — no session controller is wired.' }
      const sessionId = String(args.session_id ?? '').trim()
      if (!sessionId) return { ok: false, text: 'wait_for_session requires session_id.' }
      const callerSessionId = deps.ctx?.sessionId
      if (!callerSessionId) return { ok: false, text: 'wait_for_session is unavailable before the calling session is initialized.' }
      if (sessionId === callerSessionId) return { ok: false, text: 'Cannot watch your own session.' }
      const meta = await findSession(sessionId)
      if (!meta) return { ok: false, text: `Session ${sessionId} not found.` }
      const liveStatus = sessionController.liveStatus(sessionId)
      const status = liveStatus ?? meta.status ?? 'idle'
      if (!liveStatus || !isBusy(liveStatus)) {
        return {
          ok: true,
          text: `Session ${sessionLink(meta)} is currently ${status}, not running/busy; no watcher was registered. Use read_session to inspect its latest reply.`,
        }
      }
      const watchExchangeId = randomUUID()
      const watchDispatchedAt = Date.now()
      sessionController.watchSessionSettled(sessionId, callerSessionId, { exchangeId: watchExchangeId, dispatchedAt: watchDispatchedAt, notifyModel: true, runKey: 'active' })
      deps.onAgentConversationUpdate?.({
        phase: 'dispatched',
        agentSessionId: sessionId,
        exchangeId: watchExchangeId,
        origin: 'watched',
        prompt: '',
        provider: meta.provider,
        title: peerTitle(meta),
        cwd: meta.cwd,
        model: meta.model,
        reasoningEffort: meta.reasoningEffort,
        dispatchedAt: watchDispatchedAt,
      })
      return {
        ok: true,
        text: `Watching session ${sessionLink(meta)} (current status: ${liveStatus}). This call returns immediately; its reply will arrive later in this conversation as a [session report].`,
      }
    }

    if (name === 'stop_session') {
      if (!sessionController) return { ok: false, text: 'stop_session is unavailable — no session controller is wired.' }
      const sessionId = String(args.session_id ?? '').trim()
      if (!sessionId) return { ok: false, text: 'stop_session requires session_id.' }
      if (sessionId === deps.ctx?.sessionId) return { ok: false, text: 'Cannot stop your own session.' }
      const meta = await findSession(sessionId)
      if (!meta) return { ok: false, text: `Session ${sessionId} not found.` }
      const stopped = sessionController.stopSession(sessionId)
      if (stopped) deps.onAgentConversationUpdate?.({ phase: 'stopped', agentSessionId: sessionId })
      return stopped
        ? { ok: true, text: `Stopped session ${sessionId}.` }
        : { ok: true, text: `Session ${sessionId} is not currently running.` }
    }

    if (name !== 'create_session') return { ok: false, text: `Unknown session tool: ${name}` }

    const prompt = typeof args.prompt === 'string' ? args.prompt : ''
    if (!prompt.trim()) return { ok: false, text: 'create_session requires a non-empty prompt.' }
    // Required so the caller commits to an intent instead of inheriting a default.
    const mode = args.mode === 'delegate' || args.mode === 'fire_and_forget' ? args.mode : null
    if (!mode) {
      return { ok: false, text: "create_session requires mode: 'delegate' (you need the reply — it arrives later as a [session report]) or 'fire_and_forget' (just start the task; no report, do not wait or poll)." }
    }
    if (!sessionCreator) {
      return { ok: false, text: 'create_session is unavailable — it requires the app to be running with an active control plane.' }
    }

    const requestedProvider = String(args.agent_provider ?? deps.ctx?.agentProvider ?? 'claude-code')
    const targets = await listAgentTargets()
    const target = targets.find((candidate) => candidate.provider === requestedProvider)
    if (!target) {
      return { ok: false, text: `Unknown agent provider "${requestedProvider}". Call list_agent_targets for current choices.` }
    }
    if (!target.available) {
      return { ok: false, text: `Agent provider "${requestedProvider}" is unavailable${target.unavailableReason ? `: ${target.unavailableReason}` : '.'}` }
    }
    const p = target.provider

    const modelId = typeof args.model_id === 'string' ? args.model_id.trim() : ''
    if (!modelId) return { ok: false, text: 'create_session requires model_id.' }
    const profile = target.models.find((model) => model.id === modelId)
    if (!profile) {
      return { ok: false, text: `Unknown model "${modelId}" for ${p}. Valid models: ${target.models.map((model) => model.id).join(', ') || '(none)'}.` }
    }

    const reasoningEffort = reasoning(args.reasoning_effort, profile.defaultReasoningEffort)
    if (profile.reasoningLevels.length > 0 && !profile.reasoningLevels.includes(reasoningEffort)) {
      return { ok: false, text: `Model "${modelId}" does not support reasoning level "${reasoningEffort}". Supported: ${profile.reasoningLevels.join(', ')}.` }
    }

    const contextWindow = profile.defaultContextWindow
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : (deps.ctx?.cwd ?? '~')
    const title = prompt.length > 80 ? prompt.slice(0, 80) : prompt

    const worktreeBaseBranch = typeof args.worktree_base_branch === 'string' && args.worktree_base_branch.trim()
      ? args.worktree_base_branch.trim()
      : null
    const exchangeId = randomUUID()
    const dispatchedAt = Date.now()

    // The card appears the moment the prompt is dispatched — starting a session
    // can take a while (worktree setup, provider handshake) and that work must
    // never be invisible. It binds to the real session id via `attached`.
    deps.onAgentConversationUpdate?.({
      phase: 'dispatched',
      agentSessionId: `pending:${exchangeId}`,
      exchangeId,
      origin: 'created',
      prompt,
      provider: p,
      title,
      cwd,
      model: modelId,
      reasoningEffort,
      fireAndForget: mode === 'fire_and_forget',
      dispatchedAt,
    })

    let agentSessionId: string
    try {
      ;({ agentSessionId } = await sessionCreator({ prompt, provider: p, modelId, reasoningEffort, contextWindow, cwd, worktreeBaseBranch }))
    } catch (err: any) {
      // Settle the card rather than leaving it dispatching forever.
      deps.onAgentConversationUpdate?.({
        phase: 'settled',
        agentSessionId: `pending:${exchangeId}`,
        exchangeId,
        status: 'failed',
        replyText: '',
        settledAt: Date.now(),
      })
      throw err
    }

    // Once started, the indexed cwd is the worktree path for worktree-backed
    // sessions; the pre-worktree cwd stood in until now.
    const created = await findSession(agentSessionId)
    deps.onAgentConversationUpdate?.({ phase: 'attached', exchangeId, agentSessionId, cwd: created?.cwd })

    const callerSessionId = deps.ctx?.sessionId
    if (callerSessionId && sessionController?.recordSessionDelegation) {
      try {
        await sessionController.recordSessionDelegation({
          childSessionId: agentSessionId,
          parentSessionId: callerSessionId,
          exchangeId,
          intent: mode,
          createdAt: dispatchedAt,
        })
      } catch (error) {
        // The child is already running. Lineage is useful metadata, but failure
        // to record it must not strand or fail a successfully-created session.
        log.warn('session_delegation_record_failed', { sessionId: agentSessionId, error: String(error) })
      }
    }

    // The renderer's agent-conversation card always gets the first reply; the model's
    // [session report] only fires in delegate mode.
    const notifyModel = mode === 'delegate'
    if (callerSessionId && sessionController) {
      sessionController.watchSessionSettled(agentSessionId, callerSessionId, {
        exchangeId,
        dispatchedAt,
        notifyModel,
        runKey: 'active',
      })
    }
    const followUp = notifyModel
      ? " Its first reply will arrive in this conversation as a [session report] — finish your turn rather than polling (pending reports are lost if the app restarts; use read_session to catch up)."
      : ' Fire-and-forget: no report will arrive here. Do not wait or poll — the user follows the session through its card.'
    return {
      ok: true,
      text: `Created session ${sessionLink({ provider: p, sessionId: agentSessionId, slug: null, cwd })} running on ${p}/${modelId} (reasoning: ${reasoningEffort}). A card to open it was added to the conversation.${followUp}`,
    }
  } catch (err: any) {
    log.error('session_tool_failed', { tool: name, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, text: `Session tool error: ${String(err?.message ?? err)}` }
  }
}

function sessionAgentTool(
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
    execute: async (args, context) => executeSessionTool(name, args, {
      ctx: {
        agentProvider: context.provider,
        cwd: context.cwd,
        sessionId: context.sessionId(),
      },
      onAgentConversationUpdate: (update) => context.emit({ type: 'agent_conversation_update', update }),
    }),
  }
}

export const listSessionsAgentTool = sessionAgentTool('list_sessions', LIST_SESSIONS_DESC, listSessionsShape, false)
export const listAgentTargetsAgentTool = sessionAgentTool('list_agent_targets', LIST_AGENT_TARGETS_DESC, listAgentTargetsShape, false)
export const readSessionAgentTool = sessionAgentTool('read_session', READ_SESSION_DESC, readSessionShape, false)
export const searchSessionsAgentTool = sessionAgentTool('search_sessions', SEARCH_SESSIONS_DESC, searchSessionsShape, false)
export const createSessionAgentTool = sessionAgentTool('create_session', CREATE_SESSION_DESC, createSessionShape, false)
export const promptSessionAgentTool = sessionAgentTool('prompt_session', PROMPT_SESSION_DESC, promptSessionShape, false)
export const waitForSessionAgentTool = sessionAgentTool('wait_for_session', WAIT_FOR_SESSION_DESC, waitForSessionShape, false)
export const stopSessionAgentTool = sessionAgentTool('stop_session', STOP_SESSION_DESC, stopSessionShape, false)

export const sessionAgentTools: AgentTool[] = [
  listAgentTargetsAgentTool,
  listSessionsAgentTool,
  readSessionAgentTool,
  searchSessionsAgentTool,
  createSessionAgentTool,
  promptSessionAgentTool,
  waitForSessionAgentTool,
  stopSessionAgentTool,
]
