import { z } from 'zod'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { createLogger } from '../logger'
import { MODEL_PROFILES } from '../../shared/types'
import type { AgentId, ReasoningEffort } from '../../shared/types'

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
}

export type SessionCreator = (req: SessionCreateRequest) => Promise<{ agentSessionId: string }>

let sessionCreator: SessionCreator | null = null
export function setSessionCreator(creator: SessionCreator): void {
  sessionCreator = creator
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

export interface SessionToolCtx {
  agentProvider: AgentId
  cwd: string
  sessionId: string | undefined
}

export interface SessionToolDeps {
  ctx?: SessionToolCtx
  onSessionCreated?: OnSessionCreated
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
}

export const CREATE_SESSION_DESC =
  'Create a NEW Solus chat session that starts running the given prompt right away on its own agent, model, and reasoning level. A card appears in the conversation; clicking it opens the new session in a tab. Use this to spin off a parallel task into its own thread. Call it once per session you want to start. Returns the new session id.'

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

    const { agentSessionId } = await sessionCreator({ prompt, provider: p, modelId, reasoningEffort, contextWindow, cwd })

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
}

export function sessionSdkTools(deps: SessionSdkDeps) {
  const mk = (): SessionToolDeps => ({
    ctx: { agentProvider: deps.agentProvider, cwd: deps.cwd, sessionId: deps.sessionId() },
    onSessionCreated: deps.onSessionCreated,
  })
  return [
    tool('create_session', CREATE_SESSION_DESC, createSessionShape, async (args) =>
      toToolResult(await executeSessionTool('create_session', (args ?? {}) as Record<string, unknown>, mk())),
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
  { name: 'create_session', description: CREATE_SESSION_DESC, inputSchema: z.toJSONSchema(z.object(createSessionShape)) as Record<string, unknown> },
]

export const SESSION_TOOL_NAMES = new Set(SESSION_TOOL_JSON_SCHEMAS.map((t) => t.name))
