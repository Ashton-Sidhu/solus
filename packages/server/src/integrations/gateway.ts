import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  ElicitRequestSchema,
  McpError,
  type CallToolRequest,
  ToolListChangedNotificationSchema,
  type ElicitRequest,
  type ElicitResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type { IntegrationToolSummary } from '@solus/contracts/integration-types'
import { ANY_ORGANIZATION } from '../admission/principal'
import { createLogger } from '../logger'
import { captureActingScope, currentCredentialUserId } from '../vault/acting-scope'
import type { AgentToolContext, AgentToolResult } from '../execution/agents/tools/agent-tool'
import { mcpElicitationResponse, normalizeMcpElicitationRequest } from '../execution/agents/codex/codex-permissions'
import { answerToolQuestionWith } from '../execution/sessions/input-requests'
import type { IntegrationStore } from './integration-store'
import { mapCallResult, toolSummary } from './integration-tools'

const log = createLogger('integrations', 'gateway.ts')

const IDLE_CLOSE_MS = 10 * 60 * 1000
const CALL_TIMEOUT_MS = 60 * 1000
/** The SDK's own request timeout is 60 s; the gateway's timer bounds a call instead, so it can pause while a person answers. */
const SDK_TIMEOUT_OFF_MS = 24 * 60 * 60 * 1000

/** One upstream tool as `tools/list` reported it, kept whole: the tool bridge needs its input schema. */
export type UpstreamTool = Pick<Tool, 'name' | 'title' | 'description' | 'inputSchema' | 'annotations'>

type ElicitationAnswers = Parameters<typeof mcpElicitationResponse>[1]
/** A `tools/call` input as the SDK takes it. */
export type ToolArguments = NonNullable<CallToolRequest['params']['arguments']>

/** One value of an accepted elicitation form, as the MCP SDK takes it. */
const elicitValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])

interface ActiveCall {
  integrationName: string
  context: AgentToolContext
  /** Stops the call's timer while a person answers an elicitation, and starts it again after. */
  pauseTimeout: () => void
  resumeTimeout: () => void
}

interface UpstreamSession {
  integrationId: string
  credentialUserId: string | null
  client: Client
  connected: Promise<void>
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Calls in flight, newest last: an elicitation goes to the newest one. */
  calls: ActiveCall[]
}

interface ToolCache {
  integrationId: string
  tools: UpstreamTool[]
  /** The session closed, so `tools/list_changed` could not reach it: list again when it reopens. */
  stale: boolean
}

/**
 * The server-side MCP client (docs/plans/mcp-integrations.md §5.1). One upstream
 * session per (integration, person), opened on first use and closed after idle
 * time. Phase 1 servers are anonymous, so no credentials are sent yet; the key is
 * already per person so a later sign-in needs no new shape.
 */
export class IntegrationGateway {
  private readonly sessions = new Map<string, UpstreamSession>()
  private readonly caches = new Map<string, ToolCache>()
  private readonly listing = new Map<string, Promise<UpstreamTool[]>>()
  private readonly listeners: Array<(integrationId: string) => void> = []

  /** The integration records; the tool bridge lists a scope's integrations through it. */
  constructor(readonly store: Pick<IntegrationStore, 'get' | 'list'>) {}

  /** The current person's tools of an integration, listed on first use. */
  async tools(integrationId: string): Promise<IntegrationToolSummary[]> {
    return (await this.upstreamTools(integrationId, currentCredentialUserId())).map(toolSummary)
  }

  /** The cached tools, or undefined before the first list. */
  cachedTools(integrationId: string): IntegrationToolSummary[] | undefined {
    return this.cachedUpstreamTools(integrationId)?.map(toolSummary)
  }

  /**
   * The cached upstream tools with their input schemas. The current person's list
   * when it is cached, else any person's: phase 1 servers are anonymous, so every
   * person sees the same list, and a run reads the list the boot warm made.
   */
  cachedUpstreamTools(integrationId: string): UpstreamTool[] | undefined {
    const own = this.caches.get(sessionKey(integrationId, captureActingScope()?.credentialUserId ?? null))
    if (own) return own.tools
    for (const cache of this.caches.values()) {
      if (cache.integrationId === integrationId) return cache.tools
    }
    return undefined
  }

