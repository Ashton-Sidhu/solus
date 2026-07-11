import { existsSync } from 'node:fs'
import { BaseAgentBackend } from '../base-backend'
import { getCodexAppServerClient, isHeadlessCodexThread } from './codex-agent'
import { encodePathAsFolder } from '../utils'
import { createLogger, isDebugEnabled } from '../../logger'
import { loadAllAnnotations } from '../../plans/annotations'
import { getHeadCommit } from '../../git/worktree-manager'
import { resolveRepoRoot } from '../../git/git-helpers'
import { initSessionBase, snapshotTurn } from '../../git/session-snapshots'
import type { AgentBackend, PermissionResponder, RunHandle } from '../agent-backend'
import type {
  AgentId,
  AgentMetadata,
  NormalizedEvent,
  PlanDescriptor,
  PluginCommandsResult,
  PromptOptions,
  SessionMeta,
  SessionIndexUpdatedEvent,
  SessionRunInput,
  ThreadGoal,
  ThreadGoalSetRequest,
} from '../../../shared/types'
import type { SessionLoadMessage } from '../../../shared/session-history'
import { MODEL_PROFILES } from '../../../shared/types'
import { MemoryCache } from '../../../shared/cache'
import {
  cacheIndexedSessions,
  getCodexSessionIndexWatermark,
  getIndexedCodexSessionTimestamps,
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
  CodexThreadStartParams,
  CodexThreadStartResponse,
  CodexTurnStartParams,
  CodexTurnStartResponse,
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
  codexItemToMessage,
  codexThreadBelongsToProject,
  extractCodexChangedFilePaths,
  groupCodexPlansBySession,
  hasUpdatePlanMessage,
  insertMessageByTimestamp,
  isInterruptedTurnStatus,
  isNormalStreamingTextNotification,
  isSolusWorktreePath,
  latestCodexUpdatePlanMessageFromJsonl,
  sandboxPolicyFor,
  scanCodexPlans,
  scanCodexThreadActivityTimestamp,
  toEpochMs,
  toIsoTimestamp,
  type CodexThreadSummary,
  type CodexTurnHistory,
  type ScannedCodexPlan,
} from './codex-utils'
import { buildSystemPrompt } from '../system-hint'
import { isWorkspacePath } from '../../workspace'
import {
  classifyCodexSolusTool,
  executeCodexSolusTool,
  codexSolusToolSchemas,
  bareToolName,
  type CodexSolusToolCtx,
  type CodexSolusToolKind,
} from './codex-solus-tools'
import { executeCodexReviewGuideTool, SUBMIT_REVIEW_GUIDE_TOOL_NAME } from '../../review/review-guide-tool'

const log = createLogger('CodexBackend', 'codex-backend.ts')

