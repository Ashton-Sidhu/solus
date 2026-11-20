import { z } from 'zod'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport, SdkHttpError } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import type { Transport } from '@modelcontextprotocol/client'
import {
  SdkError,
  SdkErrorCode,
  type CallToolRequest,
  type ElicitRequest,
  type ElicitResult,
  type ReadResourceResult,
  type PriorDiscovery,
  type Tool,
} from '@modelcontextprotocol/client'
import { ACCOUNT_INPUT, DEFAULT_INTEGRATION_ACCOUNT, type Integration, type IntegrationConnection, type IntegrationConnectNeeded, type IntegrationCustomServerNeeded, type IntegrationFacts, type IntegrationToolSummary } from '@solus/contracts/integration-types'
import { ANY_ORGANIZATION } from '../admission/principal'
import { createLogger } from '../logger'
import { solusServerFor } from './solus-servers'
import { solusMcpServer } from './solus-servers/solus-server'
import { currentPersonKey } from '../vault/acting-scope'
import type { AgentToolContext, AgentToolResult } from '../execution/agents/tools/agent-tool'
import { mcpElicitResult, mcpElicitationResponse, normalizeMcpElicitationRequest } from '../execution/agents/codex/codex-permissions'
import { answerToolQuestionWith } from '../execution/sessions/input-requests'
import type { IntegrationCredentials } from './connections'
import type { IntegrationStore } from './integration-store'
import { mapCallResult, toolSummary } from './integration-tools'
import { cancellableFetch } from './cancellable-fetch'
import { CALL_MAX_TOTAL_MS, CALL_TIMEOUT_MS, CallLimits, ProgressEvents, SYSTEM_CALL_CLOCK, type CallClock, type CallLimit } from './call-progress'
import type { Context } from '@opentelemetry/api'
import { SPAN_KINDS, SPAN_SERVICES, type SpanDimensions, type SpanStatus } from '../data/insights/registries'
import { endSolusSpan, startSolusSpan, w3cTraceparent } from '../execution/observability/tracer'

const log = createLogger('integrations', 'gateway.ts')

const IDLE_CLOSE_MS = 10 * 60 * 1000
/** The SDK's own request timeout is 60 s; the gateway's limits bound a call instead, so they can pause while a person answers. */
const SDK_TIMEOUT_OFF_MS = 24 * 60 * 60 * 1000
/** A session's `Authorization` header is a snapshot: ask for it again after this, before a token expires (§4.1 rule 5). */
const AUTHORIZATION_MAX_AGE_MS = 50 * 60 * 1000
/** Re-probe old servers daily so an upgraded server can move to the modern revision. */
const LEGACY_VERDICT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** What `connection_status` reports about one person's connection to an integration. */
export interface IntegrationConnectionReport {
  status: 'connected' | 'needs-sign-in' | 'not-connected'
  /** The account label, when connected and known. */
  label: string | null
  /** False when the integration needs no sign-in. */
  signInRequired: boolean
}

/** The person has no usable connection: the call returns `CONNECTION_REQUIRED` (§4.1 rule 2). */
class ConnectionRequiredError extends Error {
  constructor() {
    super('connection required')
  }
}

/** One upstream tool as `tools/list` reported it, kept whole: the tool bridge needs its input schema. */
export type UpstreamTool = Pick<Tool, 'name' | 'title' | 'description' | 'inputSchema' | 'outputSchema' | 'annotations' | '_meta'>

/** A `tools/call` result as the SDK returns it. */
type AppToolResult = Awaited<ReturnType<Client['callTool']>>

/** A successful call of a tool that may declare an MCP App. */
export interface IntegrationAppCapture {
  integration: Integration
  tool: UpstreamTool
  input: ToolArguments
  result: AppToolResult
  context: AgentToolContext
}

type ElicitationAnswers = Parameters<typeof mcpElicitationResponse>[1]
/** A `tools/call` input as the SDK takes it. */
export type ToolArguments = NonNullable<CallToolRequest['params']['arguments']>

interface ActiveCall {
  integrationName: string
  context: AgentToolContext
  /** Stops the call's limits while a person answers an elicitation, and starts them again after. */
  pauseTimeout: () => void
  resumeTimeout: () => void
}

/** Where a turn's span hangs: `SessionEmitter.turnContextOf`. */
type TurnContextOf = (sessionId: string, toolUseId?: string) => { context: Context; dimensions: SpanDimensions } | undefined

