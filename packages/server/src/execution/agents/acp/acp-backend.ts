import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { readFile, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { ProviderHistoryPage, SessionLoadMessage } from '@solus/contracts/session-history'
import type { AgentId, AgentMetadata, AgentSlashCommand, IpcContext, NormalizedEvent, PermissionMode, PermissionOption, PlanDescriptor, PluginCommandsResult, PromptOptions, UsageData } from '@solus/contracts/types'
import type { TurnSeat } from '../../seats/seat-manager'
import { providerModelsFor } from '@solus/contracts/types'
import { createLogger } from '../../../logger'
import { resolveHomePath } from '../../../platform/paths'
import { indexSessionMessages } from '../../../db/session-indexer'
import { BaseAgentBackend } from '../base-backend'
import { bindRunTools, type RunToolAccess } from '../tools/agent-tool-endpoint'
import type { AgentBackend, PermissionResponder, RunHandle } from '../agent-backend'
import type { AgentRunRequest, AgentRunSessionState } from '../agent-runner'
import { KeptHistory, TurnHistory } from '../kept-history'
import { importThreadFiles, type ThreadImportRequest, type ThreadImportResult } from '../thread-import'
import type { ThreadFile } from '../../../sync/sessions/session-archive-writer'
import { AcpConnection, AcpConnectionClosedError, methodNotFound } from './acp-connection'
import { acpPermissionAnswer, acpPermissionOption } from './acp-permissions'
import {
  ACP_PROTOCOL_VERSION,
  initializeResultSchema,
  promptResultSchema,
  elicitationRequestSchema,
  readTextFileSchema,
  requestPermissionSchema,
  sessionNotificationSchema,
  configOptionSchema,
  sessionSetupResultSchema,
  sessionUpdateSchema,
  type AcpConfigOption,
  type AcpSessionSetupResult,
  type AcpInitializeResult,
  type AcpPermissionRequest,
  type AcpPromptUsage,
  type AcpStopReason,
} from './acp-protocol'
import { AcpTurnNormalizer } from './acp-turn-normalizer'
import { AcpAgentReport, modelsOffered } from './acp-agent-report'
import { AcpAgentWork } from './acp-agent-work'
import type { AcpAgent, AcpAgentLaunch } from './acp-agent'
import { AcpThreadPlaces } from './acp-thread-places'
import { buildHandoff, composeHandoffSeed } from '../session-handoff'
import { mcpElicitResult, mcpElicitationResponse, normalizeMcpElicitationRequest } from '../codex/codex-permissions'

const log = createLogger('AcpBackend', 'acp-backend.ts')

type JsonValue = z.core.util.JSONType

/** A connection with no turn closes after this long (docs/plans/antigravity-provider.md decision 3). */
export const ACP_IDLE_CLOSE_MS = 10 * 60_000
/** A model refresh that has not had its answer by then is stopped. */
const REFRESH_TIMEOUT_MS = 60_000
/** A stopped agent gets this long to exit before it is killed. */
const STOP_GRACE_MS = 2_000

export type SpawnAgent = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess

export interface AcpBackendOptions {
  agent: AcpAgent
  /** Where each ACP session keeps its history (§5.4). */
  historyDirectory: string
  spawnAgent?: SpawnAgent
  idleCloseMs?: number
  /** Adds a session's new messages to the host's session search; the host's index by default. */
  indexMessages?: (threadId: string, messages: SessionLoadMessage[]) => void
}

interface ActiveTurn {
  handle: RunHandle
  permissionMode: PermissionMode
  unattended: boolean
  readableRoots: string[]
  normalizer: AcpTurnNormalizer
  history: TurnHistory
  /** The newest `session/prompt` of the turn; a steer replaces it, and the turn ends with its answer. Null until the first is sent. */
  latestPrompt: Promise<AcpStopReason> | null
  /** Set in the step that saw the newest prompt answer: a steer from then on waits for the next turn. */
  isClosing: boolean
  /** The tokens of every prompt of the turn, steers too. */
  usage: UsageData
}

interface LiveSession {
  key: string
  /** The Solus thread: the id of the agent session that started it. */
  threadId: string | null
  /** The agent session in this connection's place, which every ACP message names. */
  agentSessionId: string | null
  child: ChildProcess
  connection: AcpConnection
  configOptions: AcpConfigOption[]
  steersWithPrompt: boolean
  turn: ActiveTurn | null
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Whether a run with Solus tools opened it: only `session/new` or a resume can give the agent the Solus MCP server. */
  openedWithTools: boolean
  /** Set once the session is open: an update before that is a replay of its history. */
  isOpen: boolean
  /** What the agent did with no turn, until the turn that wakes the session takes it. */
  agentWork: AcpAgentWork
  /** The agent left work running that replies later (a daemon schedule): the connection does not close when idle. */
  keepsWorking: boolean
}

/** A request waiting on a person: a choice among the agent's options, or a form's answers by field. Null finishes it as cancelled. */
type PendingAnswer =
  | { kind: 'permission' | 'question'; threadId: string; toolName: string; options: AcpPermissionRequest['options']; finish(optionId: string | null): void }
  | { kind: 'form'; threadId: string; toolName: string; finish(answers: Record<string, string> | null): void }

/** Adds one prompt's tokens to the turn's. Reasoning is part of the output, so it is never more than the output. */
function addPromptUsage(total: UsageData, usage: AcpPromptUsage): void {
  const add = (current: number | undefined, value: number | null | undefined) => value == null ? current : (current ?? 0) + value
  total.inputTokens = add(total.inputTokens, usage.inputTokens)
  total.outputTokens = add(total.outputTokens, usage.outputTokens)
  total.cacheReadTokens = add(total.cacheReadTokens, usage.cachedReadTokens)
  total.cacheCreationTokens = add(total.cacheCreationTokens, usage.cachedWriteTokens)
  total.reasoningTokens = add(total.reasoningTokens, usage.thoughtTokens == null ? null : Math.min(usage.thoughtTokens, usage.outputTokens))
}


const TEMP_PREFIX = 'run-'

/** Removes a process's temp folder in the background: agy unpacks about 1 GB into it. */
function removeTemp(folder: string): void {
  void rm(folder, { recursive: true, force: true }).catch((error: Error) => log.warn('acp_temp_remove_failed', { folder, error: error.message }))
}

const STOP_MESSAGES = {
  max_tokens: 'The agent reached its output limit, so the answer may be cut short.',
  max_turn_requests: 'The agent reached its limit of requests for one turn.',
  refusal: 'The agent refused to continue this request.',
} as const satisfies Partial<Record<AcpStopReason, string>>

const defaultSpawn: SpawnAgent = (file, args, options) => nodeSpawn(file, args, {
  cwd: resolveHomePath(options.cwd),
  env: options.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
  windowsHide: true,
})

function isInside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

/**
 * The Solus backend for an agent that speaks the Agent Client Protocol over
 * stdio (docs/plans/antigravity-provider.md §5). One connection per session,
 * kept between turns; Solus answers permissions from the session's mode and
 * keeps the session's history.
 */
export class AcpBackend extends BaseAgentBackend implements AgentBackend {
  readonly id: AgentId
  readonly permissions: PermissionResponder

  private readonly agent: AcpAgent
  private readonly history: KeptHistory
  private readonly historyDirectory: string
  private readonly spawnAgent: SpawnAgent
  private readonly idleCloseMs: number
  private readonly indexMessages: (threadId: string, messages: SessionLoadMessage[]) => void
  /** Live connections by provider thread id. */
  private readonly live = new Map<string, LiveSession>()
  private readonly pending = new Map<string, PendingAnswer>()
  private readonly sweptTempRoots = new Set<string>()
  /** The commands and models the agent reported last: agy reports them only when a session opens. */
  private readonly report: AcpAgentReport
  private readonly places: AcpThreadPlaces
  private refreshing: Promise<void> | null = null

  constructor(options: AcpBackendOptions) {
    super()
    this.agent = options.agent
    this.id = options.agent.id
    this.historyDirectory = options.historyDirectory
    this.history = new KeptHistory(options.historyDirectory)
    this.report = new AcpAgentReport(options.agent.id, join(options.historyDirectory, `.${options.agent.id}-report.json`))
    this.places = new AcpThreadPlaces(join(options.historyDirectory, `.${options.agent.id}-places.json`))
    this.spawnAgent = options.spawnAgent ?? defaultSpawn
    this.idleCloseMs = options.idleCloseMs ?? ACP_IDLE_CLOSE_MS
    this.indexMessages = options.indexMessages ?? indexSessionMessages
    this.permissions = {
      getPendingInfo: (questionId) => {
        const pending = this.pending.get(questionId)
        return pending ? { toolName: pending.toolName, sessionId: pending.threadId } : undefined
      },
      respondToPermission: (questionId, decision) => {
        const pending = this.pending.get(questionId)
        if (!pending || pending.kind !== 'permission') return false
        // A client answers with one of the request's own options, or with Solus's plain allow or deny.
        const chosen = pending.options.find((option) => option.optionId === decision)
        pending.finish(chosen?.optionId ?? acpPermissionOption(pending.options, decision === 'allow' || decision === 'allow-session' ? 'allow' : 'deny'))
        return true
      },
      respondToQuestion: (questionId, answers) => {
        const pending = this.pending.get(questionId)
        if (!pending || pending.kind === 'permission') return false
        if (pending.kind === 'form') {
          pending.finish(answers)
          return true
        }
        const answer = Object.values(answers)[0]
        pending.finish(pending.options.find((option) => option.name === answer)?.optionId ?? null)
        return true
      },
      clearPendingForSession: (threadId) => {
        for (const pending of this.pending.values()) if (pending.threadId === threadId) pending.finish(null)
      },
      setCurrentSessionId: () => {},
    }
  }

  /** Read per call: the host replaces the published model list, and the agent reports its own models. */
  get metadata(): AgentMetadata {
    const { models, defaultModel } = providerModelsFor(this.id)
    const metadata: AgentMetadata = {
      id: this.id,
      label: this.agent.label,
      models,
      defaultModel,
      available: true,
      capabilities: { planMode: true, permissions: true, transport: 'acp' },
    }
    // Once the agent has reported its models, they are the list; the published list only labels them.
    const offered = this.report.offeredModels()
    if (offered.length === 0) return metadata
    metadata.models = offered.map(({ id, profile }) => ({ id, label: profile.label }))
    metadata.modelProfiles = Object.fromEntries(offered.map(({ id, profile }) => [id, profile]))
    metadata.defaultModel = offered.find(({ profile }) => profile.isDefault)?.id ?? offered[0]!.id
    metadata.modelsOffered = true
    return metadata
  }

  startRun(request: AgentRunRequest, sessionState?: AgentRunSessionState): RunHandle {
    let resolveRun!: () => void
    let rejectRun!: (err: Error) => void
    const runPromise = new Promise<void>((resolve, reject) => { resolveRun = resolve; rejectRun = reject })
    const handle: RunHandle = {
      agentSessionId: request.conversation?.kind === 'resume' ? request.conversation.threadId : null,
      sessionId: sessionState?.sessionId,
      persistence: request.persistence,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController: new AbortController(),
      runPromise,
      _resolveRun: resolveRun,
      _rejectRun: rejectRun,
    }
    void runPromise.catch(() => {})
    this.pendingRuns.push(handle)
    // After this returns, so the caller has registered the run before its first event.
    setImmediate(() => void this.runOrFail(handle, request, sessionState))
    return handle
  }

  private async runOrFail(handle: RunHandle, request: AgentRunRequest, sessionState?: AgentRunSessionState): Promise<void> {
    try {
      await this.run(handle, request, sessionState)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      const threadId = handle.agentSessionId
      const live = threadId ? this.live.get(threadId) : undefined
      if (live?.turn?.handle === handle) live.turn = null
      if (live && error instanceof AcpConnectionClosedError) this.closeLive(live)
      if (this.agent.isSignInRequired(err)) {
        this.emit('normalized', threadId, { type: 'error', message: this.agent.signInMessage, isError: true, kind: 'auth' } satisfies NormalizedEvent)
      }
      log.error('acp_run_failed', { provider: this.id, sessionId: handle.sessionId ?? null, error: err.message })
      this.emit('error', threadId, err, handle)
      this.finishRun(handle)
      handle._rejectRun(err)
    }
  }

  private async run(handle: RunHandle, request: AgentRunRequest, sessionState?: AgentRunSessionState): Promise<void> {
    const tools = this.runTools(handle, request, sessionState?.sessionId)
    handle.releaseTools = tools?.release
    const live = await this.connectionFor(handle, request, tools, sessionState)
    const threadId = live.threadId!
    if (handle.abortController.signal.aborted) return this.endStopped(handle, live, threadId)

    this.promoteToActive(handle, threadId)
    const model = request.model || this.metadata.defaultModel
    this.emit('normalized', threadId, { type: 'session_init', sessionId: threadId, model, skills: [] } satisfies NormalizedEvent)
    if (request.prompt === this.agentWorkPrompt) return this.takeAgentWork(live, threadId, this.newTurn(handle, request, live), request)
    await this.applyModel(live, request)
    await this.applyMode(live, request)
    const turn = this.newTurn(handle, request, live)
    const outcome = this.agent.watchTurnOutcome?.(request, live.agentSessionId!)
    // The turn is registered first: the agent's updates for the prompt can arrive at once.
    live.turn = turn
    const stopReason = await this.followPrompts(live, threadId, turn, this.sendPrompt(live, turn, request.prompt, request.imageAttachments))
    this.endTurn(live, threadId, turn, request.persistence)
    if (stopReason === 'cancelled' || handle.abortController.signal.aborted) return this.endStopped(handle, live, threadId)
    const failure = outcome?.(stopReason) ?? null
    if (failure?.usageLimit) return this.endLimited(handle, threadId, failure.usageLimit.resetsAt)
    // The turn's history is kept; the run fails with the agent's own error.
    if (failure) throw new Error(failure.message)
    this.complete(handle, threadId, turn, stopReason)
  }

  private newTurn(handle: RunHandle, request: AgentRunRequest, live: LiveSession): ActiveTurn {
    return {
      handle,
      permissionMode: request.permissionMode,
      unattended: request.unattended === true,
      readableRoots: [request.cwd, ...(request.additionalDirectories ?? [])].map((root) => resolve(resolveHomePath(root))),
      normalizer: new AcpTurnNormalizer(this.agent.nameTool, this.agent.stepsTool ?? null, {
        planTool: request.permissionMode === 'plan' ? this.agent.planTool ?? null : null,
        childCalls: this.agent.childCalls?.(request, live.agentSessionId!) ?? null,
      }),
      history: new TurnHistory(request.prompt),
      latestPrompt: null,
      isClosing: false,
      usage: {},
    }
  }

  /** A limit the account reached: the run parks until the reset, as a Claude or Codex limit does. */
  private endLimited(handle: RunHandle, threadId: string, resetsAt: number | null): void {
    this.emit('normalized', threadId, {
      type: 'rate_limit',
      status: 'limited',
      resetsAt,
      rateLimitType: this.agent.label,
      isUsingOverage: false,
    } satisfies NormalizedEvent)
    this.finishRun(handle)
    handle._resolveRun()
    this.emit('exit', threadId, 0, null, handle)
  }

  /** The wake's prompt, which the session shows; the turn that carries it takes the agent's own work and sends no prompt. */
  get agentWorkPrompt(): string {
    return `${this.agent.label} continued work it started earlier.`
  }

  /**
   * The turn of a wake: the work the agent did with no turn, then what it does
   * until it has been quiet (`AGENT_WORK_QUIET_MS`) with no call open. A wake
   * that finds no work (the connection closed meanwhile) ends at once.
   */
  private async takeAgentWork(live: LiveSession, threadId: string, turn: ActiveTurn, request: AgentRunRequest): Promise<void> {
    const signal = turn.handle.abortController.signal
    live.turn = turn
    for (const update of live.agentWork.take()) {
      for (const event of turn.normalizer.push(update)) this.emitTurnEvent(turn, threadId, event)
    }
    while (!signal.aborted && !(live.agentWork.isQuiet() && !turn.normalizer.hasOpenTools) && !live.connection.isClosed) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (signal.aborted) live.connection.notify('session/cancel', { sessionId: live.agentSessionId })
    this.endTurn(live, threadId, turn, request.persistence)
    if (signal.aborted) return this.endStopped(turn.handle, live, threadId)
    this.complete(turn.handle, threadId, turn, 'end_turn')
  }

  /** The session's open connection, or a new one: a changed sign-in or binary starts a new process. */
  /**
   * The run's Solus tools on the host's MCP endpoint (plans/035 §3). A session
   * keeps one token: agy keeps the MCP servers that `session/new` or the
   * resume gave it, and each turn binds its own tools to that token.
   */
  private runTools(handle: RunHandle, request: AgentRunRequest, sessionId: string | undefined): RunToolAccess | null {
    if (request.tools.length === 0) return null
    return bindRunTools({
      tools: request.tools,
      context: {
        provider: this.id,
        cwd: resolveHomePath(request.cwd),
        sessionId: () => handle.sessionId,
        abortSignal: handle.abortController.signal,
        emit: (event) => this.emit('normalized', handle.agentSessionId, event),
      },
      permissionMode: () => request.permissionMode,
      // agy asks through `session/request_permission` before it calls an MCP tool, and Solus answers that from the mode.
      approve: async () => true,
    }, sessionId)
  }

  private async connectionFor(handle: RunHandle, request: AgentRunRequest, tools: RunToolAccess | null, sessionState?: AgentRunSessionState): Promise<LiveSession> {
    const conversation = request.conversation ?? { kind: 'start' }
    if (conversation.kind === 'fork') log.warn('acp_fork_started_fresh', { provider: this.id, sessionId: handle.sessionId ?? null })
    const resumeId = conversation.kind === 'resume' ? conversation.threadId : null
    const launch = this.agent.launch(request)
    let live = resumeId ? this.live.get(resumeId) : undefined
    // A connection opened without the Solus tools cannot be given them: only a new session or a resume carries MCP servers.
    if (live && (live.key !== launch.connectionKey || live.connection.isClosed || (tools && !live.openedWithTools))) {
      this.closeLive(live)
      live = undefined
    }
    if (live?.turn) throw new Error('This session already has a running turn.')
    if (!live) {
      sessionState?.reportStartupPhase?.(resumeId ? 'resuming' : 'starting')
      live = await this.open(request, launch, resumeId, sessionState?.sessionId, tools)
    }
    this.clearIdle(live)
    return live
  }

  /** One `session/prompt`, which answers when the agent ends the work it started. */
  private sendPrompt(live: LiveSession, turn: ActiveTurn, prompt: string, images: AgentRunRequest['imageAttachments']): Promise<AcpStopReason> {
    const answer = live.connection.request('session/prompt', { sessionId: live.agentSessionId, prompt: this.promptBlocks(prompt, images) })
      .then((result) => {
        const parsed = promptResultSchema.parse(result)
        // An answer that arrives after the turn ended counts for no turn.
        if (parsed.usage && live.turn === turn) addPromptUsage(turn.usage, parsed.usage)
        return parsed.stopReason
      })
    // A prompt a steer replaced is not awaited: its failure must not become an unhandled rejection.
    void answer.catch(() => {})
    return answer
  }

  /**
   * Waits for the turn's prompts, newest last: a steer's prompt carries the turn
   * on, and an older prompt's answer, or failure, says nothing about its end.
   * Stop sends `session/cancel`, which ends them all.
   */
  private async followPrompts(live: LiveSession, threadId: string, turn: ActiveTurn, first: Promise<AcpStopReason>): Promise<AcpStopReason> {
    const signal = turn.handle.abortController.signal
    const cancel = () => live.connection.notify('session/cancel', { sessionId: live.agentSessionId })
    signal.addEventListener('abort', cancel, { once: true })
    turn.latestPrompt = first
    try {
      let awaited = first
      while (true) {
        let stopReason: AcpStopReason | null = null
        try {
          stopReason = await awaited
        } catch (error) {
          if (awaited === turn.latestPrompt) throw error
        }
        if (stopReason !== null && awaited === turn.latestPrompt) {
          turn.isClosing = true
          return stopReason
        }
        awaited = turn.latestPrompt ?? awaited
      }
    } finally {
      signal.removeEventListener('abort', cancel)
      this.permissions.clearPendingForSession(threadId)
    }
  }

  /** Closes the turn's open blocks, keeps its history, and frees or closes the connection. */
  private endTurn(live: LiveSession, threadId: string, turn: ActiveTurn, persistence: AgentRunRequest['persistence']): void {
    for (const event of turn.normalizer.finish()) this.emitTurnEvent(turn, threadId, event)
    live.turn = null
    turn.handle.toolCallCount = turn.normalizer.summary.toolCallCount
    if (persistence === 'session') {
      this.history.append(threadId, turn.history.rows())
      this.indexTurn(threadId)
      this.armIdle(live)
    } else {
      this.closeLive(live)
    }
  }

  /** Session search reads the host's index; the agent's own session files are not read for it. */
  private indexTurn(threadId: string): void {
    try {
      this.indexMessages(threadId, this.history.load(threadId))
    } catch (error) {
      log.warn('acp_message_index_failed', { provider: this.id, threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private complete(handle: RunHandle, threadId: string, turn: ActiveTurn, stopReason: Exclude<AcpStopReason, 'cancelled'>): void {
    const stopMessage = stopReason === 'end_turn' ? null : STOP_MESSAGES[stopReason]
    if (stopMessage) this.emit('normalized', threadId, { type: 'error', message: stopMessage, isError: false } satisfies NormalizedEvent)
    this.finishRun(handle)
    handle._resolveRun()
    this.emit('normalized', threadId, {
      type: 'task_complete',
      result: turn.history.resultText,
      costUsd: 0,
      durationMs: Date.now() - handle.startedAt,
      numTurns: 1,
      usage: turn.usage,
      sessionId: threadId,
      permissionDenials: handle.permissionDenials.map((denial) => ({ toolName: denial.tool_name, toolUseId: denial.tool_use_id })),
    } satisfies NormalizedEvent)
    this.emit('exit', threadId, 0, null, handle)
  }

  /** As a stopped Claude run reports it: no result, an interrupt signal. */
  private endStopped(handle: RunHandle, live: LiveSession, threadId: string): void {
    if (live.turn?.handle === handle) live.turn = null
    this.armIdle(live)
    this.finishRun(handle)
    handle._resolveRun()
    this.emit('exit', threadId, null, 'SIGINT', handle)
  }

  private promptBlocks(prompt: string, images: AgentRunRequest['imageAttachments']): JsonValue[] {
    const blocks: JsonValue[] = [{ type: 'text', text: prompt }]
    for (const image of images ?? []) {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(image.dataUrl)
      if (match) blocks.push({ type: 'image', mimeType: match[1]!, data: match[2]! })
    }
    return blocks
  }

  private async open(request: AgentRunRequest, launch: AcpAgentLaunch, resumeId: string | null, solusSessionId: string | undefined, tools: RunToolAccess | null): Promise<LiveSession> {
    const cwd = resolveHomePath(request.cwd)
    const live = this.spawnLive(launch, cwd)
    try {
      const initialize = await this.handshake(live, launch)
      const mcpServers: JsonValue[] = tools && initialize.parsed.agentCapabilities?.mcpCapabilities?.http
        ? [{ type: 'http', name: this.agent.mcpServerName, url: tools.url, headers: [{ name: 'Authorization', value: tools.authorization }] }]
        : []
      live.openedWithTools = tools !== null
      const agentSessionId = resumeId
        ? await this.continueSession(live, initialize, launch, resumeId, request, cwd, mcpServers)
        : await this.newSession(live, initialize.raw, cwd, mcpServers, request.systemPrompt)
      const threadId = resumeId ?? agentSessionId
      if (launch.place) this.places.record(threadId, launch.place, agentSessionId)
      live.threadId = threadId
      live.agentSessionId = agentSessionId
      const previous = this.live.get(threadId)
      if (previous && previous !== live) this.closeLive(previous)
      this.live.set(threadId, live)
      live.isOpen = true
      log.info('acp_session_opened', { provider: this.id, sessionId: solusSessionId ?? null, threadId, resumed: !!resumeId })
      return live
    } catch (error) {
      this.closeLive(live)
      throw error
    }
  }

  private spawnLive(launch: AcpAgentLaunch, cwd: string): LiveSession {
    const temp = launch.tempRoot ? this.privateTemp(launch.tempRoot) : null
    const env = temp ? { ...launch.env, TMPDIR: temp, TEMP: temp, TMP: temp } : launch.env
    let child: ChildProcess
    try {
      child = this.spawnAgent(launch.file, launch.args, { cwd, env })
    } catch (error) {
      if (temp) removeTemp(temp)
      throw error
    }
    if (temp) {
      let removed = false
      const remove = () => {
        if (removed) return
        removed = true
        removeTemp(temp)
      }
      child.once('exit', remove)
      child.once('error', remove)
    }
    const live: LiveSession = {
      key: launch.connectionKey, threadId: null, agentSessionId: null, child, connection: null!, configOptions: [], steersWithPrompt: false, turn: null, idleTimer: null,
      openedWithTools: false, isOpen: false, agentWork: new AcpAgentWork(), keepsWorking: false,
    }
    live.connection = new AcpConnection({ stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr }, {
      onNotification: (method, params) => this.onNotification(live, method, params),
      onRequest: (method, params) => this.onAgentRequest(live, method, params),
      onStderrLine: (line) => log.debug('acp_agent_stderr', { provider: this.id, line: line.slice(0, 500) }),
      onClose: () => this.onClosed(live),
    })
    child.once('error', (error) => live.connection.close(`The ${this.agent.label} agent could not start: ${error.message}`))
    child.once('exit', (code, signal) => live.connection.close(`The ${this.agent.label} agent exited (${signal ?? `code ${code}`}).${stderrSummary(live.connection.recentStderr)}`))
    return live
  }

  /**
   * A new temp folder for one process in `root`. The first in a root of this
   * backend first removes what earlier processes left after a crash: no
   * process of this backend uses them yet.
   */
  private privateTemp(root: string): string {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (!this.sweptTempRoots.has(root)) {
      this.sweptTempRoots.add(root)
      for (const entry of readdirSync(root)) if (entry.startsWith(TEMP_PREFIX)) removeTemp(join(root, entry))
    }
    return mkdtempSync(join(root, TEMP_PREFIX))
  }

  /** `initialize`, then `authenticate` with the launch's method when the agent offers it. */
  private async handshake(live: LiveSession, launch: AcpAgentLaunch): Promise<{ raw: JsonValue | undefined; parsed: AcpInitializeResult }> {
    const raw = await live.connection.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // Forms: agy's `ask_question` arrives as `elicitation/create`.
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
      clientInfo: { name: 'solus', title: 'Solus', version: '1.0.0' },
    })
    const parsed = initializeResultSchema.parse(raw)
    live.steersWithPrompt = this.agent.steersWithPrompt(parsed)
    if (launch.authMethod && parsed.authMethods?.some((method) => method.id === launch.authMethod)) {
      await live.connection.request('authenticate', { methodId: launch.authMethod })
    }
    return { raw, parsed }
  }

  private async newSession(live: LiveSession, initializeResult: JsonValue | undefined, cwd: string, mcpServers: JsonValue[], systemPrompt: string | undefined): Promise<string> {
    const meta = this.agent.sessionMeta(initializeResult, systemPrompt)
    const setup = sessionSetupResultSchema.parse(await live.connection.request('session/new', meta === undefined ? { cwd, mcpServers } : { cwd, mcpServers, _meta: meta }) ?? {})
    if (!setup.sessionId) throw new Error(`${this.agent.label} started a session without an id.`)
    this.takeSetup(live, setup)
    return setup.sessionId
  }

  /**
   * The thread's agent session in this place: the one recorded, else the thread's own when the
   * place holds it. A place without it (another member's seat, or another host after the cloud
   * copy) gets a new agent session that reads the thread's history from the handoff text.
   */
  private async continueSession(live: LiveSession, initialize: { raw: JsonValue | undefined; parsed: AcpInitializeResult }, launch: AcpAgentLaunch, threadId: string, request: AgentRunRequest, cwd: string, mcpServers: JsonValue[]): Promise<string> {
    const recorded = launch.place ? this.places.agentSession(threadId, launch.place) : undefined
    if (recorded || !launch.place || this.agent.hasThread?.(launch.place, threadId) !== false) {
      return this.resumeSession(live, initialize.parsed, recorded ?? threadId, cwd, mcpServers)
    }
    const handoff = await buildHandoff(threadId, cwd, {
      loadPage: async (id, _path, turnLimit, before) => this.history.page(id, turnLimit, before),
      loadFirstTurn: async (id) => this.history.firstTurn(id),
      fromProvider: this.id, targetProvider: this.id, targetModel: request.model ?? undefined, nextPrompt: request.prompt,
    })
    log.info('acp_thread_handed_off', { provider: this.id, threadId, hasHistory: handoff.transcriptFilePath !== null })
    const seed = composeHandoffSeed({ fromProvider: this.id, ...handoff })
    return this.newSession(live, initialize.raw, cwd, mcpServers, [request.systemPrompt, seed].filter(Boolean).join('\n\n'))
  }

  /** `session/resume` keeps the agent from replaying history; `session/load` is the fallback. */
  private async resumeSession(live: LiveSession, initialize: AcpInitializeResult, threadId: string, cwd: string, mcpServers: JsonValue[]): Promise<string> {
    const capabilities = initialize.agentCapabilities
    const method = capabilities?.sessionCapabilities?.resume ? 'session/resume' : capabilities?.loadSession ? 'session/load' : null
    if (!method) throw new Error(`${this.agent.label} cannot continue a saved session.`)
    const setup = sessionSetupResultSchema.parse(await live.connection.request(method, { sessionId: threadId, cwd, mcpServers }) ?? {})
    this.takeSetup(live, setup)
    return threadId
  }

  /**
   * Opens a session only to read the models the agent offers the account, then
   * closes it (§5.5). The list otherwise changes only when a person opens a
   * session, so a new plan on the account would not show. A refresh in flight
   * is joined.
   */
  refreshModels(seat?: TurnSeat): Promise<void> {
    this.refreshing ??= this.readOfferedModels(seat).finally(() => { this.refreshing = null })
    return this.refreshing
  }

  private async readOfferedModels(seat: TurnSeat | undefined): Promise<void> {
    const launch = this.agent.launch({ seat })
    const cwd = homedir()
    const live = this.spawnLive(launch, cwd)
    const timer = setTimeout(() => live.connection.close(`${this.agent.label} did not report its models within ${REFRESH_TIMEOUT_MS / 1000} seconds.`), REFRESH_TIMEOUT_MS)
    timer.unref?.()
    try {
      const initialize = await this.handshake(live, launch)
      await this.newSession(live, initialize.raw, cwd, [], undefined)
      log.info('acp_models_refreshed', { provider: this.id, models: this.report.offeredModels().length })
    } finally {
      clearTimeout(timer)
      this.closeLive(live)
    }
  }

  /** A session's options; the models it offers join the model picker (§5.5). */
  private takeSetup(live: LiveSession, setup: AcpSessionSetupResult): void {
    live.configOptions = setup.configOptions ?? []
    if (this.report.keepModels(modelsOffered(setup))) this.emit('models-reported')
  }

  /** The model and its reasoning level, through the session's own options (§5.5). */
  private async applyModel(live: LiveSession, request: AgentRunRequest): Promise<void> {
    const modelOption = live.configOptions.find((option) => option.id === 'model')
    const models = modelsOffered({ configOptions: live.configOptions })
    // agy still takes a model's older id, such as `gemini-3.8-flash-high` for `gemini-3.8-flash`.
    if (request.model && models.length > 0 && !models.some((model) => request.model === model.id || request.model!.startsWith(`${model.id}-`))) {
      throw new Error(`${this.agent.label} does not offer the model ${request.model} to this account. Choose another model.`)
    }
    const newModel = request.model && modelOption?.currentValue !== request.model ? request.model : null
    const modelChanged = newModel !== null
    if (newModel) {
      await live.connection.request('session/set_model', { sessionId: live.agentSessionId, modelId: newModel })
      if (modelOption) modelOption.currentValue = newModel
    }
    const thinking = live.configOptions.find((option) => option.category === 'thought_level')
    const effort = request.reasoningEffort
    // agy resets the level when the model changes, so a new model always gets the effort.
    if (!thinking || !effort || (!modelChanged && thinking.currentValue === effort)) return
    // After a model change the options are the previous model's until agy's
    // update arrives, after its answer: the report says which efforts the model takes.
    const offered = (request.model ? this.report.reasoningLevelsOf(request.model) : undefined)
      ?? (thinking.options ?? []).flatMap((entry) => 'value' in entry ? [entry.value] : entry.options.map((option) => option.value))
    if (!offered.includes(effort)) return
    await live.connection.request('session/set_config_option', { sessionId: live.agentSessionId, configId: thinking.id, value: effort })
    thinking.currentValue = effort
  }

  /**
   * The agent's own plan mode for Solus's: in it the agent writes its plan
   * instead of asking to edit, which Solus's plan mode would refuse. Every other
   * Solus mode keeps the agent's default, which asks, and Solus answers.
   */
  private async applyMode(live: LiveSession, request: AgentRunRequest): Promise<void> {
    const mode = live.configOptions.find((option) => option.category === 'mode')
    const wanted = request.permissionMode === 'plan' && !request.unattended ? 'plan' : 'default'
    if (!mode || mode.currentValue === wanted) return
    const offered = (mode.options ?? []).flatMap((entry) => 'value' in entry ? [entry.value] : entry.options.map((option) => option.value))
    if (!offered.includes(wanted)) return
    await live.connection.request('session/set_config_option', { sessionId: live.agentSessionId, configId: mode.id, value: wanted })
    mode.currentValue = wanted
  }

  private emitTurnEvent(turn: ActiveTurn, threadId: string, event: NormalizedEvent): void {
    turn.history.record(event)
    this.emit('normalized', threadId, event)
  }

  private onNotification(live: LiveSession, method: string, params: JsonValue | undefined): void {
    if (method !== 'session/update') return
    const notification = sessionNotificationSchema.safeParse(params)
    const update = notification.success ? sessionUpdateSchema.safeParse(notification.data.update) : null
    if (!notification.success || !update?.success) return
    // The selected model's options, such as its thinking levels, after a model change.
    if (update.data.sessionUpdate === 'config_option_update') {
      const options = z.array(configOptionSchema).safeParse(update.data.configOptions)
      if (options.success) live.configOptions = options.data
      return
    }
    // The agent's own commands, for the slash menu. They arrive when a session opens, before any turn.
    if (update.data.sessionUpdate === 'available_commands_update') {
      this.report.keepCommands(update.data.availableCommands.map((command): AgentSlashCommand => {
        const entry: AgentSlashCommand = { name: command.name, description: command.description }
        if (command.input?.hint) entry.argumentHint = command.input.hint
        return entry
      }))
      return
    }
    const turn = live.turn
    const threadId = live.threadId
    if (!threadId || notification.data.sessionId !== live.agentSessionId) return
    if ((update.data.sessionUpdate === 'tool_call' || update.data.sessionUpdate === 'tool_call_update') && this.agent.startsDaemon?.(update.data)) live.keepsWorking = true
    if (!turn) {
      // Work the agent started by itself wakes the session once; a replay of history while the session opens is no work.
      if (live.isOpen && live.agentWork.hold(update.data)) this.emit('background-task-completed', threadId, this.agentWorkPrompt, 'background-command')
      return
    }
    live.agentWork.lastUpdateAt = Date.now()
    for (const event of turn.normalizer.push(update.data)) this.emitTurnEvent(turn, threadId, event)
  }

  private async onAgentRequest(live: LiveSession, method: string, params: JsonValue | undefined): Promise<JsonValue> {
    if (method === 'session/request_permission') return this.answerPermission(live, requestPermissionSchema.parse(params))
    if (method === 'fs/read_text_file') return this.readTextFile(live, readTextFileSchema.parse(params))
    if (method === 'elicitation/create') return this.answerForm(live, params)
    throw methodNotFound(method)
  }

  private async answerPermission(live: LiveSession, request: AcpPermissionRequest): Promise<JsonValue> {
    const turn = live.turn
    const threadId = live.threadId
    const cancelled = { outcome: { outcome: 'cancelled' } }
    if (!turn || !threadId || request.sessionId !== live.agentSessionId) return cancelled
    const select = (optionId: string | null): JsonValue => optionId ? { outcome: { outcome: 'selected', optionId } } : cancelled
    // The tool's card shows before the person is asked about it.
    for (const event of turn.normalizer.push({ ...request.toolCall, sessionUpdate: 'tool_call_update' })) this.emitTurnEvent(turn, threadId, event)
    const toolCallId = request.toolCall.toolCallId
    if (this.agent.isQuestion(toolCallId)) {
      if (turn.unattended) return cancelled
      return select(await this.ask(turn, threadId, request, 'question'))
    }
    const answer = turn.unattended ? (acpPermissionAnswer(turn.permissionMode, request.toolCall.kind) === 'allow' ? 'allow' : 'deny')
      : acpPermissionAnswer(turn.permissionMode, request.toolCall.kind)
    const optionId = answer === 'ask' ? await this.ask(turn, threadId, request, 'permission') : acpPermissionOption(request.options, answer)
    const chosen = request.options.find((option) => option.optionId === optionId)
    if (chosen && (chosen.kind === 'reject_once' || chosen.kind === 'reject_always')) {
      turn.handle.permissionDenials.push({ tool_name: request.toolCall.title ?? request.toolCall.kind ?? 'Tool', tool_use_id: toolCallId })
    }
    return select(optionId)
  }

  /**
   * A form the agent asks the person to fill (`elicitation/create`): agy's
   * `ask_question`. It shows as the same question card as an MCP server's form,
   * read and answered by the same rules.
   */
  private async answerForm(live: LiveSession, params: JsonValue | undefined): Promise<JsonValue> {
    const turn = live.turn
    const threadId = live.threadId
    const request = elicitationRequestSchema.safeParse(params)
    if (!turn || !threadId || !request.success || request.data.sessionId !== live.agentSessionId || turn.unattended) return { action: 'cancel' }
    const form = normalizeMcpElicitationRequest(params)
    if (form?.request.kind !== 'mcp_form') return { action: 'decline' }
    const answers = await this.waitForAnswer<Record<string, string>>(turn, threadId, (finish) => ({ kind: 'form', threadId, toolName: 'AskUserQuestion', finish }), (questionId) => ({
      type: 'question_request',
      questionId,
      questions: form.questions,
      kind: 'mcp_form',
    }))
    if (!answers) return { action: 'cancel' }
    const result = mcpElicitResult(mcpElicitationResponse(params, answers))
    return result.action === 'accept' ? { action: 'accept', content: result.content ?? {} } : { action: result.action }
  }

  /** Registers a request, shows it, and waits for its answer, or for the turn to stop. */
  private waitForAnswer<Answer>(
    turn: ActiveTurn,
    threadId: string,
    entry: (finish: (answer: Answer | null) => void) => PendingAnswer,
    event: (questionId: string) => NormalizedEvent,
  ): Promise<Answer | null> {
    const questionId = randomUUID()
    const signal = turn.handle.abortController.signal
    return new Promise((resolve) => {
      const finish = (answer: Answer | null) => {
        if (!this.pending.delete(questionId)) return
        signal.removeEventListener('abort', onAbort)
        this.emit('normalized', threadId, { type: 'permission_resolved', questionId } satisfies NormalizedEvent)
        resolve(answer)
      }
      const onAbort = () => finish(null)
      this.pending.set(questionId, entry(finish))
      signal.addEventListener('abort', onAbort, { once: true })
      // Registered first, so an answer given while the event is delivered is not lost.
      this.emit('normalized', threadId, event(questionId))
    })
  }

  /** Shows a permission request or a choice question and waits for the option the person chose. */
  private ask(turn: ActiveTurn, threadId: string, request: AcpPermissionRequest, kind: 'permission' | 'question'): Promise<string | null> {
    const toolName = request.toolCall.title ?? request.toolCall.kind ?? 'Tool'
    if (kind === 'permission') turn.handle.sawPermissionRequest = true
    return this.waitForAnswer<string>(turn, threadId, (finish) => ({ threadId, toolName, kind, options: request.options, finish }), (questionId) => kind === 'question'
        ? {
            type: 'question_request',
            questionId,
            questions: [{ id: request.toolCall.toolCallId, question: toolName, options: request.options.map((option) => ({ label: option.name })), multiSelect: false }],
          }
        : {
            type: 'permission_request',
            questionId,
            toolName,
            toolUseId: request.toolCall.toolCallId,
            options: request.options.map((option): PermissionOption => ({ id: option.optionId, label: option.name, kind: option.kind.startsWith('allow') ? 'allow' : 'deny' })),
            startedAtMs: Date.now(),
          })
  }

  /** `fs/read_text_file`, inside the run's folders only. */
  private async readTextFile(live: LiveSession, request: z.infer<typeof readTextFileSchema>): Promise<JsonValue> {
    const turn = live.turn
    const path = resolve(request.path)
    if (!turn || !turn.readableRoots.some((root) => isInside(root, path))) throw new Error('This file is outside the session folders.')
    const text = await readFile(path, 'utf8')
    if (this.agent.isClientRead && live.threadId) {
      for (const event of turn.normalizer.completeServedRead(path, this.agent.isClientRead)) this.emitTurnEvent(turn, live.threadId, event)
    }
    if (!request.line && !request.limit) return { content: text }
    const lines = text.split('\n')
    const start = Math.max(0, (request.line ?? 1) - 1)
    return { content: lines.slice(start, request.limit ? start + request.limit : undefined).join('\n') }
  }

  private onClosed(live: LiveSession): void {
    this.clearIdle(live)
    if (live.threadId && this.live.get(live.threadId) === live) this.live.delete(live.threadId)
    if (live.threadId) this.permissions.clearPendingForSession(live.threadId)
  }

  private closeLive(live: LiveSession): void {
    live.connection.close('Solus closed the connection.')
    stopChild(live.child)
  }

  private armIdle(live: LiveSession): void {
    this.clearIdle(live)
    live.idleTimer = setTimeout(() => {
      if (!live.turn && !live.keepsWorking) this.closeLive(live)
    }, this.idleCloseMs)
    live.idleTimer.unref?.()
  }

  private clearIdle(live: LiveSession): void {
    if (live.idleTimer) clearTimeout(live.idleTimer)
    live.idleTimer = null
  }

  /**
   * Sends a message into the running turn as one more `session/prompt`, when the
   * agent takes one (decision 4). Null when the turn is ending, stopped, or the
   * agent cannot steer: the session runtime keeps the message for the next turn.
   */
  async steerSession(threadId: string, options: Pick<PromptOptions, 'prompt' | 'imageAttachments'>): Promise<RunHandle | null> {
    const live = this.live.get(threadId)
    const turn = live?.turn
    if (!live || !turn?.latestPrompt || !live.steersWithPrompt || turn.isClosing || turn.handle.abortController.signal.aborted) return null
    turn.history.record({ type: 'user_message', text: options.prompt })
    turn.latestPrompt = this.sendPrompt(live, turn, options.prompt, options.imageAttachments)
    log.info('acp_steer_sent', { provider: this.id, sessionId: turn.handle.sessionId ?? null, threadId })
    return turn.handle
  }

  /**
   * The session cloud copy of a thread (docs/plans/portable-sessions.md): Solus's own history of
   * it, which only grows. The agent's session files stay in its profile; a host that continues the
   * thread has no agent session for it, so the thread goes on there by handoff (`continueSession`).
   */
  async threadFiles(threadId: string): Promise<ThreadFile[]> {
    const path = this.history.file(threadId)
    return existsSync(path) ? [{ key: 'history', relativePath: this.history.fileName(threadId), path }] : []
  }

  async importThread(request: ThreadImportRequest): Promise<ThreadImportResult> {
    mkdirSync(this.historyDirectory, { recursive: true })
    return importThreadFiles(this.historyDirectory, request.files, request.signal, request.replaceConflicts)
  }

  async loadSession(threadId: string, _projectPath?: string, limit?: number): Promise<SessionLoadMessage[]> {
    return this.history.load(threadId, limit)
  }

  async loadSessionFirstTurn(threadId: string): Promise<SessionLoadMessage[]> {
    return this.history.firstTurn(threadId)
  }

  async loadSessionPage(threadId: string, _projectPath: string | undefined, turnLimit: number, before?: string): Promise<ProviderHistoryPage> {
    return this.history.page(threadId, turnLimit, before)
  }

  async listPlans(): Promise<PlanDescriptor[]> {
    return []
  }

  async loadPlanContent(): Promise<string | null> {
    return null
  }

  async listPluginCommands(workingDirectory: string, _ctx?: IpcContext, seat?: TurnSeat): Promise<PluginCommandsResult> {
    const commands = this.agent.listCommands(resolveHomePath(workingDirectory), seat)
    return this.report.commands.length > 0 ? { ...commands, builtin: this.report.commands } : commands
  }

  /** Skills are read from disk on each list, so nothing is cached to refresh. */
  async refreshPluginCommands(): Promise<void> {}

  shutdown(): void {
    for (const live of this.live.values()) this.closeLive(live)
  }

  protected override _errorMessage(exitCode: number | null): string {
    return `${this.agent.label} stopped${exitCode === null ? '' : ` with exit code ${exitCode}`}.`
  }
}

function stderrSummary(lines: string[]): string {
  const tail = lines.slice(-3).join('\n').trim()
  return tail ? `\n${tail}` : ''
}

/** Stops only the process this backend started, with its process group. */
function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  const signal = (name: NodeJS.Signals) => {
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, name); return } catch { /* The group is gone; signal the child. */ }
    }
    child.kill(name)
  }
  child.stdin?.end()
  signal('SIGTERM')
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) signal('SIGKILL') }, STOP_GRACE_MS)
  timer.unref?.()
}
