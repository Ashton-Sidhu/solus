import { BaseAgentBackend } from '../base-backend'
import { CodexRpcError, getCodexAppServerClient } from './codex-agent'
import { encodePathAsFolder } from '../utils'
import { createLogger, isDebugEnabled } from '../../logger'
import { loadAllAnnotations } from '../../plans/annotations'
import {
  isPlanIndexComplete,
  listIndexedPlans,
  loadIndexedPlanContent,
  replaceIndexedPlansForProvider,
  replaceIndexedPlansForSession,
  type IndexedPlanInput,
} from '../../plans/plan-index'
import { getHeadCommit } from '../../git/worktree-manager'
import { resolveRepoRoot } from '../../git/git-helpers'
import { initSessionBase, snapshotTurn } from '../../git/session-snapshots'
import type { AgentBackend, PermissionResponder, RunHandle } from '../agent-backend'
import type { AgentRunRequest, AgentRunSessionState } from '../agent-runner'
import type {
  AgentId,
  AgentMetadata,
  AgentUsageLimits,
  NormalizedEvent,
  PlanDescriptor,
  PluginCommandsResult,
  PromptOptions,
  SessionMeta,
  SessionIndexUpdatedEvent,
  ThreadGoal,
  ThreadGoalSetRequest,
  UsageWindow,
} from '../../../shared/types'
import type { SessionLoadMessage } from '../../../shared/session-history'
import { MODEL_PROFILES } from '../../../shared/types'
import { MemoryCache } from '../../../shared/cache'
import {
  cacheIndexedSessions,
  getCodexSessionIndexWatermark,
  getCodexSessionsWithMessages,
  getIndexedCodexSessionTimestamps,
  indexSessionMessages,
  listIndexedCodexSessions,
  setCodexSessionIndexWatermark,
} from '../../db/session-indexer'
import {
  CodexTurnNormalizer,
  normalizeThreadGoal,
} from './codex-event-normalizer'
import type {
  CodexThreadGoalClearResponse,
  CodexThreadGoalResponse,
  CodexThreadListResponse,
  CodexThreadReadResponse,
  CodexThreadResumeResponse,
  CodexThreadStartParams,
  CodexThreadStartResponse,
  CodexTurnStartParams,
  CodexTurnStartResponse,
  CodexTurnSteerParams,
  CodexTurnSteerResponse,
  JsonRpcNotification,
  JsonRpcRequest,
} from './codex-protocol'
import {
  CodexPermissionResponder,
  autoApprovalResponse,
  denialResponse,
  normalizeMcpElicitationRequest,
  normalizeQuestionItems,
  permissionToolName,
  permissionDescription,
  permissionOptions,
} from './codex-permissions'
import {
  approvalPolicyFor,
  codexSpawnedThreadLinks,
  codexForkCutoffTurnId,
  codexTurnToMessages,
  codexTurnsToMessages,
  codexThreadBelongsToProject,
  extractCodexChangedFilePaths,
  groupCodexPlansBySession,
  isInterruptedTurnStatus,
  isNormalStreamingTextNotification,
  isSolusWorktreePath,
  sandboxPolicyFor,
  scanCodexPlans,
  scanCodexThreadActivityTimestamp,
  toEpochMs,
  toIsoTimestamp,
  type CodexThreadSummary,
  type CodexTurnHistory,
  type ScannedCodexPlan,
} from './codex-utils'
import { adaptCodexTools, bareAgentToolName, CodexToolDispatcher } from './codex-tool-adapter'
import { z } from 'zod'

const log = createLogger('CodexBackend', 'codex-backend.ts')

const steerTurnBoundarySchema = z.object({
  codexErrorInfo: z.object({ activeTurnNotSteerable: z.unknown() }),
})

function optionalString<T>(value: T): string | undefined {
  const parsed = z.string().safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function isSteerTurnBoundaryError(error: Error): boolean {
  if (!(error instanceof CodexRpcError)) return false
  if (steerTurnBoundarySchema.safeParse(error.data).success) return true
  return /expected turn .*no longer active|active turn .*not steerable/i.test(error.message)
}

function isThreadNotLoadedError(error: Error): error is CodexRpcError {
  return error instanceof CodexRpcError && /thread not loaded/i.test(error.message)
}

/** Max concurrent thread/read calls while indexing Codex message bodies. Keeps a
 *  new user's first full sweep from spiking the RPC channel. */
const CODEX_INDEX_READ_CONCURRENCY = 6
const CODEX_PLAN_SCAN_CONCURRENCY = 6

/** Run `task` over `items` with at most `limit` in flight at once. */
async function runWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await task(items[index])
    }
  })
  await Promise.all(workers)
}

const codexProfiles = MODEL_PROFILES['codex'] ?? {}

const STATIC_CODEX_METADATA: AgentMetadata = {
  id: 'codex',
  label: 'Codex',
  models: Object.entries(codexProfiles).map(([id, p]) => ({ id, label: p.label })),
  defaultModel: Object.entries(codexProfiles).find(([, p]) => p.isDefault)?.[0] ?? '',
  capabilities: {
    planMode: true,
    permissions: true,
    fileRewind: false,
    terminalResume: false,
    transport: 'codex-app-server',
  },
}

type CodexRunHandle = RunHandle & {
  threadId: string | null
  turnId: string | null
  permissionMode: 'ask' | 'auto' | 'plan'
  interrupted: boolean
  normalizer: CodexTurnNormalizer
  workTree: string | null
  repoRoot: string | null
  /** Real project working directory — origin cwd recorded on created works. */
  cwd: string
  userMessagePreview: string
  baseChangedFiles: Set<string>
  turnDiffFiles: Set<string>
  trackedFiles: Set<string>
  toolDispatcher: CodexToolDispatcher
  persistent: boolean
}

interface CodexSkillsListResponse {
  data?: CodexSkillsByCwd[]
}

interface CodexSkillsByCwd {
  cwd?: string
  skills?: CodexSkill[]
  errors?: unknown[]
}

interface CodexSkill {
  name?: string
  description?: string
  path?: string
  enabled?: boolean
  interface?: {
    displayName?: string
    shortDescription?: string
    defaultPrompt?: string
  }
}