interface UpstreamSession {
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
}

interface ServerFacts {
  integrationId: string
  tools: UpstreamTool[]
  era: IntegrationFacts['era']
  instructions: string | null
  capabilities: IntegrationFacts['capabilities']
  /** The session closed, so `tools/list_changed` could not reach it: list again on the next read. */
  stale: boolean
  expiresAt: number | null
}

/**
 * The server-side MCP client (docs/plans/mcp-integrations.md §5.1). One upstream
 * session per (integration, person), opened on first use and closed after idle
 * time. A session of an integration that needs sign-in sends that person's
 * `Authorization` header to the integration's URL and nowhere else (§4.1 rule 4).
 */
export class IntegrationGateway {
  private readonly sessions = new Map<string, UpstreamSession>()
  private readonly serverFacts = new Map<string, ServerFacts>()
  private readonly revisions = new Map<string, { prior: PriorDiscovery; checkedAt: number }>()
  private readonly listing = new Map<string, Promise<UpstreamTool[]>>()
  private readonly listeners: Array<(integrationId: string) => void> = []
  private readonly factsListeners: Array<(integrationId: string) => void> = []
  private readonly connectNeededListeners: Array<(request: IntegrationConnectNeeded) => void> = []
  private readonly customServerNeededListeners: Array<(request: IntegrationCustomServerNeeded) => void> = []
  private readonly opening = new Map<string, Promise<UpstreamSession>>()
  private credentials: IntegrationCredentials | null = null
  private captureApp: ((call: IntegrationAppCapture) => Promise<void>) | null = null
  private turnContextOf: TurnContextOf | null = null

  /** The integration records; the tool bridge lists a scope's integrations through it. */
  constructor(readonly store: Pick<IntegrationStore, 'get' | 'list'>, private readonly callClock: CallClock = SYSTEM_CALL_CLOCK) {}

  /** Installed once at boot: how a session reads a person's sign-in. */
  useCredentials(credentials: IntegrationCredentials): void {
    this.credentials = credentials
  }

  /** Installed once at boot: what saves the MCP App a successful tool call declares. */
  useAppCapture(capture: (call: IntegrationAppCapture) => Promise<void>): void {
    this.captureApp = capture
  }

  /** Installed once at boot: the turn a call's `integration_call` span hangs from (§13). */
  useTurnContext(turnContextOf: TurnContextOf): void {
    this.turnContextOf = turnContextOf
  }

  /** Reads one resource with the current person's connection. It never starts an agent turn. */
  async readAppResource(integrationId: string, uri: string, options: { signal?: AbortSignal; timeout?: number } = {}): Promise<ReadResourceResult> {
    return this.withAppSession(integrationId, (client) => client.readResource({ uri }, { timeout: options.timeout ?? CALL_TIMEOUT_MS, signal: options.signal }))
  }

  /** Calls one tool for an MCP App with the current person's connection. It never starts an agent turn. */
  async callAppTool(integrationId: string, name: string, input: ToolArguments): Promise<AppToolResult> {
    return this.withAppSession(integrationId, (client) => client.callTool({ name, arguments: input }, { timeout: CALL_TIMEOUT_MS }))
  }

  private async withAppSession<T>(integrationId: string, use: (client: Client) => Promise<T>): Promise<T> {
    const session = await this.session(integrationId, currentPersonKey())
    try {
      return await use(session.client)
    } finally {
      this.touch(sessionKey(integrationId, session.personKey, session.accountId))
    }
  }

  /** The current person's tools of an integration, as Settings shows them. */
  async tools(integrationId: string): Promise<IntegrationToolSummary[]> {
    return (await this.toolsFor(integrationId, currentPersonKey())).map(toolSummary)
  }

  /** The caller's server facts. A list read also refreshes instructions and capabilities. */
  async facts(integrationId: string): Promise<IntegrationFacts> {
    return this.factsFor(integrationId, currentPersonKey())
  }

  async factsFor(integrationId: string, personKey: string | null): Promise<IntegrationFacts> {
    await this.toolsFor(integrationId, personKey)
    const facts = this.serverFacts.get(sessionKey(integrationId, personKey))
    return facts
      ? { era: facts.era, instructions: facts.instructions, capabilities: facts.capabilities }
      : { era: null, instructions: null, capabilities: { prompts: false, resources: false, resourceSubscribe: false, tasks: false } }
  }

