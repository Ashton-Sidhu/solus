import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport, SdkHttpError } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import type { Transport } from '@modelcontextprotocol/client'
import { SdkError, SdkErrorCode, type CallToolRequest, type Prompt, type Tool } from '@modelcontextprotocol/client'
import { DEFAULT_INTEGRATION_ACCOUNT, type Integration, type IntegrationEnvValue, type IntegrationFacts } from '@solus/contracts/integration-types'
import { solusServerFor } from './solus-servers'
import { solusMcpServer } from './solus-servers/solus-server'
import type { AgentToolContext, AgentToolResult } from '../execution/agents/tools/agent-tool'
import type { IntegrationCredentials } from './connections'
import { cancellableFetch } from './cancellable-fetch'
import { stdioTransport, type StdioChild } from './stdio-process'

/**
 * One upstream session of the gateway (docs/plans/mcp-integrations.md §5.1):
 * its record, its key, its transport, and the errors it can end with.
 * `IntegrationGateway` owns the sessions; this module owns their shape.
 */

/** The person has no usable connection: the call returns `CONNECTION_REQUIRED` (§4.1 rule 2). */
export class ConnectionRequiredError extends Error {
  constructor() {
    super('connection required')
  }
}

/** One upstream tool as `tools/list` reported it, kept whole: the tool bridge needs its input schema. */
export type UpstreamTool = Pick<Tool, 'name' | 'title' | 'description' | 'inputSchema' | 'outputSchema' | 'annotations' | '_meta'>

/** One MCP prompt as `prompts/list` reported it (docs/plans/mcp-first-class.md §10). */
export type UpstreamPrompt = Pick<Prompt, 'name' | 'title' | 'description' | 'arguments'>

/** A server's prompt list and when its `ttlMs` ends; null when it gave none. */
export interface ListedPrompts {
  prompts: UpstreamPrompt[]
  expiresAt: number | null
}

/** A `tools/call` result as the SDK returns it. */
export type AppToolResult = Awaited<ReturnType<Client['callTool']>>

/** A `tools/call` input as the SDK takes it. */
export type ToolArguments = NonNullable<CallToolRequest['params']['arguments']>

/** A successful call of a tool that may declare an MCP App. */
export interface IntegrationAppCapture {
  integration: Integration
  tool: UpstreamTool
  input: ToolArguments
  result: AppToolResult
  context: AgentToolContext
}

export interface ActiveCall {
  integrationName: string
  context: AgentToolContext
  /** Stops the call's limits while a person answers an elicitation, and starts them again after. */
  pauseTimeout: () => void
  resumeTimeout: () => void
}

export interface UpstreamSession {
  integrationId: string
  personKey: string | null
  /** Which of the person's accounts the session signs in as (§13.3). */
  accountId: string
  client: Client
  connected: Promise<void>
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Calls in flight, newest last: an elicitation goes to the newest one. */
  calls: ActiveCall[]
  /** The session sends the person's `Authorization` header. */
  authorized: boolean
  openedAt: number
  /** Replaced by a newer session while calls were in flight: closed when the last one ends. */
  retired: boolean
  /** The gateway closes it: its end is not the process ending by itself. */
  closing: boolean
  lastUsedAt: number
  /** Set for a `stdio` integration once its process started. */
  stdio: StdioChild | null
}

/** What one integration and person's server told the gateway: its tools and the facts of its `initialize` answer. */
export interface ServerFacts {
  integrationId: string
  tools: UpstreamTool[]
  era: IntegrationFacts['era']
  instructions: string | null
  capabilities: IntegrationFacts['capabilities']
  /** The MCP prompts, listed on the first read after the tools; null until then, and after `prompts/list_changed`. */
  prompts: ListedPrompts | null
  /** The session closed, so `tools/list_changed` could not reach it: list again on the next read. */
  stale: boolean
  expiresAt: number | null
}

