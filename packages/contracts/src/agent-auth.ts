/**
 * Agent sign-ins beyond the provider login (docs/plans/agent-auth-commands.md):
 * Claude Design (`/design-login`) and one MCP server's OAuth (`/mcp login`,
 * `/mcp logout`). Each runs on the host in the caller's own seat, like the seat
 * connect: the host prints where to sign in, the client opens it, and the code or
 * redirect address the browser ends on comes back through Solus. No credential
 * passes through Solus; the CLI stores it.
 */

import { z } from 'zod'
import { seatProviderSchema, type Seat, type SeatProvider } from './seats'

export const agentAuthMcpTargetSchema = z.object({
  kind: z.literal('mcp'),
  provider: seatProviderSchema,
  /** The MCP server's name, as the agent's configuration names it. */
  server: z.string().trim().min(1).max(256),
  /** The session's working directory: project-scoped servers are configured there. Resolved on the host. */
  cwd: z.string().min(1).max(4096),
}).strict()
export type AgentAuthMcpTarget = z.infer<typeof agentAuthMcpTargetSchema>

export const agentAuthTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claude-design') }).strict(),
  agentAuthMcpTargetSchema,
])
export type AgentAuthTarget = z.infer<typeof agentAuthTargetSchema>

/**
 * `waiting`: the host waits for the person. `code` asks for the code the page
 * shows; `redirect-url` asks for the address the browser ends on, which only a
 * browser on another device needs to bring back (on the host itself the redirect
 * finishes the sign-in). The end arrives as `host.agentAuthFinished`.
 * `external`: the sign-in finishes on the provider's site; nothing comes back.
 * `signed-in`: nothing to do.
 */
export const agentAuthStartResultSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('waiting'),
    flowId: z.string().min(1),
    url: z.string().min(1),
    input: z.enum(['code', 'redirect-url']),
  }),
  z.object({ state: z.literal('external'), url: z.string().min(1), message: z.string() }),
  z.object({ state: z.literal('signed-in'), message: z.string() }),
])
export type AgentAuthStartResult = z.infer<typeof agentAuthStartResultSchema>

export const agentAuthSubmitRequestSchema = z.object({
  flowId: z.string().min(1),
  value: z.string().trim().min(1).max(8192),
}).strict()
export type AgentAuthSubmitRequest = z.infer<typeof agentAuthSubmitRequestSchema>

export const agentAuthFlowRequestSchema = z.object({ flowId: z.string().min(1) }).strict()
export type AgentAuthFlowRequest = z.infer<typeof agentAuthFlowRequestSchema>

/** Sent to the clients of the seat that started the flow. */
export interface AgentAuthFinishedEvent {
  seat: Seat
  flowId: string
  ok: boolean
  message: string
}

/**
 * The sign-in commands Solus runs itself instead of sending them to the agent:
 * the provider CLIs keep them for their interactive terminal. Plain `/mcp` still
 * goes to the agent, which reports its servers.
 */
export const AGENT_AUTH_COMMANDS = [
  { command: '/login', description: 'Sign in to this agent on the host', providers: ['claude-code', 'codex'] },
  { command: '/design-login', description: 'Sign in to Claude Design on the host', providers: ['claude-code'] },
  { command: '/mcp login', description: 'Sign in to an MCP server', argumentHint: '<server>', providers: ['claude-code', 'codex'] },
  { command: '/mcp logout', description: 'Sign out of an MCP server', argumentHint: '<server>', providers: ['claude-code', 'codex'] },
] as const satisfies ReadonlyArray<{ command: string; description: string; argumentHint?: string; providers: readonly SeatProvider[] }>

export type AgentAuthCommand =
  | { kind: 'login'; provider: SeatProvider }
  | { kind: 'design-login' }
  /** `server` is null when the person typed no name. */
  | { kind: 'mcp-login' | 'mcp-logout'; provider: SeatProvider; server: string | null }

/** The sign-in command a prompt is, for a session on this provider, or null to send it to the agent. */
export function parseAgentAuthCommand(text: string, provider: string | null | undefined): AgentAuthCommand | null {
  const parsedProvider = seatProviderSchema.safeParse(provider)
  if (!parsedProvider.success) return null
  const seatProvider = parsedProvider.data
  const words = text.trim().split(/\s+/)
  switch (words[0]) {
    case '/login':
      return words.length === 1 ? { kind: 'login', provider: seatProvider } : null
    case '/design-login':
      return words.length === 1 && seatProvider === 'claude-code' ? { kind: 'design-login' } : null
    case '/mcp': {
      if (words[1] !== 'login' && words[1] !== 'logout') return null
      if (words.length > 3) return null
      return { kind: words[1] === 'login' ? 'mcp-login' : 'mcp-logout', provider: seatProvider, server: words[2] ?? null }
    }
    default:
      return null
  }
}