  /**
   * One person's tools of an integration, with their input schemas, listed with
   * that person's connection on first use. A person with no connection, and the
   * host's own work (null), see the list another person's session cached, else an
   * anonymous list when the server gives one, else none (§5.2.1).
   */
  async toolsFor(integrationId: string, personKey: string | null): Promise<UpstreamTool[]> {
    try {
      return await this.upstreamTools(integrationId, personKey)
    } catch (error) {
      if (!(error instanceof ConnectionRequiredError)) throw error
      const cached = this.anyCachedTools(integrationId)
      if (cached) return cached
      return this.upstreamTools(integrationId, personKey, true).catch((retried) => {
        if (retried instanceof ConnectionRequiredError) return []
        throw retried
      })
    }
  }

  /** A list any person's session cached: the tools are the server's, only their use is per person. */
  private anyCachedTools(integrationId: string): UpstreamTool[] | undefined {
    for (const cache of this.serverFacts.values()) {
      if (cache.integrationId === integrationId) return cache.tools
    }
    return undefined
  }

  /**
   * Runs one upstream tool as the acting person. With several accounts
   * connected (§13.3), `solus_account` in the input names one by its label; without
   * it, a read-only tool runs for every account and a tool that may write is
   * refused with the labels to choose from.
   */
  async call(integrationId: string, tool: string, input: ToolArguments, context: AgentToolContext): Promise<AgentToolResult> {
    const integration = this.store.get(integrationId, ANY_ORGANIZATION)
    if (!integration) return { ok: false, text: 'This integration was removed.' }
    // A run that started before the tool was turned off still lists it.
    if (integration.disabledTools.includes(tool)) return { ok: false, text: `The ${tool} tool of ${integration.name} is turned off in Settings → MCP.` }
    const personKey = currentPersonKey()
    const accounts = personKey === null ? [] : this.connectedAccounts(integrationId, personKey)
    // With one account the tool has no account input, so every argument is the server's.
    if (accounts.length <= 1) return this.callAs(integration, tool, input, context, accounts[0]?.accountId ?? DEFAULT_INTEGRATION_ACCOUNT)
    const { account, args } = splitAccount(input)
    const labels = accounts.map(accountLabel)
    if (account) {
      const chosen = accounts.find((candidate) => accountLabel(candidate) === account || candidate.accountId === account)
      if (!chosen) return { ok: false, text: `${integration.name} has no account named ${account}. Its accounts: ${labels.join(', ')}.` }
      return this.callAs(integration, tool, args, context, chosen.accountId)
    }
    const upstream = (await this.toolsFor(integrationId, personKey)).find((candidate) => candidate.name === tool)
    if (!upstream?.annotations?.readOnlyHint) {
      return { ok: false, text: `${integration.name} has several accounts: ${labels.join(', ')}. Call ${tool} again with \`${ACCOUNT_INPUT}\` set to one of them.` }
    }
    // A read spans every account; each part names the account it came from.
    const results = await Promise.all(accounts.map((candidate) => this.callAs(integration, tool, args, context, candidate.accountId)))
    return {
      ok: results.some((result) => result.ok),
      text: results.map((result, index) => `## ${labels[index]}\n${result.text}`).join('\n\n'),
    }
  }

  /** The person's accounts on an integration that are connected now, the first first. */
  private connectedAccounts(integrationId: string, personKey: string): IntegrationConnection[] {
    return (this.credentials?.accountsFor?.(integrationId, personKey) ?? []).filter((connection) => connection.status === 'connected')
  }

  /** The labels of the person's connected accounts when there is more than one, for the tool's `solus_account` input. */
  accountChoices(integrationId: string, personKey: string | null): string[] {
    if (personKey === null) return []
    const accounts = this.connectedAccounts(integrationId, personKey)
    return accounts.length > 1 ? accounts.map(accountLabel) : []
  }