  async call(integrationId: string, tool: string, input: ToolArguments, context: AgentToolContext): Promise<AgentToolResult> {
    const integration = this.store.get(integrationId, ANY_ORGANIZATION)
    if (!integration) return { ok: false, text: 'This integration was removed.' }
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new AbortController()
    const startTimer = () => { timer ??= setTimeout(() => timeout.abort(new Error('timeout')), CALL_TIMEOUT_MS) }
    const stopTimer = () => { if (timer) clearTimeout(timer); timer = null }
    const call: ActiveCall = { integrationName: integration.name, context, pauseTimeout: stopTimer, resumeTimeout: startTimer }
    let session: UpstreamSession | null = null
    try {
      session = await this.session(integrationId, currentCredentialUserId())
      session.calls.push(call)
      startTimer()
      const result = await session.client.callTool(
        { name: tool, arguments: input },
        undefined,
        { signal: AbortSignal.any([context.abortSignal, timeout.signal]), timeout: SDK_TIMEOUT_OFF_MS },
      )
      return mapCallResult(result)
    } catch (error) {
      if (context.abortSignal.aborted) return { ok: false, text: `The ${integration.name} call was stopped.` }
      if (timeout.signal.aborted) return { ok: false, text: `${integration.name} did not answer within ${CALL_TIMEOUT_MS / 1000} seconds.` }
      log.warn('integration_call_failed', { integrationId, tool, error: errorText(error) })
      // A transport failure drops the session so the next call opens a new one; a server error keeps it.
      if (session && !(error instanceof McpError)) void this.closeSession(sessionKey(integrationId, session.credentialUserId))
      return { ok: false, text: `${integration.name} could not run ${tool}: ${errorText(error)}` }
    } finally {
      stopTimer()
      if (session) {
        const index = session.calls.indexOf(call)
        if (index >= 0) session.calls.splice(index, 1)
        this.touch(sessionKey(integrationId, session.credentialUserId))
      }
    }
  }

  /** Forget an integration's sessions and tool lists, as after an edit or a removal. */
  invalidate(integrationId: string): void {
    for (const [key, cache] of this.caches) {
      if (cache.integrationId === integrationId) this.caches.delete(key)
    }
    for (const [key, session] of this.sessions) {
      if (session.integrationId === integrationId) void this.closeSession(key)
    }
  }

  /** List and cache, so a run can read the tools synchronously. Never throws. */
  async warm(integrationId: string): Promise<void> {
    try {
      // Boot has no acting scope: it warms the host's own list.
      await this.upstreamTools(integrationId, captureActingScope()?.credentialUserId ?? null)
    } catch (error) {
      log.warn('integration_warm_failed', { integrationId, error: errorText(error) })
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((key) => this.closeSession(key)))
  }

  onToolsChanged(listener: (integrationId: string) => void): void {
    this.listeners.push(listener)
  }

  private async upstreamTools(integrationId: string, credentialUserId: string | null): Promise<UpstreamTool[]> {
    const key = sessionKey(integrationId, credentialUserId)
    const cached = this.caches.get(key)
    if (cached && !cached.stale) return cached.tools
    const pending = this.listing.get(key)
    if (pending) return pending
    const listed = this.list(integrationId, credentialUserId).finally(() => this.listing.delete(key))
    this.listing.set(key, listed)
    return listed
  }

  private async list(integrationId: string, credentialUserId: string | null): Promise<UpstreamTool[]> {
    const session = await this.session(integrationId, credentialUserId)
    const key = sessionKey(integrationId, credentialUserId)
    const tools: UpstreamTool[] = []
    let cursor: string | undefined
    do {
      const page = await session.client.listTools(cursor ? { cursor } : undefined)
      for (const tool of page.tools) {
        tools.push({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations })
      }
      cursor = page.nextCursor
    } while (cursor)
    const previous = this.caches.get(key)
    this.caches.set(key, { integrationId, tools, stale: false })
    this.touch(key)
    log.info('integration_tools_listed', { integrationId, count: tools.length })
    if (previous && toolNames(previous.tools) !== toolNames(tools)) this.notify(integrationId)
    return tools
  }

