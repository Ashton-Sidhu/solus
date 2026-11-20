import { z } from 'zod'
import type { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { ProtocolError, SdkError, SdkErrorCode, type SdkHttpError, type ReadResourceResult, type PriorDiscovery } from '@modelcontextprotocol/client'
import { ACCOUNT_INPUT, DEFAULT_INTEGRATION_ACCOUNT, type Integration, type IntegrationConnection, type IntegrationConnectNeeded, type IntegrationCustomServerNeeded, type IntegrationEnvValue, type IntegrationFacts, type IntegrationProcessFacts, type IntegrationToolSummary } from '@solus/contracts/integration-types'
import { ANY_ORGANIZATION } from '../admission/principal'
import { createLogger } from '../logger'
import { currentPersonKey } from '../vault/acting-scope'
import type { AgentToolContext, AgentToolResult } from '../execution/agents/tools/agent-tool'
import type { IntegrationCredentials } from './connections'
import type { IntegrationStore } from './integration-store'
import { toolSummary } from './integration-tools'
import { agentResultOf, mergedAccountResults, outputSchemaRefusal } from './result-content'
import type { ServerFactsKey, ServerFactsStore } from './server-facts-store'
import { commandStartRefusal, type CommandStarter } from './command-admission'
import { STDIO_START_TIMEOUT_MS, StderrTail, StdioProcessStates, SYSTEM_CLOCK, type GatewayClock } from './stdio-process'
import { CALL_MAX_TOTAL_MS, CALL_TIMEOUT_MS, CallLimits, ProgressEvents, SYSTEM_CALL_CLOCK, type CallClock, type CallLimit } from './call-progress'
import { endSolusSpan } from '../execution/observability/tracer'
import { accountLabel, callRequest, callSpanStatus, elicitFromCall, splitAccount, startCallSpan, type TurnContextOf } from './integration-call'
import { cancelTask, MCP_TASKS_EXTENSION, taskHandleOf, TaskAwareClient, type McpTaskHandle } from './mcp-task-requests'
import {
  ConnectionRequiredError,
  errorText,
  isAuthFailure,
  isLostResponse,
  refusedInFirstCall,
  refusedMessage,
  sessionKey,
  stoppedWhileRunning,
  toolNames,
  upstreamTransport,
  type ActiveCall,
  type AppToolResult,
  type IntegrationAppCapture,
  type ServerFacts,
  type ToolArguments,
  type UpstreamSession,
  type UpstreamTool,
} from './upstream-session'

export type { IntegrationAppCapture, ToolArguments, UpstreamTool } from './upstream-session'

const log = createLogger('integrations', 'gateway.ts')

const IDLE_CLOSE_MS = 10 * 60 * 1000
/** The SDK's own request timeout is 60 s; the gateway's limits bound a call instead, so they can pause while a person answers. */
const SDK_TIMEOUT_OFF_MS = 24 * 60 * 60 * 1000
/** A session's `Authorization` header is a snapshot: ask for it again after this, before a token expires (§4.1 rule 5). */
const AUTHORIZATION_MAX_AGE_MS = 50 * 60 * 1000
/** Re-probe old servers daily so an upgraded server can move to the modern revision. */
const LEGACY_VERDICT_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** A saved `stdio` verdict is checked again after this (docs/plans/mcp-first-class.md §7.5). */
const STDIO_VERDICT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Live `stdio` sessions on one host (§7.3). */
const STDIO_SESSION_LIMIT = 16

/** What `connection_status` reports about one person's connection to an integration. */
/** What the MCP task owner (`mcp-tasks.ts`) does for the gateway (docs/plans/mcp-first-class.md §12). */
export interface McpTaskCalls {
  /** A tool call that the server answered with a task handle: hold it, then give it to the background (§12.1). */
  hold(call: HeldMcpTask): Promise<AgentToolResult>
  /** An upstream session with a live MCP task is not closed when idle (§12.3). */
  holdsUpstream(integrationId: string, personKey: string | null, accountId: string): boolean
  /** A `stdio` process ended: its MCP tasks fail (§12.3). */
  processEnded(integrationId: string, personKey: string | null): void
}

export interface HeldMcpTask {
  integration: Integration
  tool: string
  accountId: string
  personKey: string | null
  handle: McpTaskHandle
  context: AgentToolContext
  traceparent: string | null
}

/** A status request found no running process of a `stdio` integration: its MCP tasks are gone with it. */
export class ServerStoppedError extends Error {}

export interface IntegrationConnectionReport {
  status: 'connected' | 'needs-sign-in' | 'not-connected'
  /** The account label, when connected and known. */
  label: string | null
  /** False when the integration needs no sign-in. */
  signInRequired: boolean
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
  private readonly processes: StdioProcessStates
  /** `stdio` sessions that are starting, so the limit counts them. */
  private stdioStarting = 0
  private turnContextOf: TurnContextOf | null = null
  private mcpTasks: McpTaskCalls | null = null

  /**
   * The integration records; the tool bridge lists a scope's integrations
   * through it. `savedFacts` keeps the verdict and the facts of `stdio`
   * integrations (§7.5); without it a command is checked at each start.
   */
  constructor(
    readonly store: Pick<IntegrationStore, 'get' | 'list'>,
    private readonly callClock: CallClock = SYSTEM_CALL_CLOCK,
    private readonly options: { clock?: GatewayClock; savedFacts?: ServerFactsStore } = {},
  ) {
    this.processes = new StdioProcessStates(() => this.clock.now())
  }

  private get clock(): GatewayClock {
    return this.options.clock ?? SYSTEM_CLOCK
  }

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

  /** Installed once at boot: the owner of MCP tasks (§12). Without it a task handle is cancelled and refused. */
  useMcpTasks(mcpTasks: McpTaskCalls): void {
    this.mcpTasks = mcpTasks
  }

  /**
   * Runs one MCP task request (`tasks/get`, `tasks/update`, `tasks/cancel`) as
   * the task's person and account (§12.3), on their session, opened if none is.
   * A `stdio` integration is not started for it: with no running process this
   * throws `ServerStoppedError`. A refused header is read again once, then the
   * connection needs sign-in and this throws `ConnectionRequiredError`.
   */
  async withTaskSession<T>(integrationId: string, personKey: string, accountId: string, use: (client: Client) => Promise<T>, retried = false): Promise<T> {
    const key = sessionKey(integrationId, personKey, accountId)
    const integration = this.store.get(integrationId, ANY_ORGANIZATION)
    if (!integration) throw new ServerStoppedError('The MCP server was removed.')
    if (integration.kind === 'stdio' && !this.sessions.get(key)?.stdio) throw new ServerStoppedError('The server stopped.')
    const session = await this.session(integrationId, personKey, false, accountId)
    try {
      return await use(session.client)
    } catch (error) {
      if (!session.authorized || !isAuthFailure(error)) throw error
      if (!retried) {
        this.readHeaderAgain(session)
        return this.withTaskSession(integrationId, personKey, accountId, use, true)
      }
      this.signInRefused(session, integration, error)
      throw new ConnectionRequiredError()
    } finally {
      this.touch(key)
    }
  }

  /**
   * Reads one resource with the current person's connection. It never starts an
   * agent turn. `starter` is who the read acts for: a command starts only for
   * them (`commandStartRefusal`).
   */
  async readAppResource(integrationId: string, uri: string, starter: CommandStarter, options: { signal?: AbortSignal; timeout?: number } = {}): Promise<ReadResourceResult> {
    return this.withAppSession(integrationId, starter, (client) => client.readResource({ uri }, { timeout: options.timeout ?? CALL_TIMEOUT_MS, signal: options.signal }))
  }

  /** Calls one tool for an MCP App, or an app of Solus, with the current person's connection. It never starts an agent turn. */
  async callAppTool(integrationId: string, name: string, input: ToolArguments, starter: CommandStarter): Promise<AppToolResult> {
    return this.withAppSession(integrationId, starter, async (client) => {
      try {
        return await client.callTool({ name, arguments: input }, { timeout: CALL_TIMEOUT_MS })
      } catch (error) {
        // An app waits for its answer in the frame; it cannot wait for an MCP task (§12). The work is not left running.
        const handle = taskHandleOf(error)
        if (!handle) throw error
        void cancelTask(client, handle.taskId, { traceparent: null, timeout: CALL_TIMEOUT_MS }).catch(() => undefined)
        throw new Error(`${name} runs as an MCP task, and an MCP App cannot wait for one. Ask the agent to run ${name}.`)
      }
    })
  }

  private async withAppSession<T>(integrationId: string, starter: CommandStarter, use: (client: Client) => Promise<T>): Promise<T> {
    const session = await this.session(integrationId, currentPersonKey(), false, DEFAULT_INTEGRATION_ACCOUNT, starter)
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
    const answer: IntegrationFacts = facts
      ? { era: facts.era, instructions: facts.instructions, capabilities: facts.capabilities }
      : { era: null, instructions: null, capabilities: { prompts: false, resources: false, resourceSubscribe: false, tasks: false } }
    if (this.store.get(integrationId, ANY_ORGANIZATION)?.kind === 'stdio') answer.process = this.processFacts(integrationId, personKey)
    return answer
  }

  /** `running` while one of the person's sessions has a live child, else what the last end left. No PID. */
  private processFacts(integrationId: string, personKey: string | null): IntegrationProcessFacts {
    for (const session of this.sessions.values()) {
      if (session.integrationId === integrationId && session.personKey === personKey && session.stdio && !session.stdio.ended) return { state: 'running' }
    }
    return this.processes.facts(sessionKey(integrationId, personKey))
  }

  /**
   * Start and test, Start again, and Test again (§7.7): starts the caller's
   * process of a `stdio` integration and lists its tools. It clears `failed`.
   * `recheck` drops the saved verdict and stops a running process first, so the
   * revision is checked again. Throws a plain message.
   */
  async startProcess(integrationId: string, starter: CommandStarter, recheck = false): Promise<IntegrationFacts> {
    const personKey = currentPersonKey()
    if (personKey === null) throw new Error('A command runs for a person, and this connection acts for none.')
    const key = sessionKey(integrationId, personKey)
    this.processes.clear(key)
    if (recheck) {
      this.options.savedFacts?.dropVerdicts(integrationId)
      await this.stopProcess(integrationId)
      this.processes.clear(key)
    }
    try {
      await this.session(integrationId, personKey, false, DEFAULT_INTEGRATION_ACCOUNT, starter)
      await this.list(integrationId, personKey)
    } catch (error) {
      const integration = this.store.get(integrationId, ANY_ORGANIZATION)
      if (error instanceof ConnectionRequiredError) throw new Error(`Give the environment values of ${integration?.name ?? 'this server'} first.`)
      throw error
    }
    return this.factsFor(integrationId, personKey)
  }

  /** Stop (§7.7): closes the caller's sessions of an integration, which stops their processes. The next use starts one again. */
  async stopProcess(integrationId: string): Promise<boolean> {
    const personKey = currentPersonKey()
    const keys = [...this.sessions].filter(([, session]) => session.integrationId === integrationId && session.personKey === personKey).map(([key]) => key)
    await Promise.all(keys.map((key) => this.closeSession(key)))
    return keys.length > 0
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
  async call(integrationId: string, tool: string, input: ToolArguments, context: AgentToolContext, starter: CommandStarter): Promise<AgentToolResult> {
    const integration = this.store.get(integrationId, ANY_ORGANIZATION)
    if (!integration) return { ok: false, text: 'This integration was removed.' }
    // A run that started before the tool was turned off still lists it.
    if (integration.disabledTools.includes(tool)) return { ok: false, text: `The ${tool} tool of ${integration.name} is turned off in Settings → MCP.` }
    const personKey = currentPersonKey()
    const accounts = personKey === null ? [] : this.connectedAccounts(integrationId, personKey)
    // With one account the tool has no account input, so every argument is the server's.
    if (accounts.length <= 1) return this.callAs(integration, tool, input, context, accounts[0]?.accountId ?? DEFAULT_INTEGRATION_ACCOUNT, starter)
    const { account, args } = splitAccount(input)
    const labels = accounts.map(accountLabel)
    if (account) {
      const chosen = accounts.find((candidate) => accountLabel(candidate) === account || candidate.accountId === account)
      if (!chosen) return { ok: false, text: `${integration.name} has no account named ${account}. Its accounts: ${labels.join(', ')}.` }
      return this.callAs(integration, tool, args, context, chosen.accountId, starter)
    }
    const upstream = (await this.toolsFor(integrationId, personKey)).find((candidate) => candidate.name === tool)
    if (!upstream?.annotations?.readOnlyHint) {
      return { ok: false, text: `${integration.name} has several accounts: ${labels.join(', ')}. Call ${tool} again with \`${ACCOUNT_INPUT}\` set to one of them.` }
    }
    // A read spans every account; each part names the account it came from.
    const results = await Promise.all(accounts.map((candidate) => this.callAs(integration, tool, args, context, candidate.accountId, starter)))
    return mergedAccountResults(results.map((result, index) => ({ label: labels[index], result })))
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

  private async callAs(integration: Integration, tool: string, input: ToolArguments, context: AgentToolContext, accountId: string, starter: CommandStarter, retried = false): Promise<AgentToolResult> {
    const integrationId = integration.id
    // §5: silence stops a call after 60 s, and progress starts that again; 30 minutes stop it in all.
    const timeout = new AbortController()
    let reachedLimit: CallLimit | null = null
    const limits = new CallLimits(this.callClock, (limit) => { reachedLimit = limit; timeout.abort(new Error('timeout')) })
    const progress = new ProgressEvents(this.callClock, context)
    const call: ActiveCall = { integrationName: integration.name, context, pauseTimeout: () => limits.pause(), resumeTimeout: () => limits.start() }
    const trace = startCallSpan(this.turnContextOf, integration, tool, context)
    let session: UpstreamSession | null = null
    let ended: AgentToolResult | null = null
    try {
      session = await this.session(integrationId, currentPersonKey(), false, accountId, starter)
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
      const mapped = await agentResultOf(result, { tool, outputSchema: this.anyCachedTools(integrationId)?.find((candidate) => candidate.name === tool)?.outputSchema })
      // Some servers take a revoked token when the session opens and refuse it only in
      // the call: read the header again, not from a copy, and try once more.
      if (refusedInFirstCall(session, mapped, retried)) {
        this.readHeaderAgain(session)
        return this.callAs(integration, tool, input, context, accountId, starter, true)
      }
      return ended = mapped
    } catch (error) {
      if (error instanceof ConnectionRequiredError) return this.connectionRequired(integration, context)
      const handle = taskHandleOf(error)
      if (handle && session) {
        // The call has its answer; the limits of §5 end here, and the MCP task's own limits start (§12).
        limits.pause()
        return ended = await this.heldTask(session, { integration, tool, accountId, personKey: session.personKey, handle, context, traceparent: trace?.traceparent ?? null })
      }
      if (stoppedWhileRunning(session)) return { ok: false, text: `${integration.name} stopped while it ran ${tool}.` }
      if (session?.authorized && isAuthFailure(error)) {
        // The session's header can outlive its token: a new session reads it again, refreshed, before the person is asked.
        if (!retried) {
          this.readHeaderAgain(session)
          return this.callAs(integration, tool, input, context, accountId, starter, true)
        }
        this.signInRefused(session, integration, error)
        return this.connectionRequired(integration, context)
      }
      if (context.abortSignal.aborted) return { ok: false, text: `The ${integration.name} call was stopped.` }
      if (reachedLimit === 'total') return ended = { ok: false, text: `${integration.name} did not finish ${tool} within ${CALL_MAX_TOTAL_MS / 60_000} minutes, so Solus stopped the call.` }
      if (timeout.signal.aborted) return ended = { ok: false, text: `${integration.name} did not answer within ${CALL_TIMEOUT_MS / 1000} seconds.` }
      const refusal = error instanceof ProtocolError ? outputSchemaRefusal(tool, error) : null
      if (refusal) return ended = refusal
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

  /** Without an owner of MCP tasks, the work is not left running on the server. */
  private async heldTask(session: UpstreamSession, call: HeldMcpTask): Promise<AgentToolResult> {
    if (this.mcpTasks) return this.mcpTasks.hold(call)
    void cancelTask(session.client, call.handle.taskId, { traceparent: call.traceparent, timeout: CALL_TIMEOUT_MS }).catch(() => undefined)
    return { ok: false, text: `${call.integration.name} runs ${call.tool} as an MCP task, and this host cannot follow one.` }
  }

  /**
   * A new command or new names, or a removal (§7.5): the sessions, the lists,
   * and the saved verdict and facts of every person go.
   */
  forget(integrationId: string): void {
    this.options.savedFacts?.removeAllFor(integrationId)
    this.invalidate(integrationId)
  }

  /** Forget an integration's sessions and tool lists, as after an edit or a removal. A change of the record also ends `failed` (§7.3). */
  invalidate(integrationId: string): void {
    this.processes.clearIntegration(`${integrationId}\u0000`)
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
    // A command that is not running is read from its saved facts: a run or a Settings read starts nothing (§7.5).
    if (!this.sessions.has(key) && this.store.get(integrationId, ANY_ORGANIZATION)?.kind === 'stdio') return this.savedFacts(integrationId, personKey)?.tools ?? []
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
    this.saveListed(session, key)
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
   * has none, unless `allowAnonymous`. A command starts only for `starter`
   * (`commandStartRefusal`); a read names none, so it starts nothing.
   */
  private async session(integrationId: string, personKey: string | null, allowAnonymous = false, accountId: string = DEFAULT_INTEGRATION_ACCOUNT, starter: CommandStarter = null): Promise<UpstreamSession> {
    const key = sessionKey(integrationId, personKey, accountId)
    const open = this.sessions.get(key)
    if (open && this.isCurrent(open)) {
      await open.connected
      return open
    }
    let opening = this.opening.get(key)
    if (!opening) {
      opening = this.open(key, integrationId, personKey, allowAnonymous, accountId, starter).finally(() => this.opening.delete(key))
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
    if (!session.authorized) {
      // A command's values are read once, at its start; a new connection closes the session.
      const integration = this.store.get(session.integrationId, ANY_ORGANIZATION)
      return integration?.kind === 'stdio' || integration?.auth.kind === 'none'
    }
    return Date.now() - session.openedAt < AUTHORIZATION_MAX_AGE_MS
  }

  private async open(key: string, integrationId: string, personKey: string | null, allowAnonymous: boolean, accountId: string, starter: CommandStarter): Promise<UpstreamSession> {
    const integration = this.store.get(integrationId, ANY_ORGANIZATION)
    if (!integration) throw new Error('This integration was removed.')
    if (integration.kind === 'stdio') return this.openStdio(key, integration, personKey, accountId, starter)
    let authorization: string | null = null
    // The host's own work (null) has no connection: it lists anonymously.
    if (integration.auth.kind !== 'none' && personKey !== null) {
      authorization = (await this.credentials?.authorizationFor(integrationId, personKey, accountId)) ?? null
    }
    this.retire(key)
    if (integration.auth.kind !== 'none' && !authorization && !allowAnonymous) throw new ConnectionRequiredError()
    const session = this.newSession(key, integrationId, personKey, accountId, !!authorization)
    const client = session.client
    const prior = this.priorFor(integrationId)
    session.connected = client.connect(upstreamTransport(integration, personKey, authorization, accountId, [], this.credentials), prior ? { prior } : undefined)
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

  /** A session and its client, not yet connected. */
  private newSession(key: string, integrationId: string, personKey: string | null, accountId: string, authorized: boolean): UpstreamSession {
    // The tasks extension goes on each request (§12): a server may answer any tool call with an MCP task.
    const client = new TaskAwareClient({ name: 'solus', version: '1.0.0' }, {
      versionNegotiation: { mode: 'auto' },
      capabilities: { elicitation: { form: {}, url: {} }, extensions: { 'io.modelcontextprotocol/ui': {}, [MCP_TASKS_EXTENSION]: {} } },
      listChanged: { tools: { autoRefresh: false, onChanged: () => {
        if (this.sessions.get(key) !== session) return
        this.serverFacts.delete(key)
        this.notify(integrationId)
      } } },
    })
    const session: UpstreamSession = {
      integrationId, personKey, accountId, client, connected: Promise.resolve(), idleTimer: null, calls: [],
      authorized, openedAt: Date.now(), retired: false, closing: false, lastUsedAt: this.clock.now(), stdio: null,
    }
    client.setRequestHandler('elicitation/create', (request) => elicitFromCall(session.calls.at(-1), request))
    return session
  }

  /**
   * Starts a command (§7.3), with its saved verdict when there is one, so it
   * starts once (§7.5). Every start passes here, so `commandStartRefusal` is
   * checked once for every path. A verdict the SDK refuses is dropped and the
   * revision is checked once more.
   */
  private async openStdio(key: string, integration: Integration, personKey: string | null, accountId: string, starter: CommandStarter): Promise<UpstreamSession> {
    const notAllowed = commandStartRefusal(integration, personKey, starter)
    if (notAllowed) throw new Error(notAllowed)
    // The rule refuses the host's own work already; this test only tells the type.
    if (personKey === null) throw new Error(`${integration.name} is a command, and the host's own work starts no command.`)
    const refusal = this.processes.refusal(sessionKey(integration.id, personKey))
    if (refusal) throw new Error(refusal)
    const environment = integration.auth.kind === 'env' ? this.credentials?.environmentFor?.(integration.id, personKey, accountId) ?? null : []
    if (!environment) throw new ConnectionRequiredError()
    this.retire(key)
    this.stdioStarting++
    try {
      await this.makeRoomForStdio()
      return await this.connectStdio(key, integration, personKey, accountId, environment, false)
    } finally {
      this.stdioStarting--
    }
  }

  private async connectStdio(key: string, integration: Integration, personKey: string, accountId: string, environment: IntegrationEnvValue[], retried: boolean): Promise<UpstreamSession> {
    const processKey = sessionKey(integration.id, personKey)
    const factsKey: ServerFactsKey = { integrationId: integration.id, personKey, accountId }
    const prior = retried ? undefined : this.savedPrior(factsKey)
    // The saved list is the one a new list is compared with.
    this.savedFacts(integration.id, personKey)
    const session = this.newSession(key, integration.id, personKey, accountId, false)
    const transport = upstreamTransport(integration, personKey, null, accountId, environment, this.credentials)
    const stdio = transport instanceof StdioClientTransport ? transport : null
    const stderr = new StderrTail(stdio?.stderr ?? null)
    const startedAt = this.clock.now()
    session.connected = session.client.connect(transport, prior ? { prior, timeout: STDIO_START_TIMEOUT_MS } : { timeout: STDIO_START_TIMEOUT_MS })
    this.sessions.set(key, session)
    try {
      await session.connected
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key)
      void session.client.close().catch(() => undefined)
      if (prior && error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed) {
        this.options.savedFacts?.dropVerdict(factsKey)
        return this.connectStdio(key, integration, personKey, accountId, environment, true)
      }
      const failure = this.processes.startFailed(processKey, integration, startedAt, stderr, error)
      this.factsChanged(integration.id)
      throw failure
    }
    session.stdio = { pid: stdio?.pid ?? null, stderr, startedAt, ended: false }
    session.client.onclose = () => this.stdioEnded(key, session, integration.name)
    if (!prior) {
      const discover = session.client.getDiscoverResult()
      this.options.savedFacts?.saveVerdict(factsKey, discover ? { kind: 'modern', discover } : { kind: 'legacy' }, this.clock.now())
    }
    this.processes.started(processKey)
    log.info('integration_process_started', { integrationId: integration.id, personKey, pid: session.stdio.pid })
    this.touch(key)
    this.factsChanged(integration.id)
    if (this.serverFacts.get(key)?.stale) void this.list(integration.id, personKey).catch((error) => log.warn('integration_relist_failed', { integrationId: integration.id, error: errorText(error) }))
    return session
  }

  /** The process ended and the gateway did not close it (§7.3): the session goes, calls in flight fail, and the next use starts it again. */
  private stdioEnded(key: string, session: UpstreamSession, integrationName: string): void {
    const child = session.stdio
    if (!child || child.ended || session.closing) return
    child.ended = true
    // A retired session is closed by the gateway after its last call.
    if (session.retired) {
      log.info('integration_process_stopped', { integrationId: session.integrationId, personKey: session.personKey, pid: child.pid, byItself: false, stderrBytes: child.stderr.bytes })
      return
    }
    if (this.sessions.get(key) === session) {
      this.sessions.delete(key)
      if (session.idleTimer) this.clock.clearTimeout(session.idleTimer)
      const cache = this.serverFacts.get(key)
      if (cache) cache.stale = true
    }
    this.mcpTasks?.processEnded(session.integrationId, session.personKey)
    const state = this.processes.ended(sessionKey(session.integrationId, session.personKey), child.startedAt, `${integrationName} stopped by itself.`, child.stderr.tail)
    log.warn('integration_process_stopped', { integrationId: session.integrationId, personKey: session.personKey, pid: child.pid, byItself: true, state, stderrBytes: child.stderr.bytes })
    this.factsChanged(session.integrationId)
  }

  /** At most 16 live commands (§7.3): a new one closes the idle one used least recently, or fails. */
  private async makeRoomForStdio(): Promise<void> {
    const live = [...this.sessions].filter(([, session]) => session.stdio && !session.stdio.ended)
    if (live.length + this.stdioStarting <= STDIO_SESSION_LIMIT) return
    const idle = live.filter(([, session]) => !session.calls.length && !this.holdsUpstream(session)).sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)[0]
    if (!idle) throw new Error('Too many MCP servers are running on this host.')
    log.info('integration_process_evicted', { integrationId: idle[1].integrationId })
    await this.closeSession(idle[0])
  }

  /** The saved verdict of one person and account, unless it is older than 7 days. */
  private savedPrior(key: ServerFactsKey): PriorDiscovery | undefined {
    const verdict = this.options.savedFacts?.get(key)?.verdict
    if (!verdict || this.clock.now() - verdict.checkedAt > STDIO_VERDICT_MAX_AGE_MS) return undefined
    return verdict.prior
  }

  /** A command's facts in memory, else as saved; the saved ones wait for the next start to be listed again. */
  private savedFacts(integrationId: string, personKey: string | null): ServerFacts | null {
    const key = sessionKey(integrationId, personKey)
    const cached = this.serverFacts.get(key)
    if (cached) return cached
    if (personKey === null) return null
    const saved = this.options.savedFacts?.get({ integrationId, personKey, accountId: DEFAULT_INTEGRATION_ACCOUNT })?.facts
    if (!saved) return null
    const facts: ServerFacts = { integrationId, ...saved, stale: true, expiresAt: null }
    this.serverFacts.set(key, facts)
    return facts
  }

  /** A command's new list is saved, so the next run reads it without a start (§7.5). */
  private saveListed(session: UpstreamSession, key: string): void {
    const facts = this.serverFacts.get(key)
    if (!session.stdio || session.personKey === null || !facts) return
    const { tools, era, instructions, capabilities } = facts
    this.options.savedFacts?.saveFacts({ integrationId: session.integrationId, personKey: session.personKey, accountId: session.accountId }, { tools, era, instructions, capabilities }, this.clock.now())
  }

  private factsChanged(integrationId: string): void {
    for (const listener of this.factsListeners) listener(integrationId)
  }

  /** An old verdict expires so a server upgrade can be found. */
  private priorFor(integrationId: string): PriorDiscovery | undefined {
    const saved = this.revisions.get(integrationId)
    if (!saved) return undefined
    if (saved.prior.kind === 'modern') return saved.prior
    return Date.now() - saved.checkedAt < LEGACY_VERDICT_MAX_AGE_MS ? saved.prior : undefined
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

  private connectionRequired(integration: Pick<Integration, 'id' | 'name' | 'auth'>, context: AgentToolContext): AgentToolResult {
    const sessionId = context.sessionId()
    if (sessionId) this.askToConnect(integration, sessionId)
    if (integration.auth.kind === 'env') return { ok: false, text: `CONNECTION_REQUIRED: Give the environment values of ${integration.name} in Settings → MCP, then try again.` }
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
    if (session.idleTimer) this.clock.clearTimeout(session.idleTimer)
    session.retired = true
  }

  private touch(key: string): void {
    const session = this.sessions.get(key)
    if (!session) return
    session.lastUsedAt = this.clock.now()
    if (session.idleTimer) this.clock.clearTimeout(session.idleTimer)
    session.idleTimer = this.clock.setTimeout(() => {
      if (session.calls.length || this.holdsUpstream(session)) return this.touch(key)
      void this.closeSession(key)
    }, IDLE_CLOSE_MS)
    session.idleTimer.unref?.()
  }

  private holdsUpstream(session: UpstreamSession): boolean {
    return !!this.mcpTasks?.holdsUpstream(session.integrationId, session.personKey, session.accountId)
  }

  private async closeSession(key: string): Promise<void> {
    const session = this.sessions.get(key)
    if (!session) return
    this.sessions.delete(key)
    if (session.idleTimer) this.clock.clearTimeout(session.idleTimer)
    const cache = this.serverFacts.get(key)
    if (cache) cache.stale = true
    // The SDK closes standard input, then sends SIGTERM and SIGKILL to the one child it started (§7.3).
    session.closing = true
    await session.client.close().catch((error) => log.warn('integration_session_close_failed', { integrationId: session.integrationId, error: errorText(error) }))
    log.info('integration_session_closed', { integrationId: session.integrationId })
    if (session.stdio && !session.stdio.ended) {
      session.stdio.ended = true
      log.info('integration_process_stopped', { integrationId: session.integrationId, personKey: session.personKey, pid: session.stdio.pid, byItself: false, stderrBytes: session.stdio.stderr.bytes })
      this.processes.stopped(sessionKey(session.integrationId, session.personKey))
      this.mcpTasks?.processEnded(session.integrationId, session.personKey)
      this.factsChanged(session.integrationId)
    }
  }

  private notify(integrationId: string): void {
    for (const listener of this.listeners) listener(integrationId)
  }
}