  private async callAs(integration: Integration, tool: string, input: ToolArguments, context: AgentToolContext, accountId: string, retried = false): Promise<AgentToolResult> {
    const integrationId = integration.id
    // §5: silence stops a call after 60 s, and progress starts that again; 30 minutes stop it in all.
    const timeout = new AbortController()
    let reachedLimit: CallLimit | null = null
    const limits = new CallLimits(this.callClock, (limit) => { reachedLimit = limit; timeout.abort(new Error('timeout')) })
    const progress = new ProgressEvents(this.callClock, context)
    const call: ActiveCall = { integrationName: integration.name, context, pauseTimeout: () => limits.pause(), resumeTimeout: () => limits.start() }
    const trace = this.startCallSpan(integration, tool, context)
    let session: UpstreamSession | null = null
    let ended: AgentToolResult | null = null
    try {
      session = await this.session(integrationId, currentPersonKey(), false, accountId)
      session.calls.push(call)
      limits.start()
      const result = await session.client.callTool(
        callRequest(tool, input, trace),
        {
          signal: AbortSignal.any([context.abortSignal, timeout.signal]),
          timeout: SDK_TIMEOUT_OFF_MS,
          onprogress: (update) => { limits.progressed(); progress.report(update) },
        },
      )
      if (this.captureApp && !('isError' in result && result.isError)) await this.saveApp(this.captureApp, { integration, tool, input, result, context })
      const mapped = mapCallResult(result)
      // Some servers take a revoked token when the session opens and refuse it only in
      // the call: read the header again, not from a copy, and try once more.
      if (refusedInFirstCall(session, mapped, retried)) {
        this.readHeaderAgain(session)
        return this.callAs(integration, tool, input, context, accountId, true)
      }
      return ended = mapped
    } catch (error) {
      if (error instanceof ConnectionRequiredError) return this.connectionRequired(integration, context)
      if (session?.authorized && isAuthFailure(error)) {
        // The session's header can outlive its token: a new session reads it again, refreshed, before the person is asked.
        if (!retried) {
          this.readHeaderAgain(session)
          return this.callAs(integration, tool, input, context, accountId, true)
        }
        this.signInRefused(session, integration, error)
        return this.connectionRequired(integration, context)
      }
      if (context.abortSignal.aborted) return { ok: false, text: `The ${integration.name} call was stopped.` }
      if (reachedLimit === 'total') return ended = { ok: false, text: `${integration.name} did not finish ${tool} within ${CALL_MAX_TOTAL_MS / 60_000} minutes, so Solus stopped the call.` }
      if (timeout.signal.aborted) return ended = { ok: false, text: `${integration.name} did not answer within ${CALL_TIMEOUT_MS / 1000} seconds.` }
      log.warn('integration_call_failed', { integrationId, tool, error: errorText(error) })
      if (session?.client.getProtocolEra() === 'modern' && isLostResponse(error)) {
        void this.closeSession(sessionKey(integrationId, session.personKey, session.accountId))
        return { ok: false, text: `${integration.name} lost the response for ${tool}. The request may have run, so Solus did not send it again.` }
      }
      // A transport failure drops the session so the next call opens a new one; a server error keeps it.
      if (session && !(error instanceof SdkError)) void this.closeSession(sessionKey(integrationId, session.personKey, session.accountId))
      return { ok: false, text: `${integration.name} could not run ${tool}: ${errorText(error)}` }
    } finally {
      limits.pause()
      progress.end()
      if (trace) endSolusSpan(trace.span, { endedAt: Date.now(), status: callSpanStatus(ended, context) })
      if (session) {
        const index = session.calls.indexOf(call)
        if (index >= 0) session.calls.splice(index, 1)
        if (session.retired) {
          if (!session.calls.length) void session.client.close().catch(() => undefined)
        } else this.touch(sessionKey(integrationId, session.personKey, session.accountId))
      }
    }
  }