  /** A person's session for an integration, opened on first use. */
  private async session(integrationId: string, credentialUserId: string | null): Promise<UpstreamSession> {
    const key = sessionKey(integrationId, credentialUserId)
    const open = this.sessions.get(key)
    if (open) {
      await open.connected
      return open
    }
    const integration = this.store.get(integrationId, ANY_ORGANIZATION)
    if (!integration) throw new Error('This integration was removed.')
    const client = new Client({ name: 'solus', version: '1.0.0' }, { capabilities: { elicitation: { form: {}, url: {} } } })
    const session: UpstreamSession = { integrationId, credentialUserId, client, connected: Promise.resolve(), idleTimer: null, calls: [] }
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      if (this.sessions.get(key) !== session) return
      this.caches.delete(key)
      this.notify(integrationId)
    })
    client.setRequestHandler(ElicitRequestSchema, (request) => this.elicit(session, request))
    session.connected = client.connect(new StreamableHTTPClientTransport(new URL(integration.url)))
    this.sessions.set(key, session)
    try {
      await session.connected
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key)
      void client.close().catch(() => undefined)
      log.warn('integration_session_failed', { integrationId, error: errorText(error) })
      throw new Error(`connection failed (${errorText(error)})`)
    }
    log.info('integration_session_opened', { integrationId, credentialUserId })
    this.touch(key)
    // The list cached before an idle close may be old: read it again in the background.
    if (this.caches.get(key)?.stale) void this.list(integrationId, credentialUserId).catch((error) => log.warn('integration_relist_failed', { integrationId, error: errorText(error) }))
    return session
  }

  /** Asks the person behind the newest call, as Codex's elicitation does (codex-permissions.ts). */
  private async elicit(session: UpstreamSession, request: ElicitRequest): Promise<ElicitResult> {
    const call = session.calls.at(-1)
    if (!call) return { action: 'decline' }
    const params = { ...request.params, mode: request.params.mode ?? 'form', serverName: call.integrationName }
    const normalized = normalizeMcpElicitationRequest(params)
    if (!normalized) return { action: 'decline' }
    const questionId = `integration-${crypto.randomUUID()}`
    call.pauseTimeout()
    try {
      const answers = await new Promise<ElicitationAnswers | null>((resolve) => {
        const stop = answerToolQuestionWith(questionId, (answered) => { stop(); resolve(answered) })
        const signal = call.context.abortSignal
        if (signal.aborted) { stop(); resolve(null); return }
        signal.addEventListener('abort', () => { stop(); resolve(null) }, { once: true })
        call.context.emit({ type: 'question_request', questionId, questions: normalized.questions, ...normalized.request })
      })
      if (!answers) return { action: 'cancel' }
      call.context.emit({ type: 'permission_resolved', questionId })
      return elicitResult(mcpElicitationResponse(params, answers))
    } finally {
      call.resumeTimeout()
    }
  }

  private touch(key: string): void {
    const session = this.sessions.get(key)
    if (!session) return
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      if (session.calls.length) return this.touch(key)
      void this.closeSession(key)
    }, IDLE_CLOSE_MS)
    session.idleTimer.unref?.()
  }

  private async closeSession(key: string): Promise<void> {
    const session = this.sessions.get(key)
    if (!session) return
    this.sessions.delete(key)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    const cache = this.caches.get(key)
    if (cache) cache.stale = true
    await session.client.close().catch((error) => log.warn('integration_session_close_failed', { integrationId: session.integrationId, error: errorText(error) }))
    log.info('integration_session_closed', { integrationId: session.integrationId })
  }

  private notify(integrationId: string): void {
    for (const listener of this.listeners) listener(integrationId)
  }
}

function sessionKey(integrationId: string, credentialUserId: string | null): string {
  return `${integrationId}\u0000${credentialUserId ?? ''}`
}

function toolNames(tools: UpstreamTool[]): string {
  return tools.map((tool) => tool.name).join('\u0000')
}

/** An error as one short line. A URL in it keeps no query string. */
function errorText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause)
  return text.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1').slice(0, 300)
}

/** The Codex answer shape as the MCP SDK's: no null content, only the value kinds a form may hold. */
function elicitResult(response: ReturnType<typeof mcpElicitationResponse>): ElicitResult {
  const fields = z.record(z.string(), z.json()).safeParse(response.content)
  if (response.action !== 'accept' || !fields.success) return { action: response.action }
  const content: NonNullable<ElicitResult['content']> = {}
  for (const [name, value] of Object.entries(fields.data)) {
    const parsed = elicitValueSchema.safeParse(value)
    if (parsed.success) content[name] = parsed.data
  }
  return { action: 'accept', content }
}
