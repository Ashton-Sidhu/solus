import { query, type McpServerStatus, type Query } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { resolveHomePath } from '../../../platform/paths'
import { SOLUS_PLUGINS_DIR } from '../plugins'
import { claudeEnv, resolveClaudeExecutable, type ClaudeSeat } from './claude-agent'

/**
 * The MCP sign-in control requests the SDK's Query sends but does not declare:
 * the same ones the VS Code extension uses. Checked at runtime, so an SDK that
 * drops them fails with a message instead of a TypeError.
 */
interface McpAuthControls {
  mcpAuthenticate(serverName: string): Promise<unknown>
  mcpSubmitOAuthCallbackUrl(serverName: string, callbackUrl: string): Promise<unknown>
  mcpClearAuth(serverName: string): Promise<unknown>
}

function hasMcpAuthControls(candidate: Query): candidate is Query & McpAuthControls {
  return 'mcpAuthenticate' in candidate && typeof candidate.mcpAuthenticate === 'function'
    && 'mcpSubmitOAuthCallbackUrl' in candidate && typeof candidate.mcpSubmitOAuthCallbackUrl === 'function'
    && 'mcpClearAuth' in candidate && typeof candidate.mcpClearAuth === 'function'
}

const mcpAuthenticateResponseSchema = z.object({
  authUrl: z.string().optional(),
  requiresUserAction: z.boolean(),
  /** False for a claude.ai connector: the sign-in finishes on claude.ai. */
  callbackExpected: z.boolean(),
})
export type McpAuthenticateResponse = z.infer<typeof mcpAuthenticateResponseSchema>

/**
 * A Claude process held open in one directory and seat, with no turn, for one
 * MCP server's sign-in. It loads the same settings and plugins a turn does, so it
 * sees the same servers, and the CLI stores the credential where that seat's
 * turns read it.
 */
export interface ClaudeMcpAuthSession {
  status(server: string): Promise<McpServerStatus | null>
  authenticate(server: string): Promise<McpAuthenticateResponse>
  /** Resolves once the CLI has finished the sign-in with the address the browser ended on. */
  submitCallbackUrl(server: string, callbackUrl: string): Promise<void>
  clearAuth(server: string): Promise<void>
  close(): Promise<void>
}

export async function openClaudeMcpAuthSession(opts: { cwd: string; seat: ClaudeSeat }): Promise<ClaudeMcpAuthSession> {
  const abortController = new AbortController()
  // Streaming input that yields no turn keeps the process alive for control requests.
  async function* emptyInput(): AsyncGenerator<never> {
    await new Promise<void>((resolve) =>
      abortController.signal.addEventListener('abort', () => resolve(), { once: true }))
    yield* []
  }
  const session = query({
    prompt: emptyInput(),
    options: {
      cwd: resolveHomePath(opts.cwd),
      abortController,
      settingSources: ['user', 'project'],
      pathToClaudeCodeExecutable: await resolveClaudeExecutable(),
      plugins: [{ type: 'local', path: SOLUS_PLUGINS_DIR }],
      extraArgs: { 'no-session-persistence': null },
      env: claudeEnv(opts.seat),
    },
  })
  const drain = (async () => { try { for await (const _ of session) { /* until aborted */ } } catch { /* aborted */ } })()
  const close = async (): Promise<void> => {
    abortController.abort()
    await drain
  }
  if (!hasMcpAuthControls(session)) {
    await close()
    throw new Error('This Claude Code version cannot sign in to MCP servers from Solus. Update Claude Code and try again.')
  }
  return {
    async status(server) {
      return (await session.mcpServerStatus()).find((each) => each.name === server) ?? null
    },
    async authenticate(server) {
      return mcpAuthenticateResponseSchema.parse(await session.mcpAuthenticate(server))
    },
    async submitCallbackUrl(server, callbackUrl) {
      await session.mcpSubmitOAuthCallbackUrl(server, callbackUrl)
    },
    async clearAuth(server) {
      await session.mcpClearAuth(server)
    },
    close,
  }
}