  /**
   * The `integration_call` span of a call that a turn made (§13), under the
   * tool call's span. A call outside a turn has none and sends no trace context.
   */
  private startCallSpan(integration: Integration, tool: string, context: AgentToolContext): { span: ReturnType<typeof startSolusSpan>; traceparent: string } | null {
    const sessionId = context.sessionId()
    const turn = sessionId ? this.turnContextOf?.(sessionId, context.parentToolUseId()) : undefined
    if (!turn) return null
    const span = startSolusSpan({
      kind: SPAN_KINDS.integrationCall,
      name: tool,
      service: SPAN_SERVICES.sessions,
      startedAt: Date.now(),
      attrs: { 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': tool, integration: integration.slug },
      dimensions: turn.dimensions,
      parent: turn.context,
      isClientRequest: true,
    })
    return { span, traceparent: w3cTraceparent(span) }
  }

  /**
   * The session's transport. A remote server: streamable HTTP, with the header
   * going to the integration's URL only, so a redirect fails instead of carrying
   * it elsewhere (§4.1 rule 4). A Solus MCP server: an in-memory pair to its
   * server, built for this person, which reads their token on each request
   * (§13.6).
   */
  private transportFor(integration: Integration, personKey: string | null, authorization: string | null, accountId: string): Transport {
    const server = solusServerFor(integration.url)
    if (server) {
      const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
      const credentials = this.credentials
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

  /** Forget an integration's sessions and tool lists, as after an edit or a removal. */
  invalidate(integrationId: string): void {
    this.revisions.delete(integrationId)
    for (const [key, cache] of this.serverFacts) {
      if (cache.integrationId === integrationId) this.serverFacts.delete(key)
    }
    for (const [key, session] of this.sessions) {
      if (session.integrationId === integrationId) void this.closeSession(key)
    }
  }

  /**
   * The current person's connection to an integration, never its token. Read from
   * the connection record when the credentials give one, else from whether a
   * header exists.
   */
  async connectionStatus(integrationId: string): Promise<IntegrationConnectionReport> {
    const integration = this.store.get(integrationId, ANY_ORGANIZATION)
    if (!integration || integration.auth.kind === 'none') return { status: 'connected', label: null, signInRequired: false }
    const personKey = currentPersonKey()
    if (personKey === null) return { status: 'not-connected', label: null, signInRequired: true }
    if (this.credentials?.statusFor) {
      const connection = this.credentials.statusFor(integrationId, personKey)
      if (!connection) return { status: 'not-connected', label: null, signInRequired: true }
      if (connection.status === 'connected') return { status: 'connected', label: connection.label, signInRequired: true }
      return { status: 'needs-sign-in', label: null, signInRequired: true }
    }
    const authorization = await this.credentials?.authorizationFor(integrationId, personKey)
    return { status: authorization ? 'connected' : 'not-connected', label: null, signInRequired: true }
  }

  /** Shows the connect card in the conversation of `sessionId`. */
  askToConnect(integration: Pick<Integration, 'id' | 'name'>, sessionId: string): void {
    const request: IntegrationConnectNeeded = { integrationId: integration.id, integrationName: integration.name, sessionId }
    for (const listener of this.connectNeededListeners) listener(request)
  }

  /** Shows the connect card with an address field in the conversation of `request.sessionId`. */
  askForCustomServer(request: IntegrationCustomServerNeeded): void {
    for (const listener of this.customServerNeededListeners) listener(request)
  }

  /**
   * After a person's sign-in: list their tools now, so the next run and their
   * Settings read them, and tell clients the list may have changed. Never throws.
   */
  async warmFor(integrationId: string, personKey: string): Promise<void> {
    try {
      await this.upstreamTools(integrationId, personKey)
      this.notify(integrationId)
    } catch (error) {
      log.warn('integration_warm_failed', { integrationId, personKey, error: errorText(error) })
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((key) => this.closeSession(key)))
  }

  onToolsChanged(listener: (integrationId: string) => void): void {
    this.listeners.push(listener)
  }

  onFactsChanged(listener: (integrationId: string) => void): void {
    this.factsListeners.push(listener)
  }

  /** A call needs the person to sign in (§4.1 rule 2); the conversation shows the connect card. */
  onConnectNeeded(listener: (request: IntegrationConnectNeeded) => void): void {
    this.connectNeededListeners.push(listener)
  }

  onCustomServerNeeded(listener: (request: IntegrationCustomServerNeeded) => void): void {
    this.customServerNeededListeners.push(listener)
  }

  /**
   * The person's cached list, else a new one. A list cached before an idle close
   * may be old: it is returned at once and listed again in the background.
   * `allowAnonymous`: with no connection, list without a header.
   */
  private async upstreamTools(integrationId: string, personKey: string | null, allowAnonymous = false): Promise<UpstreamTool[]> {
    const key = sessionKey(integrationId, personKey)
    const cached = this.serverFacts.get(key)
    if (cached && !cached.stale && (cached.expiresAt === null || Date.now() < cached.expiresAt)) return cached.tools
    let listed = this.listing.get(key)
    if (!listed) {
      listed = this.list(integrationId, personKey, allowAnonymous).finally(() => this.listing.delete(key))
      this.listing.set(key, listed)
    }
    if (!cached || (cached.expiresAt !== null && Date.now() >= cached.expiresAt)) return listed
    listed.catch((error) => log.warn('integration_relist_failed', { integrationId, error: errorText(error) }))
    return cached.tools
  }

  private async list(integrationId: string, personKey: string | null, allowAnonymous = false, retried = false): Promise<UpstreamTool[]> {
    const session = await this.session(integrationId, personKey, allowAnonymous)
    const key = sessionKey(integrationId, personKey)
    const tools: UpstreamTool[] = []
    let cursor: string | undefined
    let expiresAt: number | null = null
    do {
      let page: Awaited<ReturnType<Client['listTools']>>
      try {
        page = await session.client.listTools(cursor ? { cursor } : undefined)
      } catch (error) {
        if (!session.authorized || !isAuthFailure(error)) throw error
        // As a call does: one new session with the header read again, before the person is asked.
        if (!retried) {
          this.readHeaderAgain(session)
          return this.list(integrationId, personKey, allowAnonymous, true)
        }
        const integration = this.store.get(integrationId, ANY_ORGANIZATION)
        if (integration) this.signInRefused(session, integration, error)
        throw new ConnectionRequiredError()
      }
      const ttl = z.number().safeParse(page.ttlMs)
      if (ttl.success) {
        const pageExpiry = Date.now() + Math.max(0, ttl.data)
        expiresAt = expiresAt === null ? pageExpiry : Math.min(expiresAt, pageExpiry)
      }
      for (const tool of page.tools) {
        tools.push({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations, _meta: tool._meta })
      }
      cursor = page.nextCursor
    } while (cursor)
    const previous = this.serverFacts.get(key)
    const capabilities = session.client.getServerCapabilities()
    const instructions = session.client.getInstructions() ?? null
    this.serverFacts.set(key, {
      integrationId, tools, stale: false, expiresAt,
      era: session.client.getProtocolEra() ?? null, instructions,
      capabilities: {
        prompts: !!capabilities?.prompts,
        resources: !!capabilities?.resources,
        resourceSubscribe: !!capabilities?.resources?.subscribe,
        tasks: !!capabilities?.extensions?.['io.modelcontextprotocol/tasks'],
      },
    })
    if (previous?.instructions !== instructions) {
      log.info('integration_instructions_changed', { integrationId, length: instructions?.length ?? 0 })
      for (const listener of this.factsListeners) listener(integrationId)
    }
    this.touch(key)
    log.info('integration_tools_listed', { integrationId, count: tools.length })
    if (previous && toolNames(previous.tools) !== toolNames(tools)) this.notify(integrationId)
    return tools
  }

  /**
   * A person's session for an integration, opened on first use. Throws
   * `ConnectionRequiredError` when the integration needs sign-in and the person
   * has none, unless `allowAnonymous`.
   */
  private async session(integrationId: string, personKey: string | null, allowAnonymous = false, accountId: string = DEFAULT_INTEGRATION_ACCOUNT): Promise<UpstreamSession> {
    const key = sessionKey(integrationId, personKey, accountId)
    const open = this.sessions.get(key)
    if (open && this.isCurrent(open)) {
      await open.connected
      return open
    }
    let opening = this.opening.get(key)
    if (!opening) {
      opening = this.open(key, integrationId, personKey, allowAnonymous, accountId).finally(() => this.opening.delete(key))
      this.opening.set(key, opening)
    }
    const session = await opening
    // An anonymous list may have opened it while this caller waited.
    if (!allowAnonymous && !this.isCurrent(session)) throw new ConnectionRequiredError()
    return session
  }

  /**
   * The session can be used as it is: it needs no header, or its header was read
   * recently. Any other session asks for the header again (§4.1 rule 5).
   */
  private isCurrent(session: UpstreamSession): boolean {
    if (!session.authorized) return this.store.get(session.integrationId, ANY_ORGANIZATION)?.auth.kind === 'none'
    return Date.now() - session.openedAt < AUTHORIZATION_MAX_AGE_MS
  }

  private async open(key: string, integrationId: string, personKey: string | null, allowAnonymous: boolean, accountId: string): Promise<UpstreamSession> {
    const integration = this.store.get(integrationId, ANY_ORGANIZATION)
    if (!integration) throw new Error('This integration was removed.')
    let authorization: string | null = null
    // The host's own work (null) has no connection: it lists anonymously.
    if (integration.auth.kind !== 'none' && personKey !== null) {
      authorization = (await this.credentials?.authorizationFor(integrationId, personKey, accountId)) ?? null
    }
    this.retire(key)
    if (integration.auth.kind !== 'none' && !authorization && !allowAnonymous) throw new ConnectionRequiredError()
    const client = new Client({ name: 'solus', version: '1.0.0' }, {
      versionNegotiation: { mode: 'auto' },
      capabilities: { elicitation: { form: {}, url: {} }, extensions: { 'io.modelcontextprotocol/ui': {} } },
      listChanged: { tools: { autoRefresh: false, onChanged: () => {
        if (this.sessions.get(key) !== session) return
        this.serverFacts.delete(key)
        this.notify(integrationId)
      } } },
    })
    const session: UpstreamSession = {
      integrationId, personKey, accountId, client, connected: Promise.resolve(), idleTimer: null, calls: [],
      authorized: !!authorization, openedAt: Date.now(), retired: false,
    }
    client.setRequestHandler('elicitation/create', (request) => this.elicit(session, request))
    const prior = this.priorFor(integrationId)
    session.connected = client.connect(this.transportFor(integration, personKey, authorization, accountId), prior ? { prior } : undefined)
    this.sessions.set(key, session)
    try {
      await session.connected
      const discover = client.getDiscoverResult()
      this.revisions.set(integrationId, { prior: discover ? { kind: 'modern', discover } : { kind: 'legacy' }, checkedAt: Date.now() })
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key)
      void client.close().catch(() => undefined)
      log.warn('integration_session_failed', { integrationId, personKey, authorized: !!authorization, error: errorText(error) })
      if (authorization && personKey !== null && isAuthFailure(error)) {
        this.credentials?.markNeedsSignIn(integrationId, personKey, refusedMessage(integration, error))
        throw new ConnectionRequiredError()
      }
      throw new Error(`connection failed (${errorText(error)})`)
    }
    log.info('integration_session_opened', { integrationId, personKey, authorized: session.authorized })
    this.touch(key)
    // The list cached before an idle close may be old: read it again in the background.
    if (this.serverFacts.get(key)?.stale) void this.list(integrationId, personKey, allowAnonymous).catch((error) => log.warn('integration_relist_failed', { integrationId, error: errorText(error) }))
    return session
  }

  /** An old verdict expires so a server upgrade can be found. */
  private priorFor(integrationId: string): PriorDiscovery | undefined {
    const saved = this.revisions.get(integrationId)
    if (!saved) return undefined
    if (saved.prior.kind === 'modern') return saved.prior
    return Date.now() - saved.checkedAt < LEGACY_VERDICT_MAX_AGE_MS ? saved.prior : undefined
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
      return mcpElicitResult(mcpElicitationResponse(params, answers))
    } finally {
      call.resumeTimeout()
    }
  }

  /** The session's header stopped working: the next session reads it again, past any copy the credentials keep. */
  private readHeaderAgain(session: UpstreamSession): void {
    if (session.personKey !== null) this.credentials?.forgetCached?.(session.integrationId, session.personKey, session.accountId)
    this.retire(sessionKey(session.integrationId, session.personKey, session.accountId))
  }

  /** The server refused the person's header: drop the session so the next use asks for a new one. */
  private signInRefused(session: UpstreamSession, integration: Pick<Integration, 'name'>, error: SdkHttpError): void {
    void this.closeSession(sessionKey(session.integrationId, session.personKey, session.accountId))
    if (session.personKey !== null) this.credentials?.markNeedsSignIn(session.integrationId, session.personKey, refusedMessage(integration, error), session.accountId)
  }

  /** A capture that fails is logged; it never fails the tool call that already succeeded. */
  private async saveApp(capture: (call: IntegrationAppCapture) => Promise<void>, call: Omit<IntegrationAppCapture, 'tool'> & { tool: string }): Promise<void> {
    try {
      const tool = (await this.toolsFor(call.integration.id, currentPersonKey())).find((entry) => entry.name === call.tool)
      if (tool) await capture({ ...call, tool })
    } catch (error) {
      log.warn('integration_app_capture_failed', { integrationId: call.integration.id, tool: call.tool, error: errorText(error) })
    }
  }

  private connectionRequired(integration: Pick<Integration, 'id' | 'name'>, context: AgentToolContext): AgentToolResult {
    const sessionId = context.sessionId()
    if (sessionId) this.askToConnect(integration, sessionId)
    return { ok: false, text: `CONNECTION_REQUIRED: Sign in to ${integration.name} in Settings → MCP, then try again.` }
  }

  /** Takes the open session out of use. Calls in flight finish on it; it closes after the last one. */
  private retire(key: string): void {
    const session = this.sessions.get(key)
    if (!session) return
    if (!session.calls.length) {
      void this.closeSession(key)
      return
    }
    this.sessions.delete(key)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.retired = true
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
    const cache = this.serverFacts.get(key)
    if (cache) cache.stale = true
    await session.client.close().catch((error) => log.warn('integration_session_close_failed', { integrationId: session.integrationId, error: errorText(error) }))
    log.info('integration_session_closed', { integrationId: session.integrationId })
  }

  private notify(integrationId: string): void {
    for (const listener of this.listeners) listener(integrationId)
  }
}

/** A `tools/call` request. A call of a turn carries only `traceparent` (§13); never `tracestate` or `baggage`. */
function callRequest(tool: string, input: ToolArguments, trace: { traceparent: string } | null): CallToolRequest['params'] {
  const request: CallToolRequest['params'] = { name: tool, arguments: input }
  if (trace) request._meta = { traceparent: trace.traceparent }
  return request
}

/** How an `integration_call` span ends: the result's outcome, a stop, or a failure with no result. */
function callSpanStatus(ended: AgentToolResult | null, context: AgentToolContext): SpanStatus {
  if (ended) return ended.ok ? 'ok' : 'error'
  return context.abortSignal.aborted ? 'interrupted' : 'error'
}

/** What a person calls an account: the identity its server reported, else its id. */
function accountLabel(connection: Pick<IntegrationConnection, 'label' | 'accountId'>): string {
  return connection.label ?? connection.accountId
}

/** The account Solus's input names, and the arguments the server takes. */
interface AccountCall {
  /** The account label or id the call named, or null. */
  account: string | null
  args: ToolArguments
}

function splitAccount(input: ToolArguments): AccountCall {
  if (!input || !Object.hasOwn(input, ACCOUNT_INPUT)) return { account: null, args: input }
  const { [ACCOUNT_INPUT]: account, ...args } = input
  const named = z.string().min(1).safeParse(account)
  return { account: named.success ? named.data : null, args }
}

/** One session per integration, person, and account (§13.3); the first account keeps the key it always had. */
function sessionKey(integrationId: string, personKey: string | null, accountId: string = DEFAULT_INTEGRATION_ACCOUNT): string {
  const base = `${integrationId}\u0000${personKey ?? ''}`
  return accountId === DEFAULT_INTEGRATION_ACCOUNT ? base : `${base}\u0000${accountId}`
}

/** A tool's error text that reports an HTTP 401, as "(status: 401)", "HTTP 401", or "401 Unauthorized". */
const REFUSED_IN_RESULT = /\b(?:status|HTTP)\W{0,3}401\b|\b401\s+Unauthorized\b/i

/** The first try's own answer reports HTTP 401 for a session that sent a header. */
function refusedInFirstCall(session: UpstreamSession, result: AgentToolResult, retried: boolean): boolean {
  return !retried && session.authorized && !result.ok && REFUSED_IN_RESULT.test(result.text)
}

/** An in-flight modern request has no SSE resume path after transport loss. */
function isLostResponse(cause: unknown): boolean {
  return !(cause instanceof SdkError) || cause.code === SdkErrorCode.ConnectionClosed || cause.code === SdkErrorCode.SendFailed
}

/** The server answered 401 or 403: it refused the header. */
function isAuthFailure(cause: unknown): cause is SdkHttpError {
  return cause instanceof SdkHttpError && (cause.status === 401 || cause.status === 403)
}

function refusedMessage(integration: Pick<Integration, 'name'>, error: SdkHttpError): string {
  return `${integration.name} refused the saved sign-in (HTTP ${error.status}). Sign in again.`
}

function toolNames(tools: UpstreamTool[]): string {
  return tools.map((tool) => tool.name).join('\u0000')
}

/** An error as one short line. A URL in it keeps no query string. */
function errorText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause)
  return text.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1').slice(0, 300)
}
