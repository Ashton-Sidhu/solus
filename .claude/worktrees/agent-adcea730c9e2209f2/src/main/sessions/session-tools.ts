import { z } from 'zod'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { createLogger } from '../logger'
import { MODEL_PROFILES } from '../../shared/types'
import type { AgentId, ReasoningEffort, SessionMeta, SessionStatus } from '../../shared/types'
import type { SessionLoadMessage } from '../../shared/session-history'

const log = createLogger('sessions', 'session-tools.ts')

/**
 * Single source of truth for the agent-facing `create_session` tool, which spawns
 * a brand-new Solus chat session running a given prompt. Like work-tools.ts and
 * automation-tools.ts it exports three shapes from one zod schema: a Claude SDK
 * `tool()`, a Codex JSON-schema descriptor, and a shared executor. The tool
 * returns error TEXT (never throws) so a bad call degrades to a recoverable
 * message.
 *
 * The session is created via an injected `SessionCreator` (wired to the
 * ControlPlane in the server layer) so this module stays decoupled from the
 * control plane — mirroring `setAutomationSessionDispatcher`.
 */

const REASONING_VALUES = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const
// Providers that can start a session. 'opencode' is excluded — same constraint
// the automation runner applies (no headless runner yet).
const AGENT_PROVIDER_VALUES = ['claude-code', 'codex'] as const

// ─── Injected session creator (wired to the ControlPlane in server/index.ts) ───