type CodexTurnInputItem =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'image'; url: string }
  | { type: 'skill'; name: string; path: string }

type CodexImageAttachment = NonNullable<PromptOptions['imageAttachments']>[number]

export class CodexBackend extends BaseAgentBackend<CodexRunHandle> implements AgentBackend {
  readonly id: AgentId = 'codex'
  readonly metadata: AgentMetadata = STATIC_CODEX_METADATA
  readonly permissions: PermissionResponder

  private client = getCodexAppServerClient()
  /** Maps Codex turn/item IDs → sessionId for event routing. */
  private sessionByTurn = new Map<string, string>()
  private sessionByItem = new Map<string, string>()
  private sessionByChildThread = new Map<string, string>()
  private fileChangesByItem = new Map<string, unknown[]>()
  private fileChangeTurnByItem = new Map<string, string>()
  private skillsByCwd = new MemoryCache<string, PluginCommandsResult>({ ttlMs: 5 * 60 * 1000, maxEntries: 64 })
  private planListCache = new MemoryCache<string, PlanDescriptor[]>({ ttlMs: 60_000, maxEntries: 64 })
  /** Per-cwd hot cache over the persistent session index. Codex has no files to
   *  stat, so refresh with a TTL and clear on turn completion, which is when a
   *  thread is created or its activity changes. */
  private sessionListCache = new MemoryCache<string, SessionMeta[]>({ ttlMs: 5 * 60 * 1000, maxEntries: 64 })
  private sessionIndexRefresh: Promise<void> | null = null
  private sessionIndexRefreshTimer: ReturnType<typeof setTimeout> | null = null
  /** Set once if `thread/start` rejects dynamicTools — we then drop them and
   *  the agent loses work create/read/update for the run (experimental API). */
  private dynamicToolsUnavailable = false

  constructor() {
    super()
    this.permissions = new CodexPermissionResponder(this.client)

    this.client.on('notification', (msg: JsonRpcNotification) => this.onNotification(msg))
    this.client.on('server-request', (msg: JsonRpcRequest) => this.onServerRequest(msg))
    this.client.on('error', (err: Error) => {
      for (const sessionId of this.activeRuns.keys()) this.emit('error', sessionId, err)
      for (const handle of this.pendingRuns) {
        handle._rejectRun(err)
        this.emit('error', null, err)
      }
    })
    this.client.on('exit', () => {
      const exitErr = new Error('Codex app-server exited')
      for (const sessionId of this.activeRuns.keys()) this.emit('error', sessionId, exitErr)
      for (const handle of this.pendingRuns) {
        handle._rejectRun(exitErr)
        this.emit('error', handle.agentSessionId, exitErr)
      }
    })
  }

  private permissionResponder(): CodexPermissionResponder {
    // SAFETY: The constructor always assigns CodexPermissionResponder to the public responder interface.
    return this.permissions as CodexPermissionResponder
  }

  startRun(request: AgentRunRequest, sessionState?: AgentRunSessionState): RunHandle {
    const abortController = new AbortController()
    const workTree = request.cwd
    let handle!: CodexRunHandle
    const toolDispatcher = new CodexToolDispatcher(request.tools, {
      provider: 'codex',
      cwd: request.cwd,
      sessionId: () => handle?.agentSessionId ?? undefined,
      solusSessionId: () => handle?.sessionId,
      abortSignal: abortController.signal,
      parentToolUseId: () => undefined,
      emit: (event) => this.emit('normalized', handle?.agentSessionId ?? null, event),
    })

    let _resolveRun!: () => void
    let _rejectRun!: (err: Error) => void
    const runPromise = new Promise<void>((res, rej) => { _resolveRun = res; _rejectRun = rej })

    handle = {
      agentSessionId: request.sessionId ?? null,
      persistence: request.persistence,
      threadId: request.sessionId ?? null,
      turnId: null,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController,
      runPromise,
      _resolveRun,
      _rejectRun,
      permissionMode: request.permissionMode,
      interrupted: false,
      normalizer: new CodexTurnNormalizer({ planMode: request.permissionMode === 'plan' }),
      workTree,
      repoRoot: null,
      cwd: request.cwd,
      userMessagePreview: request.prompt.slice(0, 80),
      baseChangedFiles: new Set(sessionState?.changedFiles ?? []),
      turnDiffFiles: new Set(),
      trackedFiles: new Set(sessionState?.changedFiles ?? []),
      toolDispatcher,
      persistent: request.persistence === 'session',
    }

    this.pendingRuns.push(handle)
    void this.run(handle, request)
    return handle
  }