/** One session per integration, person, and account (§13.3); the first account keeps the key it always had. */
export function sessionKey(integrationId: string, personKey: string | null, accountId: string = DEFAULT_INTEGRATION_ACCOUNT): string {
  const base = `${integrationId}\u0000${personKey ?? ''}`
  return accountId === DEFAULT_INTEGRATION_ACCOUNT ? base : `${base}\u0000${accountId}`
}

/**
 * The session's transport. A remote server: streamable HTTP, with the header
 * going to the integration's URL only, so a redirect fails instead of carrying
 * it elsewhere (§4.1 rule 4). A Solus MCP server: an in-memory pair to its
 * server, built for this person, which reads their token on each request
 * (§13.6).
 */
export function upstreamTransport(
  integration: Integration,
  personKey: string | null,
  authorization: string | null,
  accountId: string,
  environment: IntegrationEnvValue[],
  credentials: IntegrationCredentials | null,
): Transport {
  // A command: the SDK starts it with no shell, and this transport holds its one child (§7.3).
  if (integration.kind === 'stdio') return stdioTransport(integration, environment)
  const server = solusServerFor(integration.url)
  if (server) {
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
    void solusMcpServer(server, {
      authorization: async () => (personKey === null ? null : (await credentials?.authorizationFor(integration.id, personKey, accountId)) ?? null),
      onRefused: (error) => { if (personKey !== null) credentials?.markNeedsSignIn(integration.id, personKey, error.message, accountId) },
    }).connect(serverEnd)
    return clientEnd
  }
  if (integration.kind === 'solus') throw new Error(`This version of Solus does not have ${integration.name}. Update Solus on this host.`)
  return authorization
    ? new StreamableHTTPClientTransport(new URL(integration.url), { requestInit: { headers: { Authorization: authorization }, redirect: 'error' }, fetch: cancellableFetch() })
    : new StreamableHTTPClientTransport(new URL(integration.url), { fetch: cancellableFetch() })
}

/** A tool's error text that reports an HTTP 401, as "(status: 401)", "HTTP 401", or "401 Unauthorized". */
const REFUSED_IN_RESULT = /\b(?:status|HTTP)\W{0,3}401\b|\b401\s+Unauthorized\b/i

/** The first try's own answer reports HTTP 401 for a session that sent a header. */
export function refusedInFirstCall(session: UpstreamSession, result: AgentToolResult, retried: boolean): boolean {
  return !retried && session.authorized && !result.ok && REFUSED_IN_RESULT.test(result.text)
}

/** The session's command ended by itself while a call was in flight (§7.3). */
export function stoppedWhileRunning(session: UpstreamSession | null): boolean {
  return session !== null && session.stdio !== null && session.stdio.ended && !session.closing
}

/** An in-flight modern request has no SSE resume path after transport loss. */
export function isLostResponse(cause: unknown): boolean {
  return !(cause instanceof SdkError) || cause.code === SdkErrorCode.ConnectionClosed || cause.code === SdkErrorCode.SendFailed
}

/** The server answered 401 or 403: it refused the header. */
export function isAuthFailure(cause: unknown): cause is SdkHttpError {
  return cause instanceof SdkHttpError && (cause.status === 401 || cause.status === 403)
}

export function refusedMessage(integration: Pick<Integration, 'name'>, error: SdkHttpError): string {
  return `${integration.name} refused the saved sign-in (HTTP ${error.status}). Sign in again.`
}

export function toolNames(tools: UpstreamTool[]): string {
  return tools.map((tool) => tool.name).join('\u0000')
}

/** The prompts a new tool list keeps: a list from before a closed session may be old, so the next prompt read lists again. */
export function promptsKept(previous: ServerFacts | undefined): ListedPrompts | null {
  return previous && !previous.stale ? previous.prompts : null
}

export function promptNames(prompts: UpstreamPrompt[]): string {
  return prompts.map((prompt) => prompt.name).join('\u0000')
}

/** An error as one short line. A URL in it keeps no query string. */
export function errorText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause)
  return text.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1').slice(0, 300)
}