export interface SessionCreateRequest {
  prompt: string
  provider: AgentId
  modelId: string | null
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

export interface SessionController {
  listSessions(providers: AgentId[], projectPath: string): Promise<SessionMeta[]>
  getSessionInfo(provider: AgentId, sessionId: string, projectPath?: string): Promise<SessionMeta | null>
  loadSessionTail(provider: AgentId, sessionId: string, projectPath: string | undefined, limit: number): Promise<SessionLoadMessage[]>
  liveStatus(agentSessionId: string): SessionStatus | null
  promptSession(agentSessionId: string, prompt: string): Promise<{ queued: boolean }>
  stopSession(agentSessionId: string): boolean
}

let sessionController: SessionController | null = null
export function setSessionController(controller: SessionController): void {
  sessionController = controller
}

// ─── Side-effect callback + per-call context ───

export interface SessionCreatedPayload {
  agentSessionId: string
  title: string
  provider: AgentId
  cwd: string
}

/** Fired once a session is created, so the calling thread can render a card that
 *  opens the new session in a tab. */
export type OnSessionCreated = (session: SessionCreatedPayload) => void

export interface SessionPromptedPayload {
  agentSessionId: string
  promptPreview: string
  provider: AgentId
  cwd: string
}

export type OnSessionPrompted = (session: SessionPromptedPayload) => void

export interface SessionStoppedPayload {
  agentSessionId: string
  provider: AgentId
  cwd: string
}

export type OnSessionStopped = (session: SessionStoppedPayload) => void

export interface SessionToolCtx {
  agentProvider: AgentId
  cwd: string
  sessionId: string | undefined
}

export interface SessionToolDeps {
  ctx?: SessionToolCtx
  onSessionCreated?: OnSessionCreated
  onSessionPrompted?: OnSessionPrompted
  onSessionStopped?: OnSessionStopped
}

// ─── Schema ───

const createSessionShape = {
  prompt: z.string().describe('The prompt the new session starts running immediately.'),
  agent_provider: z
    .enum(AGENT_PROVIDER_VALUES)
    .optional()
    .describe("Which agent runs the session: 'claude-code' (default) or 'codex'. Defaults to the calling session's provider."),
  model_id: z
    .string()
    .nullable()
    .optional()
    .describe("Model id to run with (e.g. 'claude-opus-4-8', 'gpt-5.5'). Omit or null for the provider's default model."),
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
}

const listSessionsShape = {
  project_path: z.string().optional().describe('Project path to list sessions for. Defaults to the calling session cwd.'),
  status: z.enum(['active', 'all']).optional().describe("Default 'active' lists only busy/rate-limited sessions; 'all' includes historical sessions."),
  limit: z.number().int().min(1).max(50).optional().describe('Maximum sessions to return. Defaults to 15.'),
}

const readSessionShape = {
  session_id: z.string().describe('The session id to inspect.'),
  tail: z.number().int().min(1).max(50).optional().describe('Number of tail messages to return. Defaults to 10.'),
}

const promptSessionShape = {
  session_id: z.string().describe('The target session id. Cannot be your own session.'),
  prompt: z.string().describe('Prompt to send into the target session. Queues if that session is busy.'),
}

const stopSessionShape = {
  session_id: z.string().describe('The target session id. Cannot be your own session.'),
}

export const CREATE_SESSION_DESC =
  'Create a NEW Solus chat session that starts running the given prompt right away on its own agent, model, and reasoning level. A card appears in the conversation; clicking it opens the new session in a tab. Use this to spin off a parallel task into its own thread. Call it once per session you want to start. Returns the new session id.'
const LIST_SESSIONS_DESC =
  "List Solus sessions for this project so an orchestrator can observe worker status. By default excludes the calling session and returns only active/busy sessions."
const READ_SESSION_DESC =
  "Read status and recent tail messages for a Solus session. Use this to inspect worker progress or identify sessions awaiting input."
const PROMPT_SESSION_DESC =
  "Send a prompt into another Solus session by session id. If the target is busy, the prompt is queued. Cannot target your own session."
const STOP_SESSION_DESC =
  "Stop another running Solus session and clear its queued prompts. Cannot target your own session."

// ─── Helpers ───

function reasoning(value: unknown, fallback: ReasoningEffort): ReasoningEffort {
  return (REASONING_VALUES as readonly string[]).includes(String(value)) ? (value as ReasoningEffort) : fallback
}

function provider(value: unknown, fallback: AgentId): AgentId {
  return (AGENT_PROVIDER_VALUES as readonly string[]).includes(String(value)) ? (value as AgentId) : fallback
}

function defaultModelFor(p: AgentId): string {
  const profiles = MODEL_PROFILES[p] ?? {}
  return Object.entries(profiles).find(([, prof]) => prof.isDefault)?.[0] ?? Object.keys(profiles)[0] ?? ''
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 1))}…` : oneLine
}

function isBusy(status: SessionStatus | undefined): boolean {
  return status === 'connecting' || status === 'running' || status === 'awaiting_input' || status === 'awaiting_plan' || status === 'rate_limited'
}

async function findSession(sessionId: string, projectPath?: string): Promise<SessionMeta | null> {
  if (!sessionController) return null
  for (const provider of AGENT_PROVIDER_VALUES) {
    const meta = await sessionController.getSessionInfo(provider, sessionId, projectPath)
    if (meta) return meta
    if (projectPath) {
      const fallback = await sessionController.getSessionInfo(provider, sessionId)
      if (fallback) return fallback
    }
  }
  return null
}

function formatTail(messages: SessionLoadMessage[]): string {
  if (!messages.length) return '(no messages)'
  return messages.map((m) => {
    if (m.toolName) return `[tool: ${m.toolName}]`
    const content = truncate(m.content || m.toolInput || m.toolResultForId || '', 500)
    return `[${m.role || 'message'}] ${content || '(empty)'}`
  }).join('\n')
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
        return `${meta.sessionId}${self}  [${meta.status ?? 'idle'}]  ${meta.provider}  ${meta.cwd}  "${truncate(meta.firstMessage ?? '', 80)}"  (${meta.lastTimestamp})`
      })
      return { ok: true, text: `Sessions:\n${lines.join('\n')}` }
    }

    if (name === 'read_session') {
      if (!sessionController) return { ok: false, text: 'read_session is unavailable — no session controller is wired.' }
      const sessionId = String(args.session_id ?? '').trim()
      if (!sessionId) return { ok: false, text: 'read_session requires session_id.' }
      const tail = typeof args.tail === 'number' ? Math.min(50, Math.max(1, Math.floor(args.tail))) : 10
      const meta = await findSession(sessionId, deps.ctx?.cwd)
      if (!meta) return { ok: false, text: `Session ${sessionId} not found.` }
      const status = sessionController.liveStatus(sessionId) ?? meta.status ?? 'idle'
      const messages = await sessionController.loadSessionTail(meta.provider, sessionId, meta.projectPath || deps.ctx?.cwd, tail)
      const stuck = status === 'awaiting_input' ? ' — awaiting input/permission' : status === 'awaiting_plan' ? ' — awaiting plan approval' : ''
      return {
        ok: true,
        text: [
          `Session ${sessionId}`,
          `status: ${status}${stuck}`,
          `provider: ${meta.provider}`,
          `cwd: ${meta.cwd}`,
          `lastTimestamp: ${meta.lastTimestamp}`,
          '',
          formatTail(messages),
        ].join('\n'),
      }
    }

    if (name === 'prompt_session') {
      if (!sessionController) return { ok: false, text: 'prompt_session is unavailable — no session controller is wired.' }
      const sessionId = String(args.session_id ?? '').trim()
      if (!sessionId) return { ok: false, text: 'prompt_session requires session_id.' }
      if (sessionId === deps.ctx?.sessionId) return { ok: false, text: 'Cannot prompt your own session.' }
      const prompt = typeof args.prompt === 'string' ? args.prompt : ''
      if (!prompt.trim()) return { ok: false, text: 'prompt_session requires a non-empty prompt.' }
      const meta = await findSession(sessionId, deps.ctx?.cwd)
      if (!meta) return { ok: false, text: `Session ${sessionId} not found.` }
      const result = await sessionController.promptSession(sessionId, prompt)
      deps.onSessionPrompted?.({ agentSessionId: sessionId, promptPreview: truncate(prompt, 80), provider: meta.provider, cwd: meta.cwd })
      return { ok: true, text: result.queued ? `Queued prompt for session ${sessionId}.` : `Dispatched prompt to session ${sessionId}.` }
    }

    if (name === 'stop_session') {
      if (!sessionController) return { ok: false, text: 'stop_session is unavailable — no session controller is wired.' }
      const sessionId = String(args.session_id ?? '').trim()
      if (!sessionId) return { ok: false, text: 'stop_session requires session_id.' }
      if (sessionId === deps.ctx?.sessionId) return { ok: false, text: 'Cannot stop your own session.' }
      const meta = await findSession(sessionId, deps.ctx?.cwd)
      if (!meta) return { ok: false, text: `Session ${sessionId} not found.` }
      const stopped = sessionController.stopSession(sessionId)
      if (stopped) deps.onSessionStopped?.({ agentSessionId: sessionId, provider: meta.provider, cwd: meta.cwd })
      return stopped
        ? { ok: true, text: `Stopped session ${sessionId}.` }
        : { ok: true, text: `Session ${sessionId} is not currently running.` }
    }

    if (name !== 'create_session') return { ok: false, text: `Unknown session tool: ${name}` }

    const prompt = typeof args.prompt === 'string' ? args.prompt : ''
    if (!prompt.trim()) return { ok: false, text: 'create_session requires a non-empty prompt.' }
    if (!sessionCreator) {
      return { ok: false, text: 'create_session is unavailable — it requires the app to be running with an active control plane.' }
    }

    const p = provider(args.agent_provider ?? deps.ctx?.agentProvider, 'claude-code')
    const profiles = MODEL_PROFILES[p] ?? {}

    // Resolve the model: an explicit id must belong to the chosen provider;
    // otherwise fall back to that provider's default.
    const requested = typeof args.model_id === 'string' && args.model_id.trim() ? args.model_id.trim() : null
    if (requested && !profiles[requested]) {
      return { ok: false, text: `Unknown model "${requested}" for ${p}. Valid models: ${Object.keys(profiles).join(', ') || '(none)'}.` }
    }
    const modelId = requested ?? defaultModelFor(p)
    const profile = profiles[modelId]

    const reasoningEffort = reasoning(args.reasoning_effort, profile?.defaultReasoningEffort ?? 'medium')
    if (profile && !profile.reasoningLevels.includes(reasoningEffort)) {
      return { ok: false, text: `Model "${modelId}" does not support reasoning level "${reasoningEffort}". Supported: ${profile.reasoningLevels.join(', ')}.` }
    }

    const contextWindow = profile?.defaultContextWindow ?? null
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : (deps.ctx?.cwd ?? '~')
    const title = prompt.length > 80 ? prompt.slice(0, 80) : prompt

    const worktreeBaseBranch = typeof args.worktree_base_branch === 'string' && args.worktree_base_branch.trim()
      ? args.worktree_base_branch.trim()
      : null
    const { agentSessionId } = await sessionCreator({ prompt, provider: p, modelId, reasoningEffort, contextWindow, cwd, worktreeBaseBranch })

    deps.onSessionCreated?.({ agentSessionId, title, provider: p, cwd })
    return {
      ok: true,
      text: `Created session ${agentSessionId} running on ${p}/${modelId || 'default'} (reasoning: ${reasoningEffort}). A card to open it was added to the conversation.`,
    }
  } catch (err: any) {
    log.error(`executeSessionTool(${name}) failed: ${String(err)}`)
    return { ok: false, text: `Session tool error: ${String(err?.message ?? err)}` }
  }
}

// ─── Shape 1: Claude SDK tool (composed into the `solus` MCP server) ───

function toToolResult(r: SessionToolResult) {
  return {
    content: [{ type: 'text' as const, text: r.text }],
    ...(r.ok ? {} : { isError: true as const }),
  }
}

/** Origin context for tool calls, resolved lazily (sessionId lands after init). */
export interface SessionSdkDeps {
  agentProvider: AgentId
  cwd: string
  sessionId: () => string | undefined
  onSessionCreated?: OnSessionCreated
  onSessionPrompted?: OnSessionPrompted
  onSessionStopped?: OnSessionStopped
}

export function sessionSdkTools(deps: SessionSdkDeps) {
  const mk = (): SessionToolDeps => ({
    ctx: { agentProvider: deps.agentProvider, cwd: deps.cwd, sessionId: deps.sessionId() },
    onSessionCreated: deps.onSessionCreated,
    onSessionPrompted: deps.onSessionPrompted,
    onSessionStopped: deps.onSessionStopped,
  })
  return [
    tool('list_sessions', LIST_SESSIONS_DESC, listSessionsShape, async (args) =>
      toToolResult(await executeSessionTool('list_sessions', (args ?? {}) as Record<string, unknown>, mk())),
    ),
    tool('read_session', READ_SESSION_DESC, readSessionShape, async (args) =>
      toToolResult(await executeSessionTool('read_session', (args ?? {}) as Record<string, unknown>, mk())),
    ),
    tool('create_session', CREATE_SESSION_DESC, createSessionShape, async (args) =>
      toToolResult(await executeSessionTool('create_session', (args ?? {}) as Record<string, unknown>, mk())),
    ),
    tool('prompt_session', PROMPT_SESSION_DESC, promptSessionShape, async (args) =>
      toToolResult(await executeSessionTool('prompt_session', (args ?? {}) as Record<string, unknown>, mk())),
    ),
    tool('stop_session', STOP_SESSION_DESC, stopSessionShape, async (args) =>
      toToolResult(await executeSessionTool('stop_session', (args ?? {}) as Record<string, unknown>, mk())),
    ),
  ]
}

// ─── Shape 2: Codex dynamicTools JSON-schema descriptors ───

export interface SessionToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const SESSION_TOOL_JSON_SCHEMAS: SessionToolDescriptor[] = [
  { name: 'list_sessions', description: LIST_SESSIONS_DESC, inputSchema: z.toJSONSchema(z.object(listSessionsShape)) as Record<string, unknown> },
  { name: 'read_session', description: READ_SESSION_DESC, inputSchema: z.toJSONSchema(z.object(readSessionShape)) as Record<string, unknown> },
  { name: 'create_session', description: CREATE_SESSION_DESC, inputSchema: z.toJSONSchema(z.object(createSessionShape)) as Record<string, unknown> },
  { name: 'prompt_session', description: PROMPT_SESSION_DESC, inputSchema: z.toJSONSchema(z.object(promptSessionShape)) as Record<string, unknown> },
  { name: 'stop_session', description: STOP_SESSION_DESC, inputSchema: z.toJSONSchema(z.object(stopSessionShape)) as Record<string, unknown> },
]

export const SESSION_TOOL_NAMES = new Set(SESSION_TOOL_JSON_SCHEMAS.map((t) => t.name))
export const SESSION_MUTATING_TOOLS = new Set(['prompt_session', 'stop_session'])