  private async run(
    handle: CodexRunHandle,
    request: AgentRunRequest,
  ): Promise<void> {
    try {
      let threadId = handle.threadId
      const model = this.resolveModel(request.model ?? null)
      const threadConfig: CodexThreadStartParams = {
        model,
        cwd: request.cwd,
        approvalPolicy: approvalPolicyFor(request.permissionMode),
        baseInstructions: request.systemPrompt ?? null,
        developerInstructions: request.systemPrompt ?? null,
        experimentalRawEvents: false,
        persistExtendedHistory: request.persistence === 'session',
        ephemeral: request.persistence === 'ephemeral',
      }
      // Dynamic tools (list/read/update_work) are an experimental app-server
      // capability — include them unless a prior start rejected them.
      const toolsConfig = this.dynamicToolsUnavailable
        ? threadConfig
        : {
            ...threadConfig,
            dynamicTools: [
              ...adaptCodexTools(request.tools),
            ],
          }

      const reasoningEffort = request.reasoningEffort ?? 'high'

      let response: CodexThreadStartResponse
      if (request.forkSession && threadId) {
        let lastTurnId: string | undefined
        if (request.forkExcludeLatestTurn) {
          const source = await this.client.request<CodexThreadReadResponse>('thread/read', {
            threadId,
            includeTurns: true,
          })
          const turns = source.thread?.turns ?? []
          const activeTurnId = this.activeRuns.get(threadId)?.turnId ?? null
          lastTurnId = codexForkCutoffTurnId(turns, activeTurnId)
        }
        response = await this.client.request<CodexThreadStartResponse>('thread/fork', {
          threadId,
          lastTurnId,
        })
        threadId = response.thread.id
      } else if (!threadId) {
        try {
          response = await this.client.request<CodexThreadStartResponse>('thread/start', { ...toolsConfig, reasoning_effort: reasoningEffort })
        } catch (err: any) {
          if (this.dynamicToolsUnavailable) throw err
          // Retry once without dynamicTools — the agent loses work tools this run.
          log.warn('thread_start_dynamic_tools_rejected', { error: err?.message ?? String(err) })
          this.dynamicToolsUnavailable = true
          response = await this.client.request<CodexThreadStartResponse>('thread/start', { ...threadConfig, reasoning_effort: reasoningEffort })
        }
        threadId = response.thread.id
      } else {
        response = await this.client.request<CodexThreadStartResponse>('thread/resume', {
          threadId,
          ...toolsConfig,
        })
        threadId = response.thread.id || threadId
      }

      // Promote from pending to active now that we have the real sessionId.
      handle.threadId = threadId
      this.promoteToActive(handle, threadId)

      this.permissionResponder().setCurrentSessionId(threadId)
      this.emitThreadSessionInit(threadId, threadId, model, response)

      if (request.persistence === 'session') await this.initSnapshots(handle, threadId)

      if (handle.abortController.signal.aborted) {
        this.emit('exit', threadId, null, 'SIGINT')
        return
      }

      const isPlanMode = request.permissionMode === 'plan' && !request.unattended
      const input = await this.buildTurnInput(request.prompt, request.cwd, request.imageAttachments)
      const turnParams: CodexTurnStartParams = {
        threadId,
        input,
        cwd: request.cwd,
        approvalPolicy: approvalPolicyFor(request.permissionMode),
        sandboxPolicy: sandboxPolicyFor(request.permissionMode),
        model,
        summary: 'auto',
        reasoning_effort: reasoningEffort,
        collaborationMode: { mode: isPlanMode ? 'plan' : 'default', settings: {
          model,
          reasoning_effort: isPlanMode ? 'medium' : reasoningEffort,
          developer_instructions: request.systemPrompt ?? null,
        }}
      }
      const turn = await this.client.request<CodexTurnStartResponse>('turn/start', turnParams)

      handle.turnId = turn.turn.id
      this.sessionByTurn.set(turn.turn.id, threadId)
    } catch (err: any) {
      const sessionId = handle.agentSessionId
      if (sessionId) this.forgetRoutingForSession(sessionId)
      this.finishRun(handle)
      handle._rejectRun(err instanceof Error ? err : new Error(String(err)))
      this.emit('error', sessionId, err instanceof Error ? err : new Error(String(err)))
    }
  }

  private emitThreadSessionInit(
    sessionId: string,
    threadId: string,
    model: string,
    response?: CodexThreadStartResponse,
  ): void {
    this.emit('normalized', sessionId, {
      type: 'session_init',
      sessionId: threadId,
      model: response?.model || model,
      skills: [],
    } satisfies NormalizedEvent)
  }

  override cancelSession(sessionId: string): boolean {
    const handle = this.activeRuns.get(sessionId)
    if (!handle) return false
    handle.abortController.abort()
    handle.interrupted = true
    handle.normalizer.interrupt()
    if (handle.threadId && handle.turnId) {
      this.client.request('turn/interrupt', { threadId: handle.threadId, turnId: handle.turnId }, 10_000)
        .catch((err) => log.warn('turn_interrupt_failed', { error: err.message }))
    }
    return true
  }

  async steerSession(
    sessionId: string,
    options: Pick<PromptOptions, 'prompt' | 'imageAttachments'>,
  ): Promise<RunHandle | null> {
    const handle = this.activeRuns.get(sessionId)
    if (!handle?.threadId || !handle.turnId) return null

    const expectedTurnId = handle.turnId
    // SAFETY: buildTurnInput emits only text, image, and skill items accepted by turn/steer.
    const params: CodexTurnSteerParams = {
      threadId: handle.threadId,
      expectedTurnId,
      input: await this.buildTurnInput(
        options.prompt,
        handle.cwd,
        options.imageAttachments,
      ) as CodexTurnSteerParams['input'],
    }

    try {
      const response = await this.client.request<CodexTurnSteerResponse>('turn/steer', params)
      if (response.turnId !== expectedTurnId) {
        log.warn('steer_turn_mismatch', { turnId: response.turnId, expectedTurnId })
        return null
      }
      log.info('steer_accepted', { sessionId, expectedTurnId })
      return handle
    } catch (error) {
      // The active turn may complete, or enter a non-steerable review/compact
      // turn, between the control-plane check and this request. The caller keeps
      // the input and dispatches it at the next turn boundary.
      if (error instanceof Error && isSteerTurnBoundaryError(error)) {
        log.info('steer_rejected', { sessionId, error: error instanceof Error ? error.message : String(error) })
        return null
      }
      throw error
    }
  }

  protected override _errorMessage(_exitCode: number | null): string {
    return 'Codex run failed'
  }

  shutdown(): void {
    if (this.sessionIndexRefreshTimer) {
      clearTimeout(this.sessionIndexRefreshTimer)
      this.sessionIndexRefreshTimer = null
    }
    this.client.shutdown()
  }

  async listSessions(projectPath?: string, onBatch?: (sessions: SessionMeta[]) => void, limit?: number): Promise<SessionMeta[]> {
    const cacheKey = projectPath?.replace(/\/$/, '') ?? process.cwd()

    const cached = this.sessionListCache.get(cacheKey)
    if (cached) {
      const sessions = limit === undefined ? cached : cached.slice(0, limit)
      onBatch?.(sessions)
      return sessions
    }

    // Picker reads must stay on the local index. The server poll and
    // turn/completed notifications refresh that index independently; awaiting
    // thread/list here blocks the picker and competes with interactive RPCs.
    const sessions = listIndexedCodexSessions(cacheKey, limit)
    if (limit === undefined) this.sessionListCache.set(cacheKey, sessions)
    onBatch?.(sessions)
    return sessions
  }