// Per-kind copy for the permission UI when a mutating solus tool gates. Only the
// mutating kinds (work/automation/task) reach these paths; the rest are covered
// for exhaustiveness.
const SOLUS_TOOL_DECLINE_TEXT: Record<CodexSolusToolKind, string> = {
  work: 'The user declined this update.',
  automation: 'The user declined this automation action.',
  task: 'The user declined this task action.',
  session: 'The user declined this action.',
  pr: 'The user declined this PR review action.',
  artifact: 'The user declined this action.',
  record_change: 'The user declined this action.',
}
const SOLUS_TOOL_PLAN_BLOCK_TEXT: Record<CodexSolusToolKind, string> = {
  work: 'Cannot modify works in plan mode. Exit plan mode to apply changes.',
  automation: 'Cannot modify automations in plan mode. Exit plan mode to apply changes.',
  task: 'Cannot change task status in plan mode. Exit plan mode to apply changes.',
  session: 'Cannot do this in plan mode. Exit plan mode to apply changes.',
  pr: 'Cannot modify PR review state in plan mode. Exit plan mode to apply changes.',
  artifact: 'Cannot do this in plan mode. Exit plan mode to apply changes.',
  record_change: 'Cannot do this in plan mode. Exit plan mode to apply changes.',
}
const SOLUS_TOOL_GATE_DESC: Record<CodexSolusToolKind, string> = {
  work: 'Update a work the user has open',
  automation: 'Create, modify, or run an automation',
  task: "Update a task's status",
  session: 'Create a session',
  pr: 'Modify PR review state',
  artifact: 'Render an artifact',
  record_change: 'Record a change',
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
  private fileChangesByItem = new Map<string, unknown[]>()
  private fileChangeTurnByItem = new Map<string, string>()
  private skillsByCwd = new MemoryCache<string, PluginCommandsResult>({ ttlMs: 5 * 60 * 1000 })
  /** Per-cwd hot cache over the persistent session index. Codex has no files to
   *  stat, so refresh with a TTL and clear on turn completion, which is when a
   *  thread is created or its activity changes. */
  private sessionListCache = new MemoryCache<string, SessionMeta[]>({ ttlMs: 5 * 60 * 1000 })
  private sessionIndexRefresh: Promise<void> | null = null
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
        this.emit('error', handle.sessionId, exitErr)
      }
    })
  }

  startRun(runInput: SessionRunInput, options: PromptOptions): RunHandle {
    const abortController = new AbortController()
    const workTree = runInput.gitContext?.worktreePath ?? runInput.workingDirectory

    let _resolveRun!: () => void
    let _rejectRun!: (err: Error) => void
    const runPromise = new Promise<void>((res, rej) => { _resolveRun = res; _rejectRun = rej })

    const handle: CodexRunHandle = {
      sessionId: runInput.agentSessionId,
      tabId: runInput.tabId,
      sourceTabId: runInput.tabId,
      threadId: runInput.agentSessionId,
      turnId: null,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController,
      runPromise,
      _resolveRun,
      _rejectRun,
      permissionMode: runInput.permissionMode,
      interrupted: false,
      normalizer: new CodexTurnNormalizer({ planMode: runInput.permissionMode === 'plan' }),
      workTree,
      repoRoot: null as string | null,
      cwd: runInput.workingDirectory,
      userMessagePreview: (options.prompt ?? '').slice(0, 80),
      baseChangedFiles: new Set(runInput.changedFiles),
      turnDiffFiles: new Set(),
      trackedFiles: new Set(runInput.changedFiles),
    }

    this.pendingRuns.push(handle)
    void this.run(handle, runInput, options)
    return handle
  }

  private async run(
    handle: CodexRunHandle,
    runInput: SessionRunInput,
    options: PromptOptions,
  ): Promise<void> {
    try {
      let threadId = handle.threadId
      const model = this.resolveModel(runInput.model)
      const general = isWorkspacePath(runInput.workingDirectory)
      const developerInstructions = buildSystemPrompt({
        agent: 'codex',
        general,
        extraInstructions: runInput.extraInstructions,
        modelInstructions: runInput.modelInstructions,
        prReview: runInput.prReview,
      })
      const threadConfig: CodexThreadStartParams = {
        model,
        cwd: runInput.workingDirectory,
        approvalPolicy: approvalPolicyFor(runInput.permissionMode),
        baseInstructions: options.systemPrompt ?? null,
        developerInstructions,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      }
      // Dynamic tools (list/read/update_work) are an experimental app-server
      // capability — include them unless a prior start rejected them.
      const toolsConfig = this.dynamicToolsUnavailable
        ? threadConfig
        : { ...threadConfig, dynamicTools: codexSolusToolSchemas({ includeAutomationTools: true }) }

      const reasoningEffort = runInput.reasoningEffort ?? 'high'

      let response: CodexThreadStartResponse
      if (runInput.forked && threadId) {
        response = await this.client.request<CodexThreadStartResponse>('thread/fork', { threadId })
        threadId = response.thread.id
      } else if (!threadId) {
        try {
          response = await this.client.request<CodexThreadStartResponse>('thread/start', { ...toolsConfig, reasoning_effort: reasoningEffort })
        } catch (err: any) {
          if (this.dynamicToolsUnavailable) throw err
          // Retry once without dynamicTools — the agent loses work tools this run.
          log.warn(`thread/start rejected dynamicTools, retrying without: ${err?.message ?? err}`)
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

      ;(this.permissions as CodexPermissionResponder).setCurrentSessionId(threadId)
      this.emitThreadSessionInit(threadId, threadId, model, response)

      await this.initSnapshots(handle, threadId)

      if (handle.abortController.signal.aborted) {
        this.emit('exit', threadId, null, 'SIGINT')
        return
      }

      const isPlanMode = runInput.permissionMode === 'plan'
      const input = await this.buildTurnInput(options.prompt, runInput.workingDirectory, options.imageAttachments)
      const turnParams: CodexTurnStartParams = {
        threadId,
        input,
        cwd: runInput.workingDirectory,
        approvalPolicy: approvalPolicyFor(runInput.permissionMode),
        sandboxPolicy: sandboxPolicyFor(runInput.permissionMode),
        model,
        reasoning_effort: reasoningEffort,
        collaborationMode: { mode: isPlanMode ? 'plan' : 'default', settings: {
          model,
          reasoning_effort: isPlanMode ? 'medium' : reasoningEffort,
          developer_instructions: buildSystemPrompt({
            agent: 'codex',
            general,
            extraInstructions: runInput.extraInstructions,
            modelInstructions: runInput.modelInstructions,
            planMode: isPlanMode,
            prReview: runInput.prReview,
          }),
        }}
      }
      const turn = await this.client.request<CodexTurnStartResponse>('turn/start', turnParams)

      handle.turnId = turn.turn.id
      this.sessionByTurn.set(turn.turn.id, threadId)
    } catch (err: any) {
      const sessionId = handle.sessionId
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
        .catch((err) => log.warn(`Codex turn interrupt failed: ${err.message}`))
    }
    return true
  }

  protected override _errorMessage(_exitCode: number | null): string {
    return 'Codex run failed'
  }

  shutdown(): void {
    this.client.shutdown()
  }

  async listSessions(projectPath?: string, onBatch?: (sessions: SessionMeta[]) => void): Promise<SessionMeta[]> {
    const projectRoot = projectPath?.replace(/\/$/, '')
    const cacheKey = projectRoot ?? process.cwd()

    const cached = this.sessionListCache.get(cacheKey)
    if (cached) {
      onBatch?.(cached)
      return cached
    }

    const persisted = listIndexedCodexSessions(cacheKey)
    if (persisted.length > 0) onBatch?.(persisted)

    try {
      const sessions: SessionMeta[] = []
      let cursor: string | null | undefined = null

      do {
        const response: CodexThreadListResponse = await this.client.request('thread/list', {
          cursor,
          sortDirection: 'desc',
        })
        const batch = await Promise.all((response.data ?? [])
          .filter((thread) => thread.id && codexThreadBelongsToProject(thread, projectRoot))
          .map((thread) => this.threadToSessionMeta(thread, projectPath)))

        if (batch.length > 0) {
          sessions.push(...batch)
          onBatch?.(batch)
        }
        cursor = response.nextCursor
      } while (cursor)

      sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime())
      cacheIndexedSessions(sessions)
      this.sessionListCache.set(cacheKey, sessions)
      return sessions
    } catch (error) {
      if (persisted.length > 0) return persisted
      throw error
    }
  }

  async refreshSessionIndex(): Promise<void> {
    if (this.sessionIndexRefresh) return this.sessionIndexRefresh
    this.sessionIndexRefresh = this.refreshSessionIndexOnce()
    try {
      await this.sessionIndexRefresh
    } finally {
      this.sessionIndexRefresh = null
    }
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
    const indexedTimestamps = getIndexedCodexSessionTimestamps(
      candidates.map((thread) => thread.id!),
    )
    const sessions = await Promise.all(
      candidates
        .filter((thread) => {
          const indexedTimestamp = indexedTimestamps.get(thread.id!)
          return indexedTimestamp === undefined ||
            toEpochMs(thread.updatedAt ?? thread.createdAt) > indexedTimestamp
        })
        .map((thread) => this.threadToSessionMeta(thread, thread.cwd!, { scanActivity: false })),
    )
    if (sessions.length > 0) {
      cacheIndexedSessions(sessions)
      this.mergeSessionListCache(sessions)
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

  async loadSession(sessionId: string, _projectPath?: string, limit?: number): Promise<SessionLoadMessage[]> {
    const response: CodexThreadReadResponse = await this.client.request('thread/read', {
      threadId: sessionId,
      includeTurns: true,
    })
    const messages: SessionLoadMessage[] = []
    this.appendCodexTurnMessages(messages, response.thread?.turns ?? [])
    const full = await this.withLatestUpdatePlanMessage(sessionId, messages)
    return limit && limit > 0 && full.length > limit ? full.slice(-limit) : full
  }

  private appendCodexTurnMessages(messages: SessionLoadMessage[], turns: CodexTurnHistory[]): void {
    for (const turn of turns) {
      const timestamp = toEpochMs(turn.startedAt)
      for (const item of turn.items ?? []) {
        const msg = codexItemToMessage(item, timestamp)
        if (msg) messages.push(msg)
      }
    }
  }

  private async withLatestUpdatePlanMessage(sessionId: string, messages: SessionLoadMessage[]): Promise<SessionLoadMessage[]> {
    const latestUpdatePlan = await this.loadLatestUpdatePlanMessage(sessionId)
    if (latestUpdatePlan && !hasUpdatePlanMessage(messages, latestUpdatePlan)) {
      insertMessageByTimestamp(messages, latestUpdatePlan)
    }

    return messages
  }

  private async loadLatestUpdatePlanMessage(sessionId: string): Promise<SessionLoadMessage | null> {
    try {
      const threads = await this.listAllThreads()
      const thread = threads.find((candidate) => candidate.id === sessionId)
      if (!thread?.path || !existsSync(thread.path)) return null
      return await latestCodexUpdatePlanMessageFromJsonl(thread.path)
    } catch (err: any) {
      log.warn(`Failed to synthesize Codex update_plan history for ${sessionId}: ${err?.message || err}`)
      return null
    }
  }

  async listPlans(projectPath: string | undefined, allProjects: boolean): Promise<PlanDescriptor[]> {
    const threads = await this.listAllThreads()
    const projectRoot = projectPath?.replace(/\/$/, '')
    const annotations = await loadAllAnnotations()
    const scanned: ScannedCodexPlan[] = []

    await Promise.all(
      threads
        .filter((thread) => {
          if (!thread.id) return false
          if (allProjects || !projectRoot) return true
          return thread.cwd?.replace(/\/$/, '') === projectRoot
        })
        .map(async (thread) => {
          scanned.push(...await scanCodexPlans(thread, annotations))
        }),
    )

    const groupedPlans = groupCodexPlansBySession(scanned)

    return groupedPlans
  }

  async loadPlanContent(sessionId: string, _projectPath: string, planToolUseId: string): Promise<string | null> {
    const threads = await this.listAllThreads()
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

  private onNotification(msg: JsonRpcNotification): void {
    const params = msg.params || {}
    let sessionId = this.sessionIdFor(params)
    this.logRawProviderMessage('notification', msg, sessionId, params)

    if (msg.method === 'skills/changed') {
      void this.refreshPluginCommands()
      return
    }

    if (msg.method === 'serverRequest/resolved') {
      const resolved = (this.permissions as CodexPermissionResponder).resolveServerRequest(params?.requestId || params?.id)
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
        type: 'changed_files_updated',
        paths: this.updateTrackedFilesFromTurnDiff(handle, params?.diff),
      })
    }
    const wasInterrupted = !!handle?.interrupted || isInterruptedTurnStatus(params?.turn?.status)

    if (handle) {
      for (const event of handle.normalizer.push({ method: msg.method, params })) {
        this.emit('normalized', sessionId, event)
      }
      handle.toolCallCount = handle.normalizer.summary.toolCallCount
    }

    if (msg.method === 'turn/completed') {
      // A turn just created or updated a thread — drop the cached session lists
      // so the next listSessions reflects the new activity.
      this.sessionListCache.clear()
      void this.refreshSessionIndex().catch((err) => {
        log.warn(`Codex session index refresh failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      const sawRateLimit = handle?.normalizer.summary.sawRateLimit ?? false
      const exitCode = params?.turn?.status === 'failed' && !sawRateLimit ? 1 : wasInterrupted ? null : 0
      const exitSignal = wasInterrupted ? 'SIGINT' : null
      if (handle) {
        void this.snapshotOnTurnComplete(handle, wasInterrupted)
        this.forgetRoutingForSession(sessionId)
        this.finishRun(handle)
        handle._resolveRun()
      }
      this.clearFileChangesForTurn(params?.turnId || params?.turn?.id)
      this.permissions.clearPendingForSession(sessionId)
      this.emit('exit', sessionId, exitCode, exitSignal)
    }
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
    const itemId = typeof params?.itemId === 'string' ? params.itemId : params?.item?.id
    const changes = Array.isArray(params?.changes)
      ? params.changes
      : params?.item?.type === 'fileChange' && Array.isArray(params.item.changes)
        ? params.item.changes
        : null

    if (itemId && changes) {
      this.fileChangesByItem.set(itemId, changes)
      if (typeof params?.turnId === 'string') this.fileChangeTurnByItem.set(itemId, params.turnId)
    }
  }

  private updateTrackedFilesFromTurnDiff(handle: CodexRunHandle, diff: unknown): string[] {
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

  private clearFileChangesForTurn(turnId: unknown): void {
    if (typeof turnId !== 'string') return
    for (const [itemId, itemTurnId] of this.fileChangeTurnByItem) {
      if (itemTurnId === turnId) {
        this.fileChangesByItem.delete(itemId)
        this.fileChangeTurnByItem.delete(itemId)
      }
    }
  }

  private onServerRequest(msg: JsonRpcRequest): void {
    const params: any = msg.params || {}

    if (msg.method === 'item/tool/call') {
      const toolName = String(
        typeof params?.tool === 'string'
          ? params.tool
          : params?.tool?.name ?? params?.name ?? params?.toolName ?? '',
      )
      if (toolName === SUBMIT_REVIEW_GUIDE_TOOL_NAME || toolName.endsWith(`.${SUBMIT_REVIEW_GUIDE_TOOL_NAME}`)) {
        const threadId = typeof params?.threadId === 'string' ? params.threadId : ''
        let rawArgs: unknown = params?.arguments ?? params?.input ?? params?.args ?? {}
        if (typeof rawArgs === 'string') { try { rawArgs = JSON.parse(rawArgs) } catch { rawArgs = {} } }
        const result = threadId
          ? executeCodexReviewGuideTool(threadId, rawArgs)
          : { ok: false, text: 'submit_review_guide requires a Codex thread id.' }
        this.client.respond(msg.id, { success: result.ok, contentItems: [{ type: 'inputText', text: result.text }] })
        return
      }
    }

    // A headless one-shot (automation/review run) owns its own thread's tool
    // calls and responds to them directly on the shared client — skip so the two
    // server-request listeners never both respond to the same request.
    if (isHeadlessCodexThread(params?.threadId)) return

    const sessionId = this.sessionIdFor(params)
    this.logRawProviderMessage('server-request', msg, sessionId, params)
    if (!sessionId) {
      this.client.respond(msg.id, denialResponse(msg.method))
      return
    }

    const handle = this.activeRuns.get(sessionId)
    this.rememberSessionRouting(params, sessionId)
    this.cacheFileChanges(params)

    // dynamicTools work-tool call (experimental). Reads run immediately;
    // update_work routes through permissions in ask mode, is denied in plan mode.
    if (msg.method === 'item/tool/call') {
      const toolName = String(
        typeof params?.tool === 'string'
          ? params.tool
          : params?.tool?.name ?? params?.name ?? params?.toolName ?? '',
      )
      const respondWithWorkToolText = (text: string, success: boolean) => {
        this.client.respond(msg.id, { success, contentItems: [{ type: 'inputText', text }] })
      }

      const parseToolArgs = (): Record<string, unknown> => {
        let rawArgs: unknown = params?.arguments ?? params?.input ?? params?.args ?? {}
        if (typeof rawArgs === 'string') { try { rawArgs = JSON.parse(rawArgs) } catch { rawArgs = {} } }
        return (rawArgs && typeof rawArgs === 'object') ? rawArgs as Record<string, unknown> : {}
      }

      // All solus dynamic tools (works, tasks, automations, sessions, artifacts,
      // review ledger) dispatch through the shared executor. This backend keeps
      // the interactive concerns: gating mutating tools per permission mode and
      // emitting cards; the shared module owns the routing + execution.
      const cls = classifyCodexSolusTool(toolName)
      if (cls) {
        const args = parseToolArgs()
        const ctx: CodexSolusToolCtx = {
          cwd: handle?.cwd ?? '~',
          sessionId,
          agentProvider: 'codex',
          onWorkCreated: (work) => this.emit('normalized', sessionId, {
            type: 'work_created', workId: work.workId, title: work.title, docType: work.docType, content: work.content,
          }),
          onWorkUpdated: (work) => this.emit('normalized', sessionId, {
            type: 'work_updated', workId: work.workId, title: work.title, docType: work.docType, content: work.content, updatedAt: work.updatedAt,
          }),
          onArtifact: (artifact) => this.emit('normalized', sessionId, {
            type: 'artifact_created', kind: 'html', html: artifact.html,
          }),
          onAutomationSaved: (automation) => this.emit('normalized', sessionId, {
            type: 'automation_saved', automationId: automation.id, name: automation.name, trigger: automation.trigger, enabled: automation.enabled,
          }),
          onSessionCreated: (created) => this.emit('normalized', sessionId, {
            type: 'session_created', agentSessionId: created.agentSessionId, title: created.title, provider: created.provider, cwd: created.cwd,
          }),
          onSessionPrompted: (prompted) => this.emit('normalized', sessionId, {
            type: 'session_prompted', agentSessionId: prompted.agentSessionId, promptPreview: prompted.promptPreview, provider: prompted.provider, cwd: prompted.cwd,
          }),
          onSessionStopped: (stopped) => this.emit('normalized', sessionId, {
            type: 'session_stopped', agentSessionId: stopped.agentSessionId, provider: stopped.provider, cwd: stopped.cwd,
          }),
          onTaskCreated: (task) => this.emit('normalized', sessionId, {
            type: 'task_created', taskId: task.taskId, title: task.title, url: task.url,
          }),
        }

        const respondWithResult = async (approved: boolean) => {
          if (!approved) {
            respondWithWorkToolText(SOLUS_TOOL_DECLINE_TEXT[cls.kind], false)
            return
          }
          const result = await executeCodexSolusTool(toolName, args, ctx)
          respondWithWorkToolText(result.text, result.ok)
        }

        // Pre-approved (reads, create_work, create_session, artifact, ledger) run
        // immediately; mutating tools gate on the permission mode.
        if (!cls.mutating) { void respondWithResult(true); return }
        if (handle?.permissionMode === 'plan') {
          respondWithWorkToolText(SOLUS_TOOL_PLAN_BLOCK_TEXT[cls.kind], false)
          return
        }
        if (handle?.permissionMode === 'auto') { void respondWithResult(true); return }

        if (handle) handle.sawPermissionRequest = true
        const questionId = `codex-${String(msg.id)}`
        ;(this.permissions as CodexPermissionResponder).add(questionId, { id: msg.id, method: 'item/tool/call', params, sessionId, execute: respondWithResult })
        this.emit('normalized', sessionId, {
          type: 'permission_request',
          questionId,
          toolName: cls.kind === 'work' ? 'update_work' : bareToolName(toolName),
          toolDescription: SOLUS_TOOL_GATE_DESC[cls.kind],
          toolInput: args,
          options: [
            { id: 'accept', label: 'Allow', kind: 'allow' },
            { id: 'decline', label: 'Deny', kind: 'deny' },
          ],
        })
        return
      }

      respondWithWorkToolText(toolName ? `Unsupported dynamic tool: ${toolName}` : 'Unsupported dynamic tool call.', false)
      return
    }

    if (msg.method === 'item/tool/requestUserInput' || msg.method === 'mcpServer/elicitation/request') {
      const questionId = `codex-${String(msg.id)}`
      ;(this.permissions as CodexPermissionResponder).add(questionId, { id: msg.id, method: msg.method, params, sessionId })
      const elicitation = msg.method === 'mcpServer/elicitation/request'
        ? normalizeMcpElicitationRequest(params)
        : null
      this.emit('normalized', sessionId, {
        type: 'question_request',
        questionId,
        questions: elicitation?.questions ?? normalizeQuestionItems(params),
        ...(elicitation?.request ?? {}),
      })
      return
    }

    if (handle?.permissionMode === 'auto') {
      log.info(`Auto-approving Codex permission request: method=${msg.method}`)
      this.client.respond(msg.id, autoApprovalResponse(msg.method, params))
      return
    }

    if (handle?.permissionMode === 'plan') {
      log.info(`Declining Codex permission request in plan mode: method=${msg.method}`)
      this.client.respond(msg.id, denialResponse(msg.method))
      return
    }

    if (handle) handle.sawPermissionRequest = true

    const questionId = `codex-${String(msg.id)}`
    ;(this.permissions as CodexPermissionResponder).add(questionId, { id: msg.id, method: msg.method, params, sessionId })
    this.emit('normalized', sessionId, {
      type: 'permission_request',
      questionId,
      toolName: permissionToolName(msg.method, params),
      toolDescription: permissionDescription(msg.method, params),
      toolInput: this.permissionToolInput(msg.method, params),
      options: permissionOptions(msg.method, params),
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
    log.debug('Raw provider event', {
      provider: 'codex',
      kind,
      sessionId: params?.threadId || handle?.sessionId || handle?.threadId || sessionId || null,
      turnId: params?.turnId || params?.turn?.id || handle?.turnId || null,
      event: msg as unknown as Record<string, unknown>,
    })
  }

  private permissionToolInput(method: string, params: any): Record<string, unknown> {
    if (method !== 'item/fileChange/requestApproval') return params
    const changes = typeof params?.itemId === 'string' ? this.fileChangesByItem.get(params.itemId) : undefined
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
      log.warn(`initSnapshots failed: ${e}`)
    }
  }

  private async snapshotOnTurnComplete(handle: CodexRunHandle, partial: boolean): Promise<void> {
    const { workTree, repoRoot, sessionId } = handle
    if (!workTree || !repoRoot || !sessionId) return
    try {
      await snapshotTurn(workTree, repoRoot, sessionId, {
        partial,
        userMessagePreview: handle.userMessagePreview,
        changedFiles: [...handle.trackedFiles],
      })
    } catch (e) {
      log.warn(`snapshotOnTurnComplete failed: ${e}`)
    }
  }

  private sessionIdFor(params: any): string | null {
    // threadId IS sessionId for Codex
    if (typeof params?.threadId === 'string') {
      return this.activeRuns.has(params.threadId) ? params.threadId : null
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
    const turnId = typeof params?.turnId === 'string'
      ? params.turnId
      : typeof params?.turn?.id === 'string'
        ? params.turn.id
        : null
    if (turnId) this.sessionByTurn.set(turnId, sessionId)

    const itemId = this.codexItemId(params)
    if (itemId) this.sessionByItem.set(itemId, sessionId)
  }

  private codexItemId(params: any): string | null {
    if (typeof params?.itemId === 'string') return params.itemId
    if (typeof params?.item?.id === 'string') return params.item.id
    return null
  }

  private forgetRoutingForSession(sessionId: string): void {
    for (const [turnId, owner] of this.sessionByTurn) {
      if (owner === sessionId) this.sessionByTurn.delete(turnId)
    }
    for (const [itemId, owner] of this.sessionByItem) {
      if (owner === sessionId) this.sessionByItem.delete(itemId)
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
      log.warn(`Codex skills/list failed: ${(err as Error).message}`)
      return { global: [], project: [] }
    }
    const cwdResult = (response.data ?? []).find((entry) => entry.cwd === workingDirectory) ?? response.data?.[0]
    const commands = {
      global: (cwdResult?.skills ?? [])
        .filter((skill) => skill.enabled !== false && skill.name)
        .map((skill) => ({
          name: skill.name!,
          description: skill.interface?.shortDescription || skill.description || '',
          argumentHint: skill.interface?.defaultPrompt,
          kind: 'skill' as const,
          path: skill.path,
        })),
      project: [],
    }
    this.skillsByCwd.set(cacheKey, commands)
    return commands
  }

  private async listAllThreads(): Promise<CodexThreadSummary[]> {
    const threads: CodexThreadSummary[] = []
    let cursor: string | null | undefined = null

    do {
      const response: CodexThreadListResponse = await this.client.request('thread/list', {
        cursor,
        sortDirection: 'desc',
      })
      threads.push(...(response.data ?? []))
      cursor = response.nextCursor
    } while (cursor)

    return threads
  }
}