  async refreshSessionIndex(): Promise<void> {
    // The server's periodic index poll must not turn a Claude-only idle host
    // into a two-process Codex host. Explicit Codex work starts the client; its
    // turn/completed notification then enters this same refresh path.
    if (!this.client.hasStarted) return
    if (this.sessionIndexRefresh) return this.sessionIndexRefresh
    this.sessionIndexRefresh = this.refreshSessionIndexOnce()
    try {
      await this.sessionIndexRefresh
    } finally {
      this.sessionIndexRefresh = null
    }
  }

  /** Coalesce turn-completion index sweeps: a burst of completing turns (parallel
   *  sessions, subagent fan-out) schedules one sweep instead of one per turn. */
  private scheduleSessionIndexRefresh(): void {
    if (this.sessionIndexRefreshTimer) return
    this.sessionIndexRefreshTimer = setTimeout(() => {
      this.sessionIndexRefreshTimer = null
      void this.refreshSessionIndex().catch((err) => {
        log.warn('session_index_refresh_failed', { error: err instanceof Error ? err.message : String(err) })
      })
    }, 2000)
    this.sessionIndexRefreshTimer.unref?.()
  }

  private async refreshSessionIndexOnce(): Promise<void> {
    const watermark = getCodexSessionIndexWatermark()
    const changedThreads: CodexThreadSummary[] = []
    let newestTimestamp = watermark ?? 0
    let cursor: string | null | undefined = null

    do {
      const response: CodexThreadListResponse = await this.client.request('thread/list', {
        cursor,
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        useStateDbOnly: true,
      })
      let oldestTimestamp = Number.POSITIVE_INFINITY
      for (const thread of response.data ?? []) {
        const timestamp = toEpochMs(thread.updatedAt ?? thread.createdAt)
        newestTimestamp = Math.max(newestTimestamp, timestamp)
        oldestTimestamp = Math.min(oldestTimestamp, timestamp)
        if (watermark === null || timestamp >= watermark) changedThreads.push(thread)
      }
      cursor = response.nextCursor
      if (watermark !== null && oldestTimestamp < watermark) break
    } while (cursor)

    const candidates = changedThreads.filter((thread) => thread.id && thread.cwd)
    const candidateIds = candidates.map((thread) => thread.id!)
    const indexedTimestamps = getIndexedCodexSessionTimestamps(candidateIds)
    // Threads whose body is already indexed. A thread is (re)read when its row is
    // new, its activity advanced, OR it has no indexed body yet — the last clause
    // covers a session written at session_init whose init timestamp could sit at
    // or past the thread's reported updatedAt, without trusting clock ordering.
    const withMessages = getCodexSessionsWithMessages(candidateIds)
    const sessions = await Promise.all(
      candidates
        .filter((thread) => {
          const indexedTimestamp = indexedTimestamps.get(thread.id!)
          return indexedTimestamp === undefined ||
            toEpochMs(thread.updatedAt ?? thread.createdAt) > indexedTimestamp ||
            !withMessages.has(thread.id!)
        })
        .map((thread) => this.threadToSessionMeta(thread, thread.cwd!, { scanActivity: false })),
    )
    if (sessions.length > 0) {
      cacheIndexedSessions(sessions)
      this.mergeSessionListCache(sessions)
      const threadsById = new Map(candidates.map((thread) => [thread.id!, thread]))
      const planAnnotations = await loadAllAnnotations()
      // Throttle the thread/read fan-out: a new user's first sweep can span
      // thousands of threads, and reading them all at once spikes the RPC channel.
      await runWithConcurrency(sessions, CODEX_INDEX_READ_CONCURRENCY, async (session) => {
        try {
          const thread = threadsById.get(session.sessionId)
          if (thread) {
            const plans = await scanCodexPlans(thread, planAnnotations)
            replaceIndexedPlansForSession('codex', session.sessionId, plans.map(indexedCodexPlan))
          }
          const response: CodexThreadReadResponse = await this.client.request('thread/read', {
            threadId: session.sessionId,
            includeTurns: true,
          })
          const messages: SessionLoadMessage[] = []
          this.appendCodexTurnMessages(messages, response.thread?.turns ?? [])
          indexSessionMessages(
            session.sessionId,
            'codex',
            messages.filter((message) =>
              (message.role === 'user' || message.role === 'assistant') &&
              message.content.trim(),
            ),
          )
        } catch (err) {
          log.warn('message_index_failed', {
            sessionId: session.sessionId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })
    }
    if (newestTimestamp > 0) setCodexSessionIndexWatermark(newestTimestamp)
    if (sessions.length === 0) return

    this.emit('session-index-updated', {
      provider: 'codex',
      projectPaths: [...new Set(sessions.map((session) => session.cwd))],
      sessionIds: sessions.map((session) => session.sessionId),
    } satisfies SessionIndexUpdatedEvent)
  }

  private mergeSessionListCache(changed: SessionMeta[]): void {
    for (const cacheKey of this.sessionListCache.keys({ includeStale: true })) {
      const existing = this.sessionListCache.getStale(cacheKey) ?? []
      const relevant = changed.filter((session) =>
        codexThreadBelongsToProject({ cwd: session.cwd }, cacheKey),
      )
      if (relevant.length === 0) continue
      const merged = new Map(existing.map((session) => [session.sessionId, session]))
      for (const session of relevant) merged.set(session.sessionId, session)
      this.sessionListCache.set(
        cacheKey,
        [...merged.values()].sort(
          (a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime(),
        ),
      )
    }
  }

  private async threadToSessionMeta(
    thread: CodexThreadSummary,
    projectPath?: string,
    options: { scanActivity?: boolean } = {},
  ): Promise<SessionMeta> {
    const cwd = thread.cwd || projectPath || process.cwd()
    const normalizedCwd = cwd.replace(/\/$/, '')
    const activityTimestamp = options.scanActivity === false
      ? null
      : await scanCodexThreadActivityTimestamp(thread)
    const lastTimestamp = activityTimestamp
      ? new Date(activityTimestamp).toISOString()
      : toIsoTimestamp(thread.updatedAt ?? thread.createdAt)
    const preview = thread.preview?.trim() || null
    const name = thread.name?.trim() || preview
    return {
      provider: 'codex',
      sessionId: thread.id!,
      slug: name,
      firstMessage: preview,
      lastTimestamp,
      size: 0,
      cwd,
      projectPath: encodePathAsFolder(normalizedCwd),
      isWorktree: isSolusWorktreePath(normalizedCwd),
    }
  }

  private async readThread(sessionId: string): Promise<CodexThreadReadResponse | CodexThreadResumeResponse> {
    try {
      return await this.client.request('thread/read', {
        threadId: sessionId,
        includeTurns: true,
      })
    } catch (error) {
      // `thread/read` only reads a thread that app-server already holds in
      // memory. History rows also name dormant threads persisted on disk, so
      // load those through the protocol's disk-backed resume path before the
      // picker asks for their transcript preview.
      if (!(error instanceof Error) || !isThreadNotLoadedError(error)) throw error
      return this.client.request('thread/resume', { threadId: sessionId })
    }
  }

  async loadSession(sessionId: string, _projectPath?: string, limit?: number): Promise<SessionLoadMessage[]> {
    const response = await this.readThread(sessionId)
    return codexTurnsToMessages(response.thread?.turns ?? [], limit)
  }

  private appendCodexTurnMessages(messages: SessionLoadMessage[], turns: CodexTurnHistory[]): void {
    for (const turn of turns) {
      messages.push(...codexTurnToMessages(turn))
    }
  }

  async listPlans(projectPath: string | undefined, allProjects: boolean): Promise<PlanDescriptor[]> {
    if (isPlanIndexComplete('codex')) {
      return listIndexedPlans('codex', projectPath, allProjects)
    }
    const cacheKey = allProjects ? 'all' : projectPath || process.cwd()
    return this.planListCache.getOrLoad(cacheKey, async () => {
      const projectRoot = projectPath?.replace(/\/$/, '')
      const threads = await this.listAllThreads(allProjects ? undefined : projectRoot)
      const annotations = await loadAllAnnotations()
      const scanned: ScannedCodexPlan[] = []

      const candidates = threads.filter((thread) => {
        if (!thread.id) return false
        if (allProjects || !projectRoot) return true
        return thread.cwd?.replace(/\/$/, '') === projectRoot
      })
      await runWithConcurrency(candidates, CODEX_PLAN_SCAN_CONCURRENCY, async (thread) => {
        scanned.push(...await scanCodexPlans(thread, annotations))
      })

      if (allProjects) {
        replaceIndexedPlansForProvider('codex', scanned.map(indexedCodexPlan))
      }
      return groupCodexPlansBySession(scanned)
    })
  }

  invalidatePlanCache(sessionId: string): void {
    this.planListCache.invalidateWhere(
      (_key, descriptors) => descriptors.some((descriptor) => descriptor.sessionId === sessionId),
    )
  }

  async loadPlanContent(sessionId: string, projectPath: string, planToolUseId: string): Promise<string | null> {
    const indexed = loadIndexedPlanContent('codex', sessionId, planToolUseId)
    if (indexed !== null) return indexed
    const threads = await this.listAllThreads(projectPath.replace(/\/$/, ''))
    const thread = threads.find((candidate) => candidate.id === sessionId)
    if (!thread) return null
    const plans = await scanCodexPlans(thread, {})
    return plans.find((plan) => plan.planToolUseId === planToolUseId)?.planContent ?? null
  }

  async getThreadGoal(threadId: string): Promise<ThreadGoal | null> {
    const response = await this.client.request<CodexThreadGoalResponse>('thread/goal/get', { threadId })
    return normalizeThreadGoal(response.goal)
  }

  async setThreadGoal(request: ThreadGoalSetRequest): Promise<ThreadGoal> {
    const response = await this.client.request<CodexThreadGoalResponse>('thread/goal/set', request)
    const goal = normalizeThreadGoal(response.goal)
    if (!goal) throw new Error('Codex thread/goal/set returned an invalid goal')
    return goal
  }

  async clearThreadGoal(threadId: string): Promise<boolean> {
    const response = await this.client.request<CodexThreadGoalClearResponse>('thread/goal/clear', { threadId })
    return response.cleared === true
  }

  async listPluginCommands(workingDirectory: string): Promise<PluginCommandsResult> {
    return this.listCodexSkills(workingDirectory)
  }

  async refreshPluginCommands(): Promise<void> {
    const watchedCwds = this.skillsByCwd.keys({ includeStale: true })
    this.skillsByCwd.clear()
    await Promise.all(watchedCwds.map((cwd) => this.listCodexSkills(cwd, true)))
  }

  async readUsageLimits(): Promise<AgentUsageLimits> {
    const account = await this.client.request('account/read', { refreshToken: false })
    if (account.account?.type === 'apiKey') {
      return {
        provider: this.id,
        fiveHour: null,
        weekly: null,
        planType: null,
        usageMode: 'api',
        fetchedAt: Date.now(),
        stale: false,
      }
    }

    const response = await this.client.request('account/rateLimits/read', {})
    const snapshot = response.rateLimits
    // `primary`/`secondary` carry no fixed meaning — the window duration is the
    // only reliable discriminator, and either slot may be absent entirely.
    const windowOf = (durationMins: number): UsageWindow | null => {
      const match = [snapshot?.primary, snapshot?.secondary]
        .find((window) => window?.windowDurationMins === durationMins)
      if (!match) return null
      return {
        usedPercent: match.usedPercent,
        resetsAt: match.resetsAt === null ? null : match.resetsAt * 1000,
        resetsLabel: null,
      }
    }
    return {
      provider: this.id,
      fiveHour: windowOf(300),
      weekly: windowOf(10080),
      planType: snapshot?.planType ?? null,
      usageMode: 'subscription',
      fetchedAt: Date.now(),
      stale: false,
    }
  }

  private onNotification(msg: JsonRpcNotification): void {
    const params = msg.params || {}
    let sessionId = this.sessionIdFor(params)
    this.logRawProviderMessage('notification', msg, sessionId, params)

    if (msg.method === 'skills/changed') {
      void this.refreshPluginCommands()
      return
    }

    if (msg.method === 'serverRequest/resolved') {
      const resolved = this.permissionResponder().resolveServerRequest(params?.requestId || params?.id)
      if (resolved) {
        this.emit('normalized', resolved.sessionId, {
          type: 'permission_resolved',
          questionId: resolved.questionId,
        } satisfies NormalizedEvent)
      }
      return
    }

    if (!sessionId && msg.method === 'error' && this.activeRuns.size === 1) {
      sessionId = this.activeRuns.keys().next().value || null
    }
    if (!sessionId && msg.method === 'account/rateLimits/updated') {
      this.emitAccountRateLimitUpdate(params)
      return
    }
    if (!sessionId) return

    const handle = this.activeRuns.get(sessionId)
    this.rememberSessionRouting(params, sessionId)

    if (msg.method === 'thread/started') return

    this.cacheFileChanges(params)
    if (msg.method === 'turn/diff/updated' && handle) {
      this.emit('normalized', sessionId, {
        type: 'session_changed_files_updated',
        paths: this.updateTrackedFilesFromTurnDiff(handle, params?.diff),
      })
    }
    const wasInterrupted = !!handle?.interrupted || isInterruptedTurnStatus(params?.turn?.status)

    const normalized = handle?.normalizer.push({ method: msg.method, params }) ?? []
    if (handle) {
      handle.toolCallCount = handle.normalizer.summary.toolCallCount
    }

    if (msg.method === 'turn/completed') {
      const eventThreadId = optionalString(params?.threadId)
      const isChildTurn = !!handle && !!eventThreadId && eventThreadId !== handle.threadId
      if (isChildTurn) {
        for (const event of normalized) this.emit('normalized', sessionId, event)
        this.sessionByChildThread.delete(eventThreadId)
        return
      }
      // A turn just created or updated a thread — drop the cached session lists
      // the thread can appear in so the next listSessions reflects the new
      // activity. Other projects' lists stay warm, and the index sweep is
      // coalesced so a burst of completing turns pays for one sweep, not one each.
      if (handle?.persistent) {
        this.sessionListCache.invalidateWhere((cacheKey) =>
          codexThreadBelongsToProject({ cwd: handle.cwd }, cacheKey),
        )
        this.scheduleSessionIndexRefresh()
      }
      const sawRateLimit = handle?.normalizer.summary.sawRateLimit ?? false
      const exitCode = params?.turn?.status === 'failed' && !sawRateLimit ? 1 : wasInterrupted ? null : 0
      const exitSignal = wasInterrupted ? 'SIGINT' : null
      if (handle) {
        void this.finishCompletedTurn(
          handle,
          normalized,
          wasInterrupted,
          exitCode,
          exitSignal,
          params?.turnId || params?.turn?.id,
        )
        return
      }
      this.clearFileChangesForTurn(params?.turnId || params?.turn?.id)
      this.permissions.clearPendingForSession(sessionId)
      this.emit('exit', sessionId, exitCode, exitSignal)
      return
    }

    for (const event of normalized) this.emit('normalized', sessionId, event)
  }

  private emitAccountRateLimitUpdate(params: any): void {
    for (const [sessionId, handle] of this.activeRuns) {
      if (handle.interrupted) continue
      for (const event of handle.normalizer.push({ method: 'account/rateLimits/updated', params })) {
        this.emit('normalized', sessionId, event)
      }
    }
  }

  private cacheFileChanges(params: any): void {
    const itemId = optionalString(params?.itemId) ?? optionalString(params?.item?.id)
    const changes = Array.isArray(params?.changes)
      ? params.changes
      : params?.item?.type === 'fileChange' && Array.isArray(params.item.changes)
        ? params.item.changes
        : null

    if (itemId && changes) {
      this.fileChangesByItem.set(itemId, changes)
      const turnId = optionalString(params?.turnId)
      if (turnId) this.fileChangeTurnByItem.set(itemId, turnId)
    }
  }

  private updateTrackedFilesFromTurnDiff<T>(handle: CodexRunHandle, diff: T): string[] {
    handle.turnDiffFiles.clear()
    for (const filePath of extractCodexChangedFilePaths(diff)) {
      handle.turnDiffFiles.add(filePath)
    }

    handle.trackedFiles.clear()
    for (const filePath of handle.baseChangedFiles) {
      handle.trackedFiles.add(filePath)
    }
    for (const filePath of handle.turnDiffFiles) {
      handle.trackedFiles.add(filePath)
    }
    return [...handle.trackedFiles]
  }

  private clearFileChangesForTurn<T>(value: T): void {
    const turnId = optionalString(value)
    if (!turnId) return
    for (const [itemId, itemTurnId] of this.fileChangeTurnByItem) {
      if (itemTurnId === turnId) {
        this.fileChangesByItem.delete(itemId)
        this.fileChangeTurnByItem.delete(itemId)
      }
    }
  }

  private onServerRequest(msg: JsonRpcRequest): void {
    const params: any = msg.params || {}

    const sessionId = this.sessionIdFor(params)
    this.logRawProviderMessage('server-request', msg, sessionId, params)
    if (!sessionId) {
      this.client.respond(msg.id, denialResponse(msg.method))
      return
    }

    const handle = this.activeRuns.get(sessionId)
    this.rememberSessionRouting(params, sessionId)
    this.cacheFileChanges(params)

    if (msg.method === 'item/tool/call') {
      const toolName = optionalString(params?.tool)
        ?? optionalString(params?.tool?.name)
        ?? optionalString(params?.name)
        ?? optionalString(params?.toolName)
        ?? ''
      const respondWithToolText = (text: string, success: boolean) => {
        this.client.respond(msg.id, { success, contentItems: [{ type: 'inputText', text }] })
      }
      let args = params?.arguments ?? params?.input ?? params?.args ?? {}
      const serializedArgs = optionalString(args)
      if (serializedArgs !== undefined) {
        try { args = JSON.parse(serializedArgs) } catch { args = {} }
      }
      const selectedTool = handle?.toolDispatcher.get(toolName)
      if (!selectedTool || !handle) {
        respondWithToolText(toolName ? `Unsupported dynamic tool: ${bareAgentToolName(toolName)}` : 'Unsupported dynamic tool call.', false)
        return
      }
      const respondWithResult = async (approved: boolean) => {
        if (!approved) {
          respondWithToolText(`The user declined ${selectedTool.name}.`, false)
          return
        }
        const parentToolUseId = optionalString(params?.callId) || String(msg.id)
        const result = await handle.toolDispatcher.execute(toolName, args, parentToolUseId)
        respondWithToolText(result.text, result.ok)
      }
      if (!selectedTool.requiresApproval) { void respondWithResult(true); return }
      if (handle.permissionMode === 'plan') {
        respondWithToolText(`Cannot run ${selectedTool.name} in plan mode. Exit plan mode to apply changes.`, false)
        return
      }
      if (handle.permissionMode === 'auto') { void respondWithResult(true); return }

      handle.sawPermissionRequest = true
      const questionId = `codex-${String(msg.id)}`
      this.permissionResponder().add(questionId, { id: msg.id, method: 'item/tool/call', params, sessionId, execute: respondWithResult })
      const parsedToolInput = z.record(z.string(), z.json()).safeParse(args)
      this.emit('normalized', sessionId, {
        type: 'permission_request',
        questionId,
        toolName: selectedTool.name,
        toolDescription: selectedTool.description,
        toolInput: parsedToolInput.success ? parsedToolInput.data : {},
        options: [
          { id: 'accept', label: 'Allow', kind: 'allow' },
          { id: 'decline', label: 'Deny', kind: 'deny' },
        ],
        ...(typeof params?.startedAtMs === 'number' ? { startedAtMs: params.startedAtMs } : {}),
      })
      return
    }

    if (msg.method === 'item/tool/requestUserInput' || msg.method === 'mcpServer/elicitation/request') {
      const questionId = `codex-${String(msg.id)}`
      this.permissionResponder().add(questionId, { id: msg.id, method: msg.method, params, sessionId })
      const elicitation = msg.method === 'mcpServer/elicitation/request'
        ? normalizeMcpElicitationRequest(params)
        : null
      this.emit('normalized', sessionId, {
        type: 'question_request',
        questionId,
        questions: elicitation?.questions ?? normalizeQuestionItems(params),
        ...elicitation?.request,
      })
      return
    }

    if (handle?.permissionMode === 'auto') {
      log.info('permission_auto_approved', { method: msg.method })
      this.client.respond(msg.id, autoApprovalResponse(msg.method, params))
      return
    }

    if (handle?.permissionMode === 'plan') {
      log.info('permission_declined_plan_mode', { method: msg.method })
      this.client.respond(msg.id, denialResponse(msg.method))
      return
    }

    if (handle) handle.sawPermissionRequest = true

    const questionId = `codex-${String(msg.id)}`
    this.permissionResponder().add(questionId, { id: msg.id, method: msg.method, params, sessionId })
    this.emit('normalized', sessionId, {
      type: 'permission_request',
      questionId,
      toolName: permissionToolName(msg.method, params),
      toolDescription: permissionDescription(msg.method, params),
      toolInput: this.permissionToolInput(msg.method, params),
      options: permissionOptions(msg.method, params),
      ...(typeof params?.startedAtMs === 'number' ? { startedAtMs: params.startedAtMs } : {}),
    })
  }

  private logRawProviderMessage(
    kind: 'notification' | 'server-request',
    msg: JsonRpcNotification | JsonRpcRequest,
    sessionId: string | null,
    params: any,
  ): void {
    // Gated out in production (debug level off). Skip before touching `msg` so we
    // never build the per-event payload — this runs for every Codex notification.
    if (!isDebugEnabled) return
    if (isNormalStreamingTextNotification(kind, msg, params)) return

    const handle = sessionId ? this.activeRuns.get(sessionId) : undefined
    log.debug('raw_provider_event', {
      provider: 'codex',
      kind,
      sessionId: params?.threadId || handle?.agentSessionId || handle?.threadId || sessionId || null,
      turnId: params?.turnId || params?.turn?.id || handle?.turnId || null,
      event: msg,
    })
  }

  private permissionToolInput(method: string, params: any): object {
    if (method !== 'item/fileChange/requestApproval') return params
    const itemId = optionalString(params?.itemId)
    const changes = itemId ? this.fileChangesByItem.get(itemId) : undefined
    return changes?.length ? { ...params, changes } : params
  }

  private async initSnapshots(handle: CodexRunHandle, sessionId: string): Promise<void> {
    const workTree = handle.workTree
    if (!workTree || workTree === '~') return
    try {
      const repoRoot = await resolveRepoRoot(workTree)
      if (!repoRoot) return
      handle.repoRoot = repoRoot
      const head = getHeadCommit(workTree)
      if (!head) return
      await initSessionBase(repoRoot, sessionId, head)
    } catch (e) {
      log.warn('init_snapshots_failed', { error: e instanceof Error ? e.message : String(e) })
    }
  }

  private async snapshotOnTurnComplete(handle: CodexRunHandle, partial: boolean): Promise<string[] | null> {
    const { workTree, repoRoot, agentSessionId: sessionId } = handle
    if (!workTree || !repoRoot || !sessionId) return null
    try {
      const result = await snapshotTurn(workTree, repoRoot, sessionId, {
        partial,
        userMessagePreview: handle.userMessagePreview,
        sessionChangedFiles: [...handle.trackedFiles],
      })
      return result?.sessionChangedFiles ?? null
    } catch (e) {
      log.warn('snapshot_on_turn_complete_failed', { error: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  private async finishCompletedTurn<T>(
    handle: CodexRunHandle,
    normalized: NormalizedEvent[],
    partial: boolean,
    exitCode: 0 | 1 | null,
    exitSignal: 'SIGINT' | null,
    turnId: T,
  ): Promise<void> {
    const sessionId = handle.agentSessionId
    const changedFiles = handle.persistent
      ? await this.snapshotOnTurnComplete(handle, partial)
      : null
    if (changedFiles) {
      this.emit('normalized', sessionId, { type: 'session_changed_files_updated', paths: changedFiles })
    }
    for (const event of normalized) this.emit('normalized', sessionId, event)
    this.forgetRoutingForSession(sessionId)
    this.finishRun(handle)
    handle._resolveRun()
    this.clearFileChangesForTurn(turnId)
    this.permissions.clearPendingForSession(sessionId)
    this.emit('exit', sessionId, exitCode, exitSignal)
  }

  private sessionIdFor(params: any): string | null {
    // Root thread IDs are session IDs; spawned child threads route back to the
    // active parent session that owns their transcript card.
    const threadId = optionalString(params?.threadId)
    if (threadId) {
      if (this.activeRuns.has(threadId)) return threadId
      return this.sessionByChildThread.get(threadId) ?? null
    }
    const turnId = params?.turnId
    if (turnId) return this.sessionByTurn.get(turnId) ?? null
    const itemId = this.codexItemId(params)
    if (itemId) return this.sessionByItem.get(itemId) ?? null
    // If only one active run, route to it (same heuristic as before)
    if (this.activeRuns.size === 1) return this.activeRuns.keys().next().value || null
    return null
  }

  private rememberSessionRouting(params: any, sessionId: string): void {
    const turnId = optionalString(params?.turnId) ?? optionalString(params?.turn?.id)
    if (turnId) this.sessionByTurn.set(turnId, sessionId)

    const itemId = this.codexItemId(params)
    if (itemId) this.sessionByItem.set(itemId, sessionId)

    for (const link of codexSpawnedThreadLinks(params?.item)) {
      this.sessionByChildThread.set(link.threadId, sessionId)
    }
  }

  private codexItemId(params: any): string | null {
    return optionalString(params?.itemId) ?? optionalString(params?.item?.id) ?? null
  }

  private forgetRoutingForSession(sessionId: string): void {
    for (const [turnId, owner] of this.sessionByTurn) {
      if (owner === sessionId) this.sessionByTurn.delete(turnId)
    }
    for (const [itemId, owner] of this.sessionByItem) {
      if (owner === sessionId) this.sessionByItem.delete(itemId)
    }
    for (const [threadId, owner] of this.sessionByChildThread) {
      if (owner === sessionId) this.sessionByChildThread.delete(threadId)
    }
  }

  private resolveModel(model: string | null | undefined): string {
    if (model && this.metadata.models.some((m) => m.id === model)) return model
    return this.metadata.defaultModel
  }

  private async buildTurnInput(prompt: string, workingDirectory: string, imageAttachments?: CodexImageAttachment[]): Promise<CodexTurnInputItem[]> {
    const skill = await this.skillForPrompt(prompt, workingDirectory)
    const textItem = {
      type: 'text' as const,
      text: skill ? this.codexSkillPrompt(prompt, skill.name) : prompt,
      text_elements: [],
    }
    const input: CodexTurnInputItem[] = [
      textItem,
      ...this.imageInputItems(imageAttachments),
    ]
    if (!skill) return input

    if (skill.path) input.push({ type: 'skill', name: skill.name, path: skill.path })
    return input
  }

  private imageInputItems(imageAttachments: CodexImageAttachment[] | undefined): CodexTurnInputItem[] {
    if (!imageAttachments?.length) return []
    return imageAttachments
      .map((image) => this.imageInputItem(image))
      .filter((item): item is CodexTurnInputItem => !!item)
  }

  private imageInputItem(image: CodexImageAttachment): CodexTurnInputItem | null {
    const match = image.dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i)
    if (!match) return null
    return {
      type: 'image',
      url: image.dataUrl,
    }
  }

  private async skillForPrompt(prompt: string, workingDirectory: string): Promise<{ name: string; path?: string } | null> {
    const match = prompt.match(/(^|\n\n)\s*\/([a-zA-Z0-9][a-zA-Z0-9-]*)(?=\s|$)/)
    if (!match) return null

    const requested = match[2]
    const commands = await this.listCodexSkills(workingDirectory)
    const command = [...commands.project, ...commands.global].find((candidate) => (
      candidate.kind === 'skill' &&
      candidate.name === requested
    ))
    return command ? { name: command.name, path: command.path } : null
  }

  private codexSkillPrompt(prompt: string, skillName: string): string {
    return prompt.replace(/(^|\n\n)(\s*)\/([a-zA-Z0-9][a-zA-Z0-9-]*)(?=\s|$)/, (_match, prefix: string, spacing: string) => `${prefix}${spacing}$${skillName}`)
  }

  private async listCodexSkills(workingDirectory: string, forceReload = false): Promise<PluginCommandsResult> {
    const cacheKey = workingDirectory
    const cached = forceReload ? undefined : this.skillsByCwd.get(cacheKey)
    if (cached) return cached

    let response: CodexSkillsListResponse
    try {
      response = await this.client.request<CodexSkillsListResponse>('skills/list', {
        cwds: [workingDirectory],
        forceReload,
      })
    } catch (err) {
      log.warn('skills_list_failed', { error: err instanceof Error ? err.message : String(err) })
      return { global: [], project: [] }
    }
    const cwdResult = (response.data ?? []).find((entry) => entry.cwd === workingDirectory) ?? response.data?.[0]
    const commands = {
      global: (cwdResult?.skills ?? [])
        .flatMap((skill) => skill.enabled !== false && skill.name ? [{
          name: skill.name,
          description: skill.interface?.shortDescription || skill.description || '',
          argumentHint: skill.interface?.defaultPrompt,
          kind: 'skill' as const,
          path: skill.path,
        }] : []),
      project: [],
    }
    this.skillsByCwd.set(cacheKey, commands)
    return commands
  }

  private async listAllThreads(cwd?: string): Promise<CodexThreadSummary[]> {
    const threads: CodexThreadSummary[] = []
    let cursor: string | null | undefined = null

    do {
      const request = {
        cursor,
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
      }
      if (cwd) Object.assign(request, { cwd })
      const response: CodexThreadListResponse = await this.client.request('thread/list', request)
      threads.push(...(response.data ?? []))
      cursor = response.nextCursor
    } while (cursor)

    return threads
  }
}

function indexedCodexPlan(plan: ScannedCodexPlan): IndexedPlanInput {
  return {
    provider: 'codex',
    sessionId: plan.sessionId,
    planToolUseId: plan.planToolUseId,
    projectPath: plan.projectPath,
    cwd: plan.cwd,
    timestamp: plan.timestamp,
    title: plan.title,
    excerpt: plan.excerpt,
    content: plan.planContent,
    derivedStatus: plan.derivedStatus,
  }
}
