import { EventEmitter } from 'events'
import { appendFile, mkdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { createLogger } from './logger'
import { createWorktree, buildBranchNamePrompt } from './git/worktree-manager'
import { computeGitProjectStatus } from './git/git-helpers'
import { GitWatcher } from './git/git-watcher'
import { warmFinder } from './server/file-finder'
import { TextGenerator } from './agents/text-generator'
import { runInputFromContext } from './agents/run-input'
import { RateLimitState } from './rate-limits'
import { AttentionService, attentionActionForStatus } from './attention/attention-service'
import type { AttentionKind } from '../shared/attention-types'
import { getTask, formatTaskContext, startTaskWork } from './tasks/task-service'
import type { AgentBackend, RunHandle } from './agents/agent-backend'
import type {
  AgentId,
  AgentMetadata,
  BackendSession,
  SessionStatus,
  TabRegistryEntry,
  NormalizedEvent,
  TabGitContext,
  IpcContext,
  PromptOptions,
  PlanDescriptor,
  PluginCommandsResult,
  QueuedPromptSnapshot,
  QueuedPromptReason,
  RateLimitDecisionAction,
  SessionMeta,
  SessionRunInput,
  ReasoningEffort,
  RuntimeSessionInfo,
  StatusCardState,
  StatusCardStep,
  ThreadGoal,
  ThreadGoalSetRequest,
} from '../shared/types'
import { tabGitContextFromStatus } from '../shared/types'
import type { SessionLoadMessage, SessionPreviewResult } from '../shared/session-history'
import type { Task } from '../shared/task-types'

const MAX_QUEUE_DEPTH = 32
const TEXT_FLUSH_INTERVAL_MS = 300
const RUN_WATCHDOG_INTERVAL_MS = 30_000
const RUN_WATCHDOG_MISSES = 1
const TAB_DISCONNECT_GRACE_MS = 5 * 60_000
const IS_DEV_MODE = Boolean(process.env.ELECTRON_RENDERER_URL)
const NEW_SESSION_PROMPTS_CSV = join(homedir(), '.solus', 'new-session-prompts.csv')
const NEW_SESSION_PROMPTS_CSV_HEADER = 'input_prompt,model,agent_provider,reasoning_level\n'

const log = createLogger('ControlPlane', 'control-plane.ts')

const textGenerator = new TextGenerator()

function csvCell(value: string | null | undefined): string {
  const text = value ?? ''
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

interface QueuedRequest {
  queueId: string
  prompt: string
  agentSessionId: string
  sourceTabId?: string
  deviceId?: string
  input?: SessionRunInput
  options?: PromptOptions
  reason: QueuedPromptReason
  resolve: (value: void) => void
  reject: (reason: Error) => void
  enqueuedAt: number
  sourceSessionId?: string
  rateLimitSessionId?: string
  releaseAt?: number
  rateLimitType?: string
}

interface ActiveRunRequest {
  sourceTabId?: string
  input: SessionRunInput
  options: PromptOptions
}

interface PendingStart {
  sourceTabId?: string
  resolve: (value: { agentSessionId: string }) => void
  reject: (reason: Error) => void
}

interface TabOwner {
  clientId: string
  deviceId?: string
}

interface DisconnectedClient {
  deviceId?: string
  deadline: number
}

interface ControlPlaneOptions {
  tabDisconnectGraceMs?: number
  now?: () => number
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

/**
 * ControlPlane: the single backend authority for tab/session lifecycle.
 *
 * Tabs are thin subscription records. All session state lives in BackendSession
 * (keyed by agent session ID in activeSessions). Tabs point to sessions via
 * tab.sessionId. Events are emitted by tabId and routed to that tab's owner.
 */
export class ControlPlane extends EventEmitter {
  private tabs = new Map<string, TabRegistryEntry>()
  private activeSessions = new Map<string, BackendSession>()
  private requestQueue = new Map<string, QueuedRequest[]>()
  private activeRunRequests = new Map<string, ActiveRunRequest>()
  private pendingRunRequestsByTab = new Map<string, ActiveRunRequest>()
  private pendingStarts = new Map<RunHandle, PendingStart>()
  private backends: Map<AgentId, AgentBackend>

  /**
   * Per-tab pending buffer of streaming main-thread text (tabId → buffered text;
   * the key's presence marks an active stream, so '' is meaningful). Flushed on the
   * 300ms interval and before any non-buffered event for that tab. The first chunk
   * emits immediately for latency; the rest batch into one event per flush.
   */
  private pendingFlush = new Map<string, string>()
  /** Per-session accumulator for all text in the current streaming turn. Read by bindRuntimeSession so late joiners see in-flight text. */
  // Chunks for the in-flight turn, kept as an array so accumulation is O(1) per
  // token instead of O(n²) string concatenation. Joined once if a late-joining
  // tab needs to replay the turn (see bindRuntimeSession).
  private turnText = new Map<string, string[]>()
  private textFlushTimer: ReturnType<typeof setInterval> | null = null
  private runWatchdogTimer: ReturnType<typeof setInterval> | null = null
  private rateLimitTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private disconnectedClients = new Map<string, DisconnectedClient>()
  private disconnectedClientTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private missingRunCounts = new Map<string, number>()
  private rateLimits = new RateLimitState()
  /** questionId → sessionId index so we can resolve which backend owns a question without iterating all backends. */
  private questionIdToSession = new Map<string, string>()

  /** Server-side per-session needs-attention state; outlives connected clients
   *  and persists across restarts. Fed by `_setStatus` transitions; read by the
   *  `listAttention` RPC and broadcast on the `attention-changed` topic. */
  readonly attention = new AttentionService()

  /** Live filesystem watcher per repo, so external git changes mirror into the renderer. */
  private gitWatcher: GitWatcher
  /** tabId → repoRoot currently registered with the watcher, for correct ref-counted teardown. */
  private tabWatchKeys = new Map<string, string>()
  /** cwd → last broadcast git_status (serialized), so an unchanged watcher fire
   *  doesn't re-broadcast identical status to every (possibly hidden) window. */
  private lastGitStatusByCwd = new Map<string, string>()
  private readonly tabDisconnectGraceMs: number
  private readonly now: () => number
  private readonly setGcTimeout: typeof setTimeout
  private readonly clearGcTimeout: typeof clearTimeout

  constructor(backends: Map<AgentId, AgentBackend>, opts: ControlPlaneOptions = {}) {
    super()
    this.backends = backends
    this.tabDisconnectGraceMs = opts.tabDisconnectGraceMs ?? TAB_DISCONNECT_GRACE_MS
    this.now = opts.now ?? (() => Date.now())
    this.setGcTimeout = opts.setTimeout ?? setTimeout
    this.clearGcTimeout = opts.clearTimeout ?? clearTimeout
    for (const backend of this.backends.values()) {
      this._wireBackend(backend)
    }
    this.gitWatcher = new GitWatcher((repoRoot) => { void this._onGitWatchFire(repoRoot) })
    this.runWatchdogTimer = setInterval(() => this._checkActiveRuns(), RUN_WATCHDOG_INTERVAL_MS)
    ;(this.runWatchdogTimer as unknown as { unref?: () => void }).unref?.()
  }

  private _sessionFor(tab: TabRegistryEntry): BackendSession | undefined {
    return tab.sessionId ? this.activeSessions.get(tab.sessionId) : undefined
  }

  private _wireBackend(backend: AgentBackend): void {
    backend.on('session-index-updated', (event) => {
      this.emit('session-index-updated', event)
    })
    backend.on('normalized', (sessionId: string | null, event: NormalizedEvent) => {
      // Backends only emit normalized events after session_init. Drop any stray
      // pre-init emissions (e.g. permission events that race ahead) — they'd
      // have nowhere to route.
      if (!sessionId) return

      // ─── Session-level state (always runs, even with no watching tab) ───

      if (event.type === 'session_init') {
        backend.permissions.setCurrentSessionId(event.sessionId)
        // Link the originating tab to the freshly-issued session.
        const initHandle = backend.getSessionHandle(event.sessionId)
        if (initHandle) {
          const pendingStart = this.pendingStarts.get(initHandle)
          if (pendingStart) {
            this.pendingStarts.delete(initHandle)
            pendingStart.resolve({ agentSessionId: event.sessionId })
          }
          const initTabId = initHandle.sourceTabId ?? initHandle.tabId
          const initTab = initTabId ? this.tabs.get(initTabId) : undefined
          if (initTab && !initTab.sessionId) {
            initTab.sessionId = event.sessionId
          }
          const pendingRun = initTabId ? this.pendingRunRequestsByTab.get(initTabId) : undefined
          if (pendingRun) {
            this.activeRunRequests.set(event.sessionId, pendingRun)
            this.pendingRunRequestsByTab.delete(initTabId!)
          }
        }
        // Preserve the run contract so a reattaching client (e.g. after a
        // refresh) can read back the live status, model config and permission
        // mode via bindRuntimeSession, and a backgrounded automation can
        // re-dispatch by run input alone. Without this, a first-run session has
        // no runInput and bind returns null, leaving the tab stuck at idle.
        const existingSession = this.activeSessions.get(event.sessionId)
        const runReqInput = this.activeRunRequests.get(event.sessionId)?.input
        this.activeSessions.set(event.sessionId, {
          sessionId: event.sessionId,
          backendId: backend.id,
          status: 'running',
          pendingInputEvents: [],
          lastActivityAt: Date.now(),
          promptCount: 0,
          runInput: existingSession?.runInput ?? runReqInput,
          gitContext: existingSession?.gitContext ?? runReqInput?.gitContext ?? undefined,
        })
      }

      const session = this.activeSessions.get(sessionId)
      if (session) {
        session.lastActivityAt = Date.now()

        if (event.type === 'permission_request' || event.type === 'question_request') {
          session.hasPendingInput = true
          session.pendingInputEvents.push(event)
          this.questionIdToSession.set(event.questionId, session.sessionId)
          this._setStatus({ sessionId: session.sessionId }, 'awaiting_input')
        } else if (event.type === 'plan') {
          session.hasPendingInput = true
          session.pendingInputEvents.push(event)
          this.questionIdToSession.set(event.questionId, session.sessionId)
          this._setStatus({ sessionId: session.sessionId }, this._pendingInputStatus(session))
        } else if (event.type === 'permission_resolved') {
          session.pendingInputEvents = session.pendingInputEvents.filter(
            (e) => !('questionId' in e && (e as any).questionId === event.questionId),
          )
          this.questionIdToSession.delete(event.questionId)
          session.hasPendingInput = session.pendingInputEvents.length > 0
          this._setStatus({ sessionId: session.sessionId }, this._pendingInputStatus(session))
        }

        if (event.type === 'background_task_started') {
          ;(session.backgroundTaskIds ??= new Set()).add(event.taskId)
          log.info(`Task ${event.taskId} started for session ${session.sessionId} (${session.backgroundTaskIds.size} in flight)`)
          // A task can be backgrounded after the turn already settled to idle;
          // pull the session back to running so it reflects the in-flight work.
          if (!this._isBusyStatus(session.status)) this._setStatus({ sessionId: session.sessionId }, 'running')
          return
        }

        if (event.type === 'background_task_settled') {
          session.backgroundTaskIds?.delete(event.taskId)
          log.info(`Task ${event.taskId} settled (${event.status}) for session ${session.sessionId} (${session.backgroundTaskIds?.size ?? 0} still in flight)`)
          // Don't force idle here — the still-open query drives the real terminal
          // status via its next task_complete (set now empty) or its exit event.
          return
        }

        if (event.type === 'task_complete') {
          this.activeRunRequests.delete(session.sessionId)
          // Hold 'running' while background sub-agents are still in flight; the SDK
          // query stays open servicing them and will emit exit once they settle.
          if (session.backgroundTaskIds?.size) {
            log.info(`Turn complete for session ${session.sessionId} but ${session.backgroundTaskIds.size} task(s) still in flight — holding 'running'`)
          } else {
            this._setStatus({ sessionId: session.sessionId }, 'completed')
          }
        }

        if (event.type === 'rate_limit') {
          const rateLimitEvent = this.rateLimits.record(session.sessionId, event)
          if (!rateLimitEvent) return
          event = rateLimitEvent
        }

        if (event.type === 'rate_limit' && event.status !== 'allowed' && event.status !== 'allowed_warning' && !event.isUsingOverage) {
          const run = this.activeRunRequests.get(session.sessionId)
          const deferCurrentRun = event.deferCurrentRun === true && !!run
          this._scheduleRateLimitRelease(session.sessionId, event.resetsAt)
          if (deferCurrentRun) {
            // Codex can report that the account is exhausted while it is still
            // completing the current turn. Keep that snapshot for the next send,
            // but do not interrupt the stream or present it as a failed prompt.
            return
          }

          this._setStatus({ sessionId: session.sessionId }, 'rate_limited')
          if (run?.input.rateLimitBehavior === 'queue') {
            this._queueActiveRateLimitedRequest(session.sessionId)
          }
        }
      }

      if (!session && event.type === 'rate_limit') {
        const rateLimitEvent = this.rateLimits.record(sessionId, event)
        if (!rateLimitEvent) return
        event = rateLimitEvent
      }

      // ─── Tab-level routing ───

      const tabIds = this._findTabsBySession(sessionId)
      if (!tabIds.length) return

      for (const tabId of tabIds) {
        const tab = this.tabs.get(tabId)
        if (!tab) continue
        tab.lastActivityAt = Date.now()
      }

      if (event.type === 'session_init') {
        for (const tabId of tabIds) {
          const tab = this.tabs.get(tabId)
          if (!tab) continue
          if (tab.sessionId !== sessionId) {
            tab.sessionId = sessionId
          }
          if (tab.status === 'connecting') {
            this._setStatus({ tabId }, 'running')
          }
        }
        const firstTab = this.tabs.get(tabIds[0])
        if (firstTab && session) {
          session.runInput = this._sessionFor(firstTab)?.runInput ?? session.runInput
        }
      }

      if (event.type === 'text_chunk') {
        // Coalesce main-thread streaming text per tab; the first chunk emits
        // immediately for latency and the rest batch on the flush timer.
        const isFirstChunk = tabIds.every((tabId) => !this.pendingFlush.has(tabId))
        for (const tabId of tabIds) {
          this.pendingFlush.set(tabId, (this.pendingFlush.get(tabId) ?? '') + event.text)
        }
        // Text is part of the turn's replayable result, so late-joining tabs see it.
        if (sessionId) {
          const chunks = this.turnText.get(sessionId)
          if (chunks) chunks.push(event.text)
          else this.turnText.set(sessionId, [event.text])
        }
        if (isFirstChunk) {
          for (const tabId of tabIds) this._flushPendingText(tabId)
        }
        this._ensureTextFlushTimer()
        return
      }

      // Any other event is a flush boundary: drain this tab's pending text first
      // so the reducer never sees a later event before its buffered text.
      for (const tabId of tabIds) {
        this._flushPendingTab(tabId, false)
      }
      if (sessionId) this.turnText.delete(sessionId)

      for (const tabId of tabIds) {
        this.emit('event', tabId, event)
      }
    })

    backend.on('exit', (sessionId: string | null, code: number | null, signal: string | null) => {
      if (sessionId) {
        backend.permissions.clearPendingForSession(sessionId)
      }

      // Find tabs listening on this session/pending run
      let listeningTabIds: string[]
      if (sessionId) {
        listeningTabIds = this._findTabsBySession(sessionId)
      } else {
        // Pre-session_init exit — surface to the originating tabs.
        const pendingHandles = backend.getPendingHandles()
        listeningTabIds = pendingHandles.map((h) => h.sourceTabId ?? h.tabId).filter((tabId): tabId is string => !!tabId)
      }

      if (listeningTabIds.length === 0) {
        return
      }

      if (sessionId) this.turnText.delete(sessionId)

      for (const tabId of listeningTabIds) {
        this._flushPendingTab(tabId, false)
        const tab = this.tabs.get(tabId)
        if (!tab) continue
        if (sessionId) {
          this._currentRateLimitEvent(sessionId)
          if (!tab.sessionId) tab.sessionId = sessionId
        }
      }

      if (sessionId) this.missingRunCounts.delete(sessionId)

      const rateLimitEvent = sessionId != null ? this._currentRateLimitEvent(sessionId) : null
      const isRateLimited = rateLimitEvent != null
      const newStatus: SessionStatus = isRateLimited
        ? 'rate_limited'
        : code === 0
        ? 'completed'
        : signal === 'SIGINT' || signal === 'SIGKILL'
          ? 'interrupted'
            : code === null
            ? 'dead'
            : 'failed'

      if (sessionId && !isRateLimited) {
        this.activeSessions.delete(sessionId)
        this.activeRunRequests.delete(sessionId)
      }
      for (const tabId of listeningTabIds) this.pendingRunRequestsByTab.delete(tabId)
      for (const handle of backend.getPendingHandles()) {
        const pending = this.pendingStarts.get(handle)
        if (pending) {
          this.pendingStarts.delete(handle)
          pending.reject(new Error(`Run exited before session_init`))
        }
      }

      if (newStatus === 'failed' || newStatus === 'dead') {
        const enriched = backend.getEnrichedError(sessionId, code)
        const broadcastKeys = new Set<string>()
        for (const tabId of listeningTabIds) {
          const tab = this.tabs.get(tabId)
          if (!tab) continue
          const key = tab.sessionId ?? tabId
          if (broadcastKeys.has(key)) continue
          broadcastKeys.add(key)
          this._broadcastToSession('error', tabId, enriched)
        }
      }

      if (newStatus === 'interrupted') {
        const dispatched = sessionId ? this._processQueueForSession(sessionId) : false
        if (!dispatched) {
          for (const tabId of listeningTabIds) {
            const tab = this.tabs.get(tabId)
            if (tab && (tab.status === 'connecting' || tab.status === 'running')) continue
            this._setStatus({ tabId }, newStatus)
          }
        }
      } else {
        for (const tabId of listeningTabIds) {
          const tab = this.tabs.get(tabId)
          if (tab && tab.status === 'connecting') continue
          this._setStatus({ tabId }, newStatus)
        }
        if (sessionId) this._processQueueForSession(sessionId)
      }
    })

    backend.on('error', (sessionId: string | null, err: Error) => {
      if (sessionId) backend.permissions.clearPendingForSession(sessionId)

      let tabId: string | null = null
      if (sessionId) {
        const tabs = this._findTabsBySession(sessionId)
        tabId = tabs[0] ?? null
      } else {
        const pendingHandles = backend.getPendingHandles()
        tabId = pendingHandles.map((h) => h.sourceTabId ?? h.tabId).find(Boolean) ?? null
      }

      if (!tabId || !this.tabs.get(tabId)) {
        if (sessionId) {
          this.activeSessions.delete(sessionId)
          this.activeRunRequests.delete(sessionId)
        }
        for (const handle of backend.getPendingHandles()) {
          const pending = this.pendingStarts.get(handle)
          if (pending) {
            this.pendingStarts.delete(handle)
            pending.reject(err)
          }
        }
        return
      }

      const tab = this.tabs.get(tabId)!

      const rateLimitEvent = this._currentRateLimitEvent(tab.sessionId)
      if (sessionId && !rateLimitEvent) {
        this.activeSessions.delete(sessionId)
      }
      if (!rateLimitEvent && sessionId) this.activeRunRequests.delete(sessionId)
      if (!sessionId) this.pendingRunRequestsByTab.delete(tabId)
      this.missingRunCounts.delete(sessionId ?? '')

      if (rateLimitEvent) {
        if (sessionId) this._setStatus({ sessionId }, 'rate_limited')
        this._setStatus({ tabId }, 'rate_limited')
        this.emit('event', tabId, rateLimitEvent)
        return
      }

      this._setStatus({ tabId }, 'dead')

      const enriched = backend.getEnrichedError(sessionId, null)
      enriched.message = err.message
      this._broadcastToSession('error', tabId, enriched)
    })
  }

  // ─── Tab Lifecycle ───

  createTab(clientTabId: string | undefined, tabOwner: TabOwner): string {
    const tabId = clientTabId ?? crypto.randomUUID()
    const existing = this.tabs.get(tabId)
    if (existing) {
      this._adoptTabOwnerIfStale(existing, tabOwner)
      return tabId
    }
    const entry: TabRegistryEntry = {
      tabId,
      clientId: tabOwner.clientId,
      deviceId: tabOwner.deviceId,
      sessionId: null,
      createdAt: this.now(),
      lastActivityAt: this.now(),
      status: 'idle',
    }
    this.tabs.set(tabId, entry)
    log.info(`Tab created: ${tabId}`)
    return tabId
  }

  getTabClientId(tabId: string): string | null {
    return this.tabs.get(tabId)?.clientId ?? null
  }

  bindRuntimeSession(tabId: string, sessionId: string, tabOwner: TabOwner): RuntimeSessionInfo | null {
    const tab = this.tabs.get(tabId)
    if (!tab) return null
    if (!this._tabBelongsToOwner(tab, tabOwner)) return null
    this._adoptDisconnectedSessionWatch(tabId, sessionId, tabOwner)

    const session = this.activeSessions.get(sessionId)
    if (!session) return null

    const backend = this._backendFor(session.backendId)
    const pendingRateLimitEvent = this._currentRateLimitEvent(sessionId)
    const rateLimitInfo = pendingRateLimitEvent?.type === 'rate_limit'
      ? (pendingRateLimitEvent.info ?? null)
      : null
    const hasQueuedRateLimitRequest = (this.requestQueue.get(sessionId) ?? []).some(
      (request) => request.rateLimitSessionId === sessionId,
    )
    if (!backend.isSessionRunning(sessionId) && !pendingRateLimitEvent && !hasQueuedRateLimitRequest) {
      this.activeSessions.delete(sessionId)
      return null
    }

    tab.sessionId = sessionId
    tab.clientId = tabOwner.clientId
    tab.deviceId = tabOwner.deviceId
    if (!pendingRateLimitEvent) this._processQueueForSession(sessionId)

    const accumulatedChunks = this.turnText.get(sessionId)
    if (accumulatedChunks && accumulatedChunks.length) {
      this.emit('event', tabId, { type: 'text_chunk', text: accumulatedChunks.join('') })
    }

    if (session.pendingInputEvents.length) {
      for (const event of session.pendingInputEvents) {
        this.emit('event', tabId, event)
      }
    }

    this._setStatus({ tabId }, pendingRateLimitEvent ? 'rate_limited' : session.status)
    log.info(`Tab ${tabId} attached to running session ${sessionId}`)

    if (pendingRateLimitEvent) {
      this.emit('event', tabId, pendingRateLimitEvent)
    }

    const input = session.runInput
    if (!input) return null
    return {
      modelConfig: { modelId: input.preferredModel, reasoningEffort: input.reasoningEffort, contextWindow: input.contextWindow, fastMode: input.fastMode },
      permissionMode: input.permissionMode,
      status: pendingRateLimitEvent ? 'rate_limited' : session.status,
      queuedPrompts: this._queuedPromptsForSession(sessionId),
      rateLimitInfo,
    }
  }

  /** Clear stored session ID so _dispatch won't inject a stale --resume. */
  resetTabSession(ctx: IpcContext, owner: TabOwner): void {
    const tab = this.tabs.get(ctx.session.tabId)
    if (!tab) return
    if (!this._tabBelongsToOwner(tab, owner)) return
    log.info(`Resetting session for tab ${ctx.session.tabId} (was: ${tab.sessionId})`)
    if (tab.sessionId) {
      this.rateLimits.clear(tab.sessionId)
    }
    tab.sessionId = null
    tab.status = 'idle'

    const session = this._sessionFor(tab)
    if (session) {
      session.runInput = { ...runInputFromContext(ctx), agentSessionId: null }
      session.gitContext = ctx.session.gitContext ?? undefined
    }
  }

  async listSessionsForProviders(agentIds: AgentId[], projectPath: string, onBatch?: (sessions: SessionMeta[]) => void): Promise<SessionMeta[]> {
    const settled = await Promise.allSettled(
      agentIds.map((agentId) => this._backendFor(agentId).listSessions(projectPath, onBatch)),
    )
    const sessions = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime())
    for (const meta of sessions) {
      const active = this.activeSessions.get(meta.sessionId)
      if (this._currentRateLimitEvent(meta.sessionId)) meta.status = 'rate_limited'
      else if (active) meta.status = active.status
    }
    return sessions
  }

  async listPlansForProviders(agentIds: AgentId[], projectPath: string | undefined, allProjects: boolean): Promise<PlanDescriptor[]> {
    const settled = await Promise.allSettled(
      agentIds.map((agentId) => this._backendFor(agentId).listPlans(projectPath, allProjects)),
    )
    const plans = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    plans.sort((a, b) => b.timestamp - a.timestamp)
    return plans
  }

  loadSession(agentId: AgentId, sessionId: string, projectPath?: string, limit?: number): Promise<SessionLoadMessage[]> {
    return this._backendFor(agentId).loadSession(sessionId, projectPath, limit)
  }

  getSessionInfo(agentId: AgentId, sessionId: string, projectPath?: string): Promise<SessionMeta | null> {
    const backend = this._backendFor(agentId)
    return backend.getSessionInfo ? backend.getSessionInfo(sessionId, projectPath) : Promise.resolve(null)
  }

  liveSessionStatus(agentSessionId: string): SessionStatus | null {
    const pendingRateLimit = this._currentRateLimitEvent(agentSessionId)
    if (pendingRateLimit) return 'rate_limited'
    return this.activeSessions.get(agentSessionId)?.status ?? null
  }

  loadSessionPreview(agentId: AgentId, sessionId: string, projectPath?: string): Promise<SessionPreviewResult> {
    const backend = this._backendFor(agentId)
    if (backend.loadSessionPreview) return backend.loadSessionPreview(sessionId, projectPath)
    return backend.loadSession(sessionId, projectPath).then((msgs) => ({
      head: msgs.slice(0, 4),
      tail: msgs.slice(-1),
      totalMessages: msgs.length,
    }))
  }

  listPlans(agentId: AgentId, projectPath: string | undefined, allProjects: boolean): Promise<PlanDescriptor[]> {
    return this._backendFor(agentId).listPlans(projectPath, allProjects)
  }

  loadPlanContent(agentId: AgentId, sessionId: string, projectPath: string, planToolUseId: string): Promise<string | null> {
    return this._backendFor(agentId).loadPlanContent(sessionId, projectPath, planToolUseId)
  }

  getThreadGoal(agentId: AgentId, threadId: string): Promise<ThreadGoal | null> {
    const backend = this._backendFor(agentId)
    if (!backend.getThreadGoal) throw new Error(`${agentId} does not support thread goals`)
    return backend.getThreadGoal(threadId)
  }

  setThreadGoal(agentId: AgentId, request: ThreadGoalSetRequest): Promise<ThreadGoal> {
    const backend = this._backendFor(agentId)
    if (!backend.setThreadGoal) throw new Error(`${agentId} does not support thread goals`)
    return backend.setThreadGoal(request)
  }

  clearThreadGoal(agentId: AgentId, threadId: string): Promise<boolean> {
    const backend = this._backendFor(agentId)
    if (!backend.clearThreadGoal) throw new Error(`${agentId} does not support thread goals`)
    return backend.clearThreadGoal(threadId)
  }

  listPluginCommands(agentId: AgentId, workingDirectory: string, ctx?: IpcContext): Promise<PluginCommandsResult> {
    return this._backendFor(agentId).listPluginCommands(workingDirectory, ctx)
  }

  async refreshPluginCommands(): Promise<void> {
    await Promise.all([...this.backends.values()].map((backend) => backend.refreshPluginCommands()))
  }

  closeTab(ctx: IpcContext, owner: TabOwner): void {
    const tab = this.tabs.get(ctx.session.tabId)
    if (tab && !this._tabBelongsToOwner(tab, owner)) return
    this._closeTabById(ctx.session.tabId)
  }

  handleClientDisconnected(clientId: string, deviceId?: string): void {
    const ownsTabs = [...this.tabs.values()].some((tab) => tab.clientId === clientId)
    if (!ownsTabs) return
    const inferredDeviceId = deviceId ?? [...this.tabs.values()].find((tab) => tab.clientId === clientId)?.deviceId
    this._scheduleDisconnectedClientGc(clientId, inferredDeviceId)
  }

  handleClientConnected(clientId: string): void {
    const timer = this.disconnectedClientTimers.get(clientId)
    if (timer) this.clearGcTimeout(timer)
    this.disconnectedClientTimers.delete(clientId)
    this.disconnectedClients.delete(clientId)
  }

  private _closeTabById(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return

    for (const queue of this.requestQueue.values()) {
      for (const req of queue) {
        if (req.sourceTabId === tabId) req.sourceTabId = undefined
      }
    }

    this.pendingFlush.delete(tabId)
    this._syncGitWatcher(tabId, null)
    this.tabs.delete(tabId)
    log.info(`Tab closed: ${tabId}`)
  }

  private _tabBelongsToOwner(tab: TabRegistryEntry, owner: TabOwner): boolean {
    if (tab.clientId === owner.clientId) return true
    return this._canAdoptTabOwner(tab, owner)
  }

  private _canAdoptTabOwner(tab: TabRegistryEntry, owner: TabOwner): boolean {
    if (!owner.deviceId || tab.deviceId !== owner.deviceId) return false
    return this.disconnectedClients.has(tab.clientId)
  }

  private _adoptTabOwnerIfStale(tab: TabRegistryEntry, owner: TabOwner): void {
    if (tab.clientId === owner.clientId) return
    if (!this._canAdoptTabOwner(tab, owner)) {
      log.warn(`Tab ${tab.tabId} is owned by ${tab.clientId}; ${owner.clientId} cannot adopt it`)
      return
    }
    const previousClientId = tab.clientId
    tab.clientId = owner.clientId
    tab.deviceId = owner.deviceId
    this._clearDisconnectedClientIfUnwatched(previousClientId)
    log.info(`Tab ${tab.tabId} adopted from ${previousClientId} by ${owner.clientId}`)
  }

  private _adoptDisconnectedSessionWatch(tabId: string, sessionId: string, owner: TabOwner): void {
    if (!owner.deviceId) return
    for (const [existingTabId, tab] of [...this.tabs]) {
      if (existingTabId === tabId) continue
      if (tab.sessionId !== sessionId) continue
      if (tab.deviceId !== owner.deviceId) continue
      if (tab.clientId === owner.clientId) continue
      if (!this.disconnectedClients.has(tab.clientId)) continue
      const previousClientId = tab.clientId
      this._closeTabById(existingTabId)
      this._clearDisconnectedClientIfUnwatched(previousClientId)
      log.info(`Replaced stale watch ${existingTabId} for session ${sessionId} with ${tabId}`)
    }
  }

  private _scheduleDisconnectedClientGc(clientId: string, deviceId?: string): void {
    const existing = this.disconnectedClientTimers.get(clientId)
    if (existing) this.clearGcTimeout(existing)
    this.disconnectedClients.set(clientId, { deviceId, deadline: this.now() + this.tabDisconnectGraceMs })
    const timer = this.setGcTimeout(() => this._gcDisconnectedClientTabs(clientId), this.tabDisconnectGraceMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.disconnectedClientTimers.set(clientId, timer)
    log.info(`Scheduled tab GC for disconnected client ${clientId}`)
  }

  private _gcDisconnectedClientTabs(clientId: string): void {
    const disconnected = this.disconnectedClients.get(clientId)
    if (!disconnected) return
    const remaining = disconnected.deadline - this.now()
    if (remaining > 0) {
      const timer = this.setGcTimeout(() => this._gcDisconnectedClientTabs(clientId), remaining)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      this.disconnectedClientTimers.set(clientId, timer)
      return
    }

    this.disconnectedClients.delete(clientId)
    this.disconnectedClientTimers.delete(clientId)
    for (const [tabId, tab] of [...this.tabs]) {
      if (tab.clientId === clientId) this._closeTabById(tabId)
    }
  }

  private _clearDisconnectedClientIfUnwatched(clientId: string): void {
    if ([...this.tabs.values()].some((tab) => tab.clientId === clientId)) return
    const timer = this.disconnectedClientTimers.get(clientId)
    if (timer) this.clearGcTimeout(timer)
    this.disconnectedClientTimers.delete(clientId)
    this.disconnectedClients.delete(clientId)
  }

  /**
   * The single start-vs-resume decision point. Resolves the target session from
   * the explicit id, the tab, or the context; resumes it (queueing if busy or
   * rate-limited) when one exists, otherwise starts a new session. Every entry
   * point — renderer prompt/start/retry and external `runSession` — funnels
   * through here so the decision lives in exactly one place.
   */
  private async _run(
    input: SessionRunInput,
    options: PromptOptions,
    opts: { deviceId?: string; explicitAgentSessionId?: string } = {},
  ): Promise<{ agentSessionId: string }> {
    const tab = input.tabId ? this.tabs.get(input.tabId) : undefined
    // input.agentSessionId is only consulted when a tab exists (matching the old
    // submit/start paths); a headless start with no explicit id starts fresh.
    const existingSessionId = opts.explicitAgentSessionId ?? tab?.sessionId ?? (tab ? input.agentSessionId : null) ?? null
    if (existingSessionId) {
      await this._dispatchToSession(input, existingSessionId, options, opts.deviceId)
      return { agentSessionId: existingSessionId }
    }
    return this._startSession(input, options)
  }

  /**
   * Run a turn from a plain, caller-agnostic input — the entry for systems that
   * aren't the renderer (automations today; HTTP/MCP callers later). A set
   * `agentSessionId` resumes the session (cold-starting it from disk if it isn't
   * resident); null starts a fresh one. No tab required.
   */
  async runSession(
    input: SessionRunInput,
    options: PromptOptions,
    opts: { deviceId?: string } = {},
  ): Promise<{ agentSessionId: string }> {
    return this._run(input, options, {
      deviceId: opts.deviceId,
      explicitAgentSessionId: input.agentSessionId ?? undefined,
    })
  }

  /**
   * Submit a prompt to a specific tab. Resolves when the run completes.
   */
  async submitPrompt(
    ctx: IpcContext,
    options: PromptOptions,
    deviceId?: string,
  ): Promise<void> {
    const tabId = ctx.session.tabId
    if (!tabId) {
      throw new Error('No targetSession (tabId) provided — rejecting to prevent misrouting')
    }
    if (!this.tabs.get(tabId)) {
      throw new Error(`Tab ${tabId} does not exist`)
    }
    await this._run(runInputFromContext(ctx), options, { deviceId })
  }

  async startAgentSession(
    ctx: IpcContext,
    options: PromptOptions,
    deviceId?: string,
  ): Promise<{ agentSessionId: string }> {
    const sourceTabId = ctx.session.tabId || undefined
    if (sourceTabId && !this.tabs.get(sourceTabId)) {
      throw new Error(`Tab ${sourceTabId} does not exist`)
    }
    return this._run(runInputFromContext(ctx), options, { deviceId })
  }

  /** Resume/send into a known session. Public name for the resume half of `_run`. */
  async dispatchToAgentSession(
    ctx: IpcContext,
    agentSessionId: string,
    options: PromptOptions,
    deviceId?: string,
  ): Promise<void> {
    if (!agentSessionId) throw new Error('No agentSessionId provided')
    return this._dispatchToSession(runInputFromContext(ctx), agentSessionId, options, deviceId)
  }

  private async _dispatchToSession(
    input: SessionRunInput,
    agentSessionId: string,
    options: PromptOptions,
    deviceId?: string,
  ): Promise<void> {
    const session = this.activeSessions.get(agentSessionId)
    if (!session) {
      return this._dispatch(input, options, agentSessionId)
    }

    const pendingRateLimit = this._currentRateLimitEvent(agentSessionId)
    if (
      pendingRateLimit?.type === 'rate_limit' &&
      (input.rateLimitBehavior === 'ask' || input.rateLimitBehavior === 'queue')
    ) {
      return this._enqueueRequest(input, options, {
        agentSessionId,
        reason: 'rate_limit',
        deviceId,
        rateLimitSessionId: agentSessionId,
        releaseAt: pendingRateLimit.resetsAt,
        rateLimitType: pendingRateLimit.rateLimitType,
      })
    }

    const isBusy = this._isBusyStatus(session.status)
    const hasQueuedForSession = (this.requestQueue.get(agentSessionId)?.length ?? 0) > 0
    if (isBusy || hasQueuedForSession) {
      return this._enqueueRequest(input, options, { agentSessionId, reason: 'busy', deviceId })
    }

    return this._dispatch(input, options, agentSessionId)
  }

  /**
   * Dispatch an automation's prompt *into* an agent session so it runs in-thread
   * with full conversation context (the "run in this chat" path). Builds a plain
   * run input from the session's last run (when resident) or the automation's own
   * config fallback (when not), so a backgrounded or cold session resumes from
   * disk rather than failing. The tabId is left unset so the injected message
   * broadcasts to every tab watching the session. Routes through `runSession`, so
   * a busy session queues. Resolves when the run settles.
   */
  async dispatchAutomationRun(opts: {
    agentSessionId: string
    prompt: string
    automationId: string
    automationName: string
    fallback?: { provider: AgentId; model: string | null; reasoningEffort: ReasoningEffort; cwd: string }
  }): Promise<void> {
    const { agentSessionId, prompt, automationId, automationName, fallback } = opts
    const resident = this.activeSessions.get(agentSessionId)?.runInput
    const input: SessionRunInput | undefined = resident
      ? { ...resident, tabId: undefined, agentSessionId, forked: false }
      : fallback
        ? {
            provider: fallback.provider,
            agentSessionId,
            forked: false,
            workingDirectory: fallback.cwd,
            projectPath: fallback.cwd,
            additionalDirs: [],
            gitContext: null,
            worktreeBaseBranch: null,
            changedFiles: [],
            contextWindow: null,
            model: fallback.model ?? '',
            preferredModel: fallback.model,
            reasoningEffort: fallback.reasoningEffort,
            fastMode: false,
            permissionMode: 'auto',
            rateLimitBehavior: 'queue',
            extraInstructions: '',
          }
        : undefined
    if (!input) {
      throw new Error(`Session ${agentSessionId} isn't active and no run config was provided — open the chat to resume its automation.`)
    }
    await this.runSession(input, {
      prompt,
      displayPrompt: prompt,
      via: 'automation',
      automationId,
      automationName,
    })
  }

  async promptSession(agentSessionId: string, prompt: string): Promise<{ queued: boolean }> {
    const resident = this.activeSessions.get(agentSessionId)
    let input: SessionRunInput | undefined
    if (resident?.runInput) {
      input = { ...resident.runInput, tabId: undefined, agentSessionId, forked: false }
    } else {
      let meta: SessionMeta | null = null
      for (const agentId of this.backends.keys()) {
        meta = await this.getSessionInfo(agentId, agentSessionId)
        if (meta) break
      }
      if (!meta) throw new Error(`Session ${agentSessionId} not found`)
      input = {
        provider: meta.provider,
        agentSessionId,
        forked: false,
        workingDirectory: meta.cwd,
        projectPath: meta.cwd,
        additionalDirs: [],
        gitContext: null,
        worktreeBaseBranch: null,
        changedFiles: [],
        contextWindow: null,
        model: '',
        preferredModel: null,
        reasoningEffort: 'medium',
        fastMode: false,
        permissionMode: 'ask',
        rateLimitBehavior: 'queue',
        extraInstructions: '',
      }
    }

    const queued = !!resident && (this._isBusyStatus(resident.status) || (this.requestQueue.get(agentSessionId)?.length ?? 0) > 0)
    await this.runSession(input, { prompt, displayPrompt: prompt })
    return { queued }
  }

  stopSession(agentSessionId: string): boolean {
    const session = this.activeSessions.get(agentSessionId)
    if (!session || !this._isBusyStatus(session.status)) return false

    const queue = this.requestQueue.get(agentSessionId)
    if (queue) {
      for (let i = queue.length - 1; i >= 0; i--) {
        const req = queue[i]
        queue.splice(i, 1)
        req.reject(new Error('Interrupted'))
        this._broadcastToSessionId('event', req.agentSessionId, { type: 'prompt_dequeued', queueId: req.queueId })
        if (req.rateLimitSessionId) this._cleanupRateLimitTimerIfUnused(req.rateLimitSessionId)
      }
      this.requestQueue.delete(agentSessionId)
    }

    const cancelled = this._backendFor(session.backendId).cancelSession(agentSessionId)
    if (!cancelled) return false
    this._setStatus({ sessionId: agentSessionId }, 'interrupted')
    return true
  }

  /**
   * Start a fresh background session running `prompt` on the given agent/model —
   * the entry for the `create_session` MCP tool. Builds a plain run input (no tab)
   * and routes through `runSession`, which resolves once the new session has
   * initialized, returning its id. The caller renders a card to open it in a tab.
   */
  async createSession(req: {
    prompt: string
    provider: AgentId
    modelId: string | null
    reasoningEffort: ReasoningEffort
    contextWindow: number | null
    cwd: string
    worktreeBaseBranch?: string | null
  }): Promise<{ agentSessionId: string }> {
    const input: SessionRunInput = {
      provider: req.provider,
      agentSessionId: null,
      forked: false,
      workingDirectory: req.cwd,
      projectPath: req.cwd,
      additionalDirs: [],
      gitContext: null,
      worktreeBaseBranch: req.worktreeBaseBranch ?? null,
      changedFiles: [],
      contextWindow: req.contextWindow,
      model: req.modelId ?? '',
      preferredModel: req.modelId,
      reasoningEffort: req.reasoningEffort,
      fastMode: false,
      permissionMode: 'ask',
      rateLimitBehavior: 'queue',
      extraInstructions: '',
    }
    return this.runSession(input, { prompt: req.prompt, displayPrompt: req.prompt })
  }

  private async _startSession(
    input: SessionRunInput,
    options: PromptOptions,
  ): Promise<{ agentSessionId: string }> {
    const sourceTabId = input.tabId
    const handle = await this._dispatch(input, options, null, { returnHandle: true })
    if (handle.sessionId) return { agentSessionId: handle.sessionId }
    return new Promise<{ agentSessionId: string }>((resolve, reject) => {
      this.pendingStarts.set(handle, { sourceTabId, resolve, reject })
      handle.runPromise.catch((err) => {
        if (!this.pendingStarts.has(handle)) return
        this.pendingStarts.delete(handle)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  private _isBusyStatus(status: SessionStatus): boolean {
    return (
      status === 'connecting' ||
      status === 'running' ||
      status === 'awaiting_input' ||
      status === 'awaiting_plan' ||
      status === 'rate_limited'
    )
  }

  private _enqueueRequest(
    input: SessionRunInput,
    options: PromptOptions,
    metadata: {
      reason: QueuedPromptReason
      agentSessionId: string
      deviceId?: string
      sourceSessionId?: string
      rateLimitSessionId?: string
      releaseAt?: number
      rateLimitType?: string
    },
  ): Promise<void> {
    const sourceTabId = input.tabId
    const queueKey = metadata.agentSessionId

    let totalDepth = 0
    for (const q of this.requestQueue.values()) totalDepth += q.length
    if (totalDepth >= MAX_QUEUE_DEPTH) {
      throw new Error('Request queue full — back-pressure')
    }

    const queueId = crypto.randomUUID()
    const enqueuedAt = Date.now()
    const prompt = options.displayPrompt ?? options.prompt
    log.info(`Session ${queueKey} ${metadata.reason} — queuing request (depth: ${totalDepth + 1})`)
    this._broadcastToSessionId('event', queueKey, {
      type: 'prompt_queued',
      text: prompt,
      queueId,
      enqueuedAt,
      reason: metadata.reason,
      releaseAt: metadata.releaseAt,
      rateLimitType: metadata.rateLimitType,
      images: options.imageAttachments,
    })

    return new Promise<void>((resolve, reject) => {
      let queue = this.requestQueue.get(queueKey)
      if (!queue) { queue = []; this.requestQueue.set(queueKey, queue) }
      queue.push({
        queueId,
        prompt,
        agentSessionId: queueKey,
        sourceTabId,
        deviceId: metadata.deviceId,
        input,
        options,
        reason: metadata.reason,
        sourceSessionId: metadata.sourceSessionId,
        rateLimitSessionId: metadata.rateLimitSessionId,
        releaseAt: metadata.releaseAt,
        rateLimitType: metadata.rateLimitType,
        resolve,
        reject,
        enqueuedAt,
      })
    })
  }

  private async _dispatch(
    input: SessionRunInput,
    options: PromptOptions,
    targetAgentSessionId?: string | null,
    behavior?: { returnHandle?: false },
  ): Promise<void>
  private async _dispatch(
    input: SessionRunInput,
    options: PromptOptions,
    targetAgentSessionId: string | null | undefined,
    behavior: { returnHandle: true },
  ): Promise<RunHandle>
  private async _dispatch(
    input: SessionRunInput,
    options: PromptOptions,
    targetAgentSessionId?: string | null,
    behavior?: { returnHandle?: boolean },
  ): Promise<void | RunHandle> {
    const tabId = input.tabId ?? ''
    const tab = tabId ? this.tabs.get(tabId) : undefined
    const headlessSessionId = targetAgentSessionId ?? (tab ? null : input.agentSessionId)
    const existingSession = tab
      ? (targetAgentSessionId ? this.activeSessions.get(targetAgentSessionId) : this._sessionFor(tab))
      : headlessSessionId
        ? this.activeSessions.get(headlessSessionId)
        : undefined
    if (!tab && targetAgentSessionId === undefined && !existingSession) throw new Error(`Tab ${tabId} disappeared`)

    const existingSessionId = targetAgentSessionId ?? tab?.sessionId ?? headlessSessionId
    if (existingSessionId) this.rateLimits.clear(existingSessionId)
    if (tab) tab.lastActivityAt = Date.now()

    if (existingSession) {
      existingSession.promptCount = (existingSession.promptCount ?? 0) + 1
      existingSession.lastActivityAt = Date.now()
    }

    const incoming = input.gitContext
    const isForkingInput = !!input.forked && !!input.agentSessionId
    const sessionGitContext = isForkingInput ? null : existingSession?.gitContext
    const resolvedProjectPath = input.projectPath || input.workingDirectory
    let effectiveGitCtx = sessionGitContext ?? incoming ?? null
    if (!effectiveGitCtx?.worktreePath && resolvedProjectPath && resolvedProjectPath !== '~') {
      const statusGitCtx = tabGitContextFromStatus(await computeGitProjectStatus(resolvedProjectPath).catch(() => null))
      effectiveGitCtx = statusGitCtx
      if (existingSession) existingSession.gitContext = statusGitCtx ?? undefined
    }

    const worktreeBaseBranch = input.worktreeBaseBranch
    // Inline status card mirroring the pre-run worktree setup. The renderer
    // clears it once the session leaves 'connecting'; a failed card is kept so
    // the (otherwise swallowed) error stays visible.
    let worktreeCardActive = false
    const buildWorktreeCard = (activeIndex: number, errored = false): StatusCardState => ({
      id: `worktree-${tabId}`,
      title: errored ? 'Worktree setup failed' : 'Preparing worktree…',
      icon: 'git-branch',
      status: errored ? 'error' : 'active',
      steps: ([
        { id: 'worktree', label: 'Creating branch & worktree' },
        { id: 'workspace', label: 'Linking workspace' },
        { id: 'session', label: 'Starting agent session' },
      ]).map((s, i): StatusCardStep => ({
        id: s.id,
        label: s.label,
        status: i < activeIndex ? 'done' : i === activeIndex ? (errored ? 'error' : 'active') : 'pending',
      })),
    })
    if (worktreeBaseBranch && !effectiveGitCtx?.worktreePath && resolvedProjectPath) {
      worktreeCardActive = true
      this._broadcastToSession('event', tabId, { type: 'status_card', card: buildWorktreeCard(0) })
      try {
        const branchModel = input.provider === 'codex'
          ? 'gpt-5.4-mini'
          : 'claude-haiku-4-5-20251001'
        const gitContext: TabGitContext = await createWorktree(resolvedProjectPath, options.prompt, worktreeBaseBranch, {
          generateName: (prompt) => textGenerator.generate({
            provider: input.provider,
            cwd: resolvedProjectPath,
            prompt: buildBranchNamePrompt(prompt),
            model: branchModel,
            reasoningEffort: 'none',
            maxTurns: 1,
            timeoutMs: 30_000,
          }),
        })
        if (existingSession) existingSession.gitContext = gitContext
        effectiveGitCtx = gitContext
        log.info(`Worktree created for tab ${tabId}: ${gitContext.branch} at ${gitContext.worktreePath}`)
        this._broadcastToSession('event', tabId, { type: 'git_context', gitContext })
        // Worktree done → advance to "Linking thread workspace".
        this._broadcastToSession('event', tabId, { type: 'status_card', card: buildWorktreeCard(1) })
      } catch (e) {
        log.error(`Worktree creation failed for tab ${tabId}: ${e}`)
        this._broadcastToSession('event', tabId, { type: 'status_card', card: buildWorktreeCard(0, true) })
      }
    }

    const useWorktree = !!effectiveGitCtx?.worktreePath
    const effectiveCwd = useWorktree ? effectiveGitCtx!.worktreePath! : resolvedProjectPath

    // Start mirroring this repo's HEAD/refs/index now that the session's git
    // context is settled, so external branch/commit/stage changes flow back live.
    this._syncGitWatcher(tabId, effectiveGitCtx)

    // Prewarm the file index for the exact path the Files view will query
    // (worktree root when present, else the project) so its first open hits a
    // ready index instead of paying for the initial filesystem scan.
    if (effectiveCwd && effectiveCwd !== '~') warmFinder(effectiveCwd)

    // Workspace linked (git watcher + file index warmed) → advance to the final
    // "Starting session" step; the reducer clears the card once the run begins.
    if (worktreeCardActive) {
      this._broadcastToSession('event', tabId, { type: 'status_card', card: buildWorktreeCard(2) })
    }

    const effectiveAdditionalDirs = useWorktree && resolvedProjectPath
      ? [...new Set([...(input.additionalDirs || []), resolvedProjectPath])]
      : input.additionalDirs

    const backend = this._backendFor(input.provider)
    const sessionBackendId = existingSession?.backendId
    const canResumeWithBackend = !sessionBackendId || sessionBackendId === backend.id
    if (!canResumeWithBackend) {
      log.info(`Provider changed for tab ${tabId}: ${sessionBackendId} → ${backend.id}; starting a fresh provider session`)
      if (tab) tab.sessionId = null
    }

    const agentSessionId = canResumeWithBackend ? (targetAgentSessionId ?? tab?.sessionId ?? input.agentSessionId) : null

    const effectiveInput: SessionRunInput = {
      ...input,
      workingDirectory: effectiveCwd,
      projectPath: resolvedProjectPath,
      additionalDirs: effectiveAdditionalDirs,
      gitContext: effectiveGitCtx,
      agentSessionId,
    }

    const isForkingSession = !!effectiveInput.forked && !!effectiveInput.agentSessionId
    const dispatchSessionId = isForkingSession ? null : effectiveInput.agentSessionId
    const newStatus: SessionStatus = dispatchSessionId ? 'running' : 'connecting'
    if (tab && isForkingSession) {
      tab.sessionId = null
    }
    // Restored tabs know their session id in the renderer, but the main-process
    // tab registry starts empty after reboot. Link before session-scoped status
    // routing so the resumed turn can move the tab out of connecting.
    if (tab && dispatchSessionId && tab.sessionId !== dispatchSessionId) {
      tab.sessionId = dispatchSessionId
    }
    this._setStatus(dispatchSessionId ? { sessionId: dispatchSessionId } : { tabId }, newStatus)

    const sessionId = dispatchSessionId
    if (sessionId) {
      this.activeSessions.set(sessionId, {
        sessionId,
        backendId: backend.id,
        status: newStatus,
        pendingInputEvents: [],
        runInput: effectiveInput,
        gitContext: effectiveGitCtx ?? undefined,
        lastActivityAt: Date.now(),
        promptCount: existingSession ? existingSession.promptCount : 1,
      })
    }

    // Session started from a task: hydrate the ticket and prepend its full
    // context to the prompt so the agent already knows it. Server-side (not in
    // the renderer like bound works) because the renderer's task cache lacks the
    // hydrated comments / linked PRs that getTask pulls. Only on a brand-new
    // session, and the original text is preserved as displayPrompt so the user
    // message stays clean.
    if (options.taskId && !effectiveInput.agentSessionId) {
      const task = await this._injectTaskContext(effectiveInput.workingDirectory, options)
      // Fire-and-forget the write-back (move to In Progress + "started in Solus"
      // comment). Best-effort: a provider failure must not delay or block the run,
      // so we don't await it and swallow errors.
      void this._writeBackTaskStart(effectiveInput.workingDirectory, options.taskId, task ?? undefined)
    }

    const sourceTabId = tab?.tabId
    if (sessionId) {
      const userMessage: NormalizedEvent = {
        type: 'user_message',
        text: options.displayPrompt ?? options.prompt,
        ...(options.imageAttachments?.length ? { imageAttachments: options.imageAttachments } : {}),
        ...(options.via ? { via: options.via, automationId: options.automationId, automationName: options.automationName } : {}),
      }
      if (sourceTabId) {
        this._broadcastToSessionExcept('event', sourceTabId, sessionId, userMessage)
      } else {
        this._broadcastToSessionId('event', sessionId, userMessage)
      }
    }

    let handle: RunHandle
    try {
      const activeRun: ActiveRunRequest = { sourceTabId, input: effectiveInput, options }
      if (dispatchSessionId) {
        this.activeRunRequests.set(dispatchSessionId, activeRun)
      } else if (sourceTabId) {
        this.pendingRunRequestsByTab.set(tabId, activeRun)
        await this._logNewSessionPrompt(effectiveInput, options, backend.id)
      } else {
        await this._logNewSessionPrompt(effectiveInput, options, backend.id)
      }
      handle = backend.startRun(effectiveInput, options)
    } catch (err) {
      this.pendingRunRequestsByTab.delete(tabId)
      if (dispatchSessionId) this.activeRunRequests.delete(dispatchSessionId)
      if (sessionId) this.activeSessions.delete(sessionId)
      this._setStatus(dispatchSessionId ? { sessionId: dispatchSessionId } : { tabId }, 'failed')
      return Promise.reject(err)
    }

    if (behavior?.returnHandle) return handle
    return handle.runPromise
  }

  /** Hydrate the bound task and prepend its context to the prompt, keeping the
   *  original text as displayPrompt. A hydration failure must not block the
   *  session — we log and start without the context rather than throwing. */
  private async _injectTaskContext(cwd: string, options: PromptOptions): Promise<Task | null> {
    if (!options.taskId) return null
    try {
      const task = await getTask(cwd, options.taskId)
      const context = formatTaskContext(task)
      if (!options.displayPrompt) options.displayPrompt = options.prompt
      options.prompt = options.prompt ? `${context}\n\n${options.prompt}` : context
      return task
    } catch (err) {
      log.warn(`Failed to inject task context for ${options.taskId}: ${String(err)}`)
      return null
    }
  }

  /** Push the narrow write-back when a session starts from a task (In Progress +
   *  a "started in Solus" comment). Best-effort — provider failures (offline,
   *  read-only token, local provider with no comments) are logged, not surfaced. */
  private async _writeBackTaskStart(cwd: string, taskId: string, knownTask?: Task): Promise<void> {
    try {
      await startTaskWork(cwd, taskId, knownTask)
    } catch (err) {
      log.warn(`Task write-back failed for ${taskId}: ${String(err)}`)
    }
  }

  private async _logNewSessionPrompt(input: SessionRunInput, options: PromptOptions, provider: AgentId): Promise<void> {
    if (!IS_DEV_MODE) return

    try {
      const row = [
        options.displayPrompt ?? options.prompt,
        input.model,
        provider,
        input.reasoningEffort,
      ].map(csvCell).join(',')

      await mkdir(dirname(NEW_SESSION_PROMPTS_CSV), { recursive: true })
      let prefix = ''
      try {
        const existing = await stat(NEW_SESSION_PROMPTS_CSV)
        if (existing.size === 0) prefix = NEW_SESSION_PROMPTS_CSV_HEADER
      } catch {
        prefix = NEW_SESSION_PROMPTS_CSV_HEADER
      }
      await appendFile(NEW_SESSION_PROMPTS_CSV, `${prefix}${row}\n`, 'utf8')
    } catch (err) {
      log.warn(`Failed to log new-session prompt CSV: ${err}`)
    }
  }

  // ─── Cancel ───

  cancelTab(ctx: IpcContext): boolean {
    const tabId = ctx.session.tabId
    const tab = this.tabs.get(tabId)

    this._drainQueueForTab(tabId)

    // Try session-based cancel first
    const session = tab ? this._sessionFor(tab) : undefined
    if (session?.sessionId) {
      const backend = this._backendFor(session.backendId)
      const cancelled = backend.cancelSession(session.sessionId)
      if (cancelled) this._setStatus({ tabId }, 'interrupted')
      return cancelled
    }

    // Fall back to pre-session_init handles owned by any backend.
    for (const b of this.backends.values()) {
      const handle = b.getPendingHandles().find((h) => (h.sourceTabId ?? h.tabId) === tabId)
      if (!handle) continue
      handle.abortController.abort()
      this._setStatus({ tabId }, 'interrupted')
      return true
    }

    return false
  }

  private _drainQueueForTab(tabId: string): void {
    const sessionId = this.tabs.get(tabId)?.sessionId
    const reason = new Error('Interrupted')
    const queueKey = sessionId ?? tabId
    const queue = this.requestQueue.get(queueKey)
    if (queue) {
      for (let i = queue.length - 1; i >= 0; i--) {
        const req = queue[i]
        if (req.sourceTabId !== tabId) continue
        queue.splice(i, 1)
        req.reject(reason)
        this._broadcastToSessionId('event', req.agentSessionId, { type: 'prompt_dequeued', queueId: req.queueId })
        if (req.rateLimitSessionId) this._cleanupRateLimitTimerIfUnused(req.rateLimitSessionId)
        log.info(`Drained queued request ${req.queueId} for interrupted tab ${tabId}`)
      }
      if (queue.length === 0) this.requestQueue.delete(queueKey)
    }
  }

  cancelQueuedPrompt(ctx: IpcContext, queueId: string): boolean {
    const tabId = ctx.session.tabId
    const sessionId = this.tabs.get(tabId)?.sessionId ?? ctx.session.agentSessionId
    if (!sessionId) return false
    return this.cancelQueuedPromptForSession(sessionId, queueId)
  }

  cancelQueuedPromptForSession(agentSessionId: string, queueId: string): boolean {
    const queue = this.requestQueue.get(agentSessionId)
    if (!queue) return false
    const idx = queue.findIndex((r) => r.queueId === queueId)
    if (idx === -1) return false
    const [req] = queue.splice(idx, 1)
    req.reject(new Error('Cancelled by user'))
    this._broadcastToSessionId('event', req.agentSessionId, { type: 'prompt_dequeued', queueId: req.queueId })
    if (req.rateLimitSessionId) this._cleanupRateLimitTimerIfUnused(req.rateLimitSessionId)
    if (queue.length === 0) this.requestQueue.delete(agentSessionId)
    log.info(`Cancelled queued request ${queueId} for session ${agentSessionId}`)
    return true
  }

  /** Re-submit the same prompt. If the tab is dead, drop the session so a fresh one starts. */
  async retry(ctx: IpcContext, options: PromptOptions): Promise<void> {
    const tabId = ctx.session.tabId
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error(`Tab ${tabId} does not exist`)

    if (tab.status === 'dead') {
      tab.sessionId = null
      this._setStatus({ tabId }, 'idle')
    }

    await this._run(runInputFromContext(ctx), options, {})
  }

  async rewindTabFiles(ctx: IpcContext, checkpointId: string): Promise<void> {
    const tab = this.tabs.get(ctx.session.tabId)
    if (!tab || !tab.sessionId) throw new Error('No session for tab')
    const session = this._sessionFor(tab)
    const backend = this._backendFor(session?.backendId ?? (session?.runInput?.provider ?? ctx.session.provider ?? ctx.settings.activeAgent))
    if (!backend) throw new Error('No backend found for tab session')
    if (!backend.rewindFiles) throw new Error('Active backend does not support file rewind')
    const cwd = session?.gitContext?.worktreePath || ctx.session.workingDirectory
    await backend.rewindFiles(tab.sessionId, checkpointId, cwd)
  }

  respondToPermission(_ctx: IpcContext, questionId: string, optionId: string, updatedPlan?: string): boolean {
    const backend = this._backendForQuestion(questionId)
    const backends = backend ? [backend] : Array.from(this.backends.values())
    for (const b of backends) {
      const pendingInfo = b.permissions.getPendingInfo(questionId)
      if (b.permissions.respondToPermission(questionId, optionId, updatedPlan)) {
        this._clearPendingInputEvent(questionId)
        this.questionIdToSession.delete(questionId)
        if (pendingInfo?.toolName === 'ExitPlanMode' && optionId === 'deny') {
          const sessionId = pendingInfo.sessionId
          if (sessionId) {
            b.cancelSession(sessionId)
            this._setStatus({ sessionId }, 'interrupted')
          }
        }
        return true
      }
    }
    return false
  }

  respondToQuestion(_ctx: IpcContext, questionId: string, answers: Record<string, string>): boolean {
    const backend = this._backendForQuestion(questionId)
    const backends = backend ? [backend] : Array.from(this.backends.values())
    for (const b of backends) {
      if (b.permissions.respondToQuestion(questionId, answers)) {
        this._clearPendingInputEvent(questionId)
        this.questionIdToSession.delete(questionId)
        return true
      }
    }
    return false
  }

  private _backendForQuestion(questionId: string): AgentBackend | undefined {
    const sessionId = this.questionIdToSession.get(questionId)
    if (!sessionId) return undefined
    const session = this.activeSessions.get(sessionId)
    if (!session) return undefined
    return this.backends.get(session.backendId)
  }

  resolveRateLimit(ctx: IpcContext, action: RateLimitDecisionAction): boolean {
    const tab = this.tabs.get(ctx.session.tabId)
    const sessionId = tab?.sessionId ?? ctx.session.agentSessionId
    if (!sessionId) return false

    if (action === 'wait') {
      const event = this._currentRateLimitEvent(sessionId)
      if (event?.type !== 'rate_limit') return false
      this._queueActiveRateLimitedRequest(sessionId)
      this._scheduleRateLimitRelease(sessionId, event.resetsAt)
      return true
    }

    if (action === 'stop') {
      this._clearRateLimitTimer(sessionId)
      this.rateLimits.clear(sessionId)
      this._setStatus({ sessionId }, 'idle')
      this._rejectRateLimitQueue(sessionId, new Error('Rate-limited prompts stopped'))
      this._broadcastRateLimitResolved(sessionId, action)
      return true
    }

    this._queueActiveRateLimitedRequest(sessionId)
    this._releaseRateLimitQueue(sessionId, action)
    return true
  }

  getMetadataFor(id: AgentId): AgentMetadata | undefined {
    return this.backends.get(id)?.metadata
  }

  getBackendIds(): AgentId[] {
    return Array.from(this.backends.keys())
  }

  async refreshSessionIndexes(): Promise<void> {
    await Promise.all(
      [...this.backends.values()].map((backend) => backend.refreshSessionIndex?.()),
    )
  }

  getTransportInfo(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [id, backend] of this.backends) {
      result[id] = backend.metadata.capabilities?.transport || (id === 'claude-code' ? 'claude-sdk/stream-json' : 'unknown')
    }
    return result
  }

  private _currentRateLimitEvent(sessionId: string | null | undefined): Extract<NormalizedEvent, { type: 'rate_limit' }> | null {
    if (!sessionId) return null
    const hadActive = this.rateLimits.hasActive(sessionId)
    const event = this.rateLimits.current(sessionId, Date.now() / 1000)
    if (!event && hadActive) {
      this._releaseRateLimitQueue(sessionId, 'wait')
      return null
    }

    return event
  }

  // ─── Worktree registry helpers (used by main's worktree IPC handlers) ───

  setTabGitContext(tabId: string, gitContext: TabGitContext | undefined): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const session = this._sessionFor(tab)
    if (session) session.gitContext = gitContext
    this._syncGitWatcher(tabId, gitContext ?? null)
  }

  /**
   * Register/deregister the live git watcher for a tab as its git context comes
   * and goes. Keyed by repoRoot so tabs sharing a repo share one watcher; the
   * per-tab key is tracked so teardown ref-counts correctly even when the
   * context changes (e.g. branch → worktree).
   */
  private _syncGitWatcher(tabId: string, gitContext: TabGitContext | null): void {
    const candidate = gitContext?.repoRoot ?? gitContext?.worktreePath ?? null
    const nextKey = candidate && candidate !== '~' ? candidate : null
    const prevKey = this.tabWatchKeys.get(tabId) ?? null
    if (prevKey === nextKey) return
    if (prevKey) {
      this.gitWatcher.deregister(prevKey)
      this.tabWatchKeys.delete(tabId)
    }
    if (nextKey) {
      this.gitWatcher.register(nextKey)
      this.tabWatchKeys.set(tabId, nextKey)
    }
  }

  /**
   * A watched repo changed on disk. Recompute branch + status for every tab in
   * that repo (deduped by working dir) and broadcast so the renderer mirrors it
   * without a click. Branch goes out as the already-handled `git_context`
   * event; dirty files/conflicts as the lightweight `git_status` event. Line
   * totals and PR discovery are refreshed only while the Git panel is visible.
   */
  private async _onGitWatchFire(repoRoot: string): Promise<void> {
    const tabIds = [...this.tabWatchKeys.entries()].filter(([, key]) => key === repoRoot).map(([id]) => id)
    if (!tabIds.length) return

    const statusByCwd = new Map<string, Awaited<ReturnType<typeof computeGitProjectStatus>>>()
    // Whether each cwd's status actually changed since its last broadcast —
    // decided once per cwd so tabs sharing a cwd all deliver (or all skip) together.
    const changedByCwd = new Map<string, boolean>()
    for (const tabId of tabIds) {
      const tab = this.tabs.get(tabId)
      const session = tab ? this._sessionFor(tab) : undefined
      if (!session?.gitContext) continue
      // Mirror the renderer's status key: worktree path, else the session's working dir.
      const cwd = session.gitContext.worktreePath ?? session.runInput?.workingDirectory ?? session.gitContext.repoRoot ?? null
      if (!cwd || cwd === '~') continue

      if (!statusByCwd.has(cwd)) {
        const computed = await computeGitProjectStatus(cwd)
        statusByCwd.set(cwd, computed)
        const serialized = JSON.stringify(computed)
        const changed = this.lastGitStatusByCwd.get(cwd) !== serialized
        if (changed) this.lastGitStatusByCwd.set(cwd, serialized)
        changedByCwd.set(cwd, changed)
      }
      const status = statusByCwd.get(cwd) ?? null

      const liveBranch = status?.branch
      if (liveBranch && liveBranch !== session.gitContext.branch) {
        const gitContext: TabGitContext = { ...session.gitContext, branch: liveBranch }
        session.gitContext = gitContext
        this._broadcastToSession('event', tabId, { type: 'git_context', gitContext })
      }
      // Skip the git_status broadcast when nothing changed since the last fire —
      // belt-and-braces to cut IPC to hidden windows (the renderer diffs too).
      if (changedByCwd.get(cwd)) {
        this._broadcastToSession('event', tabId, { type: 'git_status', cwd, status })
      }
    }
  }

  listGitContexts(): Array<TabGitContext & { tabId: string }> {
    const result: Array<TabGitContext & { tabId: string }> = []
    for (const [tabId, tab] of this.tabs) {
      const session = this._sessionFor(tab)
      if (session?.gitContext?.worktreePath) result.push({ ...session.gitContext, tabId })
    }
    return result
  }

  getGitContext(tabId: string): TabGitContext | undefined {
    const tab = this.tabs.get(tabId)
    return tab ? this._sessionFor(tab)?.gitContext : undefined
  }

  private _isQueuedRequestReady(req: QueuedRequest): boolean {
    if (req.reason !== 'rate_limit') return true
    if (!req.rateLimitSessionId) return true
    const event = this.rateLimits.current(req.rateLimitSessionId, Date.now() / 1000)
    if (!event) return true
    return event.resetsAt * 1000 <= Date.now()
  }

  private _scheduleRateLimitRelease(sessionId: string, resetsAt: number): void {
    this._clearRateLimitTimer(sessionId)
    const delay = Math.max(resetsAt * 1000 - Date.now(), 0)
    const timer = setTimeout(() => this._releaseRateLimitQueue(sessionId, 'wait'), delay)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.rateLimitTimers.set(sessionId, timer)
  }

  private _clearRateLimitTimer(sessionId: string): void {
    const timer = this.rateLimitTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.rateLimitTimers.delete(sessionId)
    }
  }

  private _cleanupRateLimitTimerIfUnused(sessionId: string): void {
    const queue = this.requestQueue.get(sessionId) ?? []
    if (queue.some((r) => r.rateLimitSessionId === sessionId)) return
    this._clearRateLimitTimer(sessionId)
    this.rateLimits.clear(sessionId)
  }

  private _queueActiveRateLimitedRequest(sessionId: string): boolean {
    const event = this._currentRateLimitEvent(sessionId)
    if (event?.type !== 'rate_limit') return false

    const queue = this.requestQueue.get(sessionId) ?? []
    if (queue.some((r) => r.rateLimitSessionId === sessionId)) return false

    const run = this.activeRunRequests.get(sessionId)
    if (!run) return false

    void this._enqueueRequest(run.input, run.options, {
      agentSessionId: sessionId,
      reason: 'rate_limit',
      rateLimitSessionId: sessionId,
      releaseAt: event.resetsAt,
      rateLimitType: event.rateLimitType,
    }).catch((err) => {
      log.error(`Failed to queue rate-limited request for session ${sessionId}: ${err}`)
    })
    this.activeRunRequests.delete(sessionId)
    return true
  }

  private _releaseRateLimitQueue(sessionId: string, action: RateLimitDecisionAction): void {
    this._clearRateLimitTimer(sessionId)
    this.rateLimits.clear(sessionId)

    for (const req of this.requestQueue.get(sessionId) ?? []) {
      if (req.rateLimitSessionId !== sessionId) continue
      req.releaseAt = undefined
    }

    const hasQueued = (this.requestQueue.get(sessionId) ?? []).some((req) => req.rateLimitSessionId === sessionId)
    const session = this.activeSessions.get(sessionId)
    if (hasQueued || session?.status !== 'running') {
      this._setStatus({ sessionId }, hasQueued ? 'running' : 'idle')
    }
    this._broadcastRateLimitResolved(sessionId, action)
    this._processQueueForSession(sessionId)
  }

  private _rejectRateLimitQueue(sessionId: string, reason: Error): void {
    const queue = this.requestQueue.get(sessionId)
    if (!queue) return
    for (let i = queue.length - 1; i >= 0; i--) {
      const req = queue[i]
      if (req.rateLimitSessionId !== sessionId) continue
      queue.splice(i, 1)
      req.reject(reason)
      this._broadcastToSessionId('event', req.agentSessionId, { type: 'prompt_dequeued', queueId: req.queueId })
    }
    if (queue.length === 0) this.requestQueue.delete(sessionId)
  }

  private _broadcastRateLimitResolved(sessionId: string, action: RateLimitDecisionAction): void {
    for (const [tabId, tab] of this.tabs) {
      if (tab.sessionId === sessionId) {
        this.emit('event', tabId, { type: 'rate_limit_resolved', sessionId, action })
      }
    }
  }

  private _processQueueForSession(sessionId: string): boolean {
    const queue = sessionId ? this.requestQueue.get(sessionId) : undefined
    if (!queue?.length) return false

    // Only process the oldest (first) request. If it isn't ready yet, don't
    // skip ahead — the queue is FIFO and later entries may depend on this one.
    const req = queue[0]
    if (!this._isQueuedRequestReady(req)) return false

    queue.shift()
    if (queue.length === 0) this.requestQueue.delete(sessionId)
    log.info(`Processing queued request ${req.queueId}`)

    this._broadcastToSessionId('event', req.agentSessionId, { type: 'prompt_dequeued', queueId: req.queueId })

    if (req.sourceTabId && req.options) {
      this.emit('event', req.sourceTabId, {
        type: 'user_message',
        text: req.options.displayPrompt ?? req.options.prompt,
        ...(req.options.imageAttachments?.length ? { imageAttachments: req.options.imageAttachments } : {}),
        ...(req.options.via ? { via: req.options.via, automationId: req.options.automationId, automationName: req.options.automationName } : {}),
      })
    }

    const reqInput = req.input as SessionRunInput
    const dispatchSession = this.activeSessions.get(req.agentSessionId)
    const freshProvider = dispatchSession?.backendId ?? reqInput.provider
    const input: SessionRunInput = {
      ...reqInput,
      tabId: req.sourceTabId,
      provider: freshProvider,
      agentSessionId: req.agentSessionId,
    }

    this._dispatch(input, req.options as PromptOptions, req.agentSessionId)
      .then((v) => req.resolve(v))
      .catch((e) => req.reject(e))
    return true
  }

  private _findTabsBySession(sessionId: string): string[] {
    const tabIds: string[] = []
    for (const [tabId, tab] of this.tabs) {
      if (tab.sessionId === sessionId) tabIds.push(tabId)
    }
    return tabIds
  }

  private _backendFor(id: AgentId): AgentBackend {
    const backend = this.backends.get(id)
    if (!backend) throw new Error(`Unknown agent provider: ${id}`)
    return backend
  }

  private _queuedPromptsForSession(sessionId: string): QueuedPromptSnapshot[] {
    const queue = this.requestQueue.get(sessionId) ?? []
    return queue
      .map((r) => ({
        queueId: r.queueId,
        text: r.prompt,
        enqueuedAt: r.enqueuedAt,
        reason: r.reason,
        releaseAt: r.releaseAt,
        rateLimitType: r.rateLimitType,
        images: r.options?.imageAttachments,
      }))
  }

  private _checkActiveRuns(): void {
    for (const [tabId, tab] of this.tabs) {
      if (tab.status !== 'running' && tab.status !== 'connecting') continue
      const session = this._sessionFor(tab)
      const sessionId = session?.sessionId
      if (!sessionId) continue

      const backend = this.backends.get(session.backendId)
      const alive = !!backend?.isSessionRunning(sessionId)
      const hasPendingRun = !alive && !!backend?.getPendingHandles().some((h) => h.sessionId === sessionId)
      if (alive || hasPendingRun) {
        this.missingRunCounts.delete(sessionId)
        continue
      }

      const misses = (this.missingRunCounts.get(sessionId) ?? 0) + 1
      this.missingRunCounts.set(sessionId, misses)
      if (misses < RUN_WATCHDOG_MISSES) continue

      log.warn(`Active session ${sessionId} for tab ${tabId} is no longer running; marking tab dead`)
      this._markSessionDead(tabId, sessionId)
    }

    for (const [sessionId, session] of this.activeSessions) {
      const hasWatchingTab = [...this.tabs.values()].some((t) => t.sessionId === sessionId)
      if (hasWatchingTab) continue

      const backend = this._backendFor(session.backendId)
      if (backend.isSessionRunning(sessionId)) {
        this.missingRunCounts.delete(sessionId)
        continue
      }

      const misses = (this.missingRunCounts.get(sessionId) ?? 0) + 1
      this.missingRunCounts.set(sessionId, misses)
      if (misses < RUN_WATCHDOG_MISSES) continue

      log.warn(`Unwatched session ${sessionId} no longer running; cleaning up`)
      this.activeSessions.delete(sessionId)
      this.missingRunCounts.delete(sessionId)
      backend.permissions.clearPendingForSession(sessionId)
    }
  }

  private _markSessionDead(tabId: string, sessionId: string): void {
    const backend = this.activeSessions.get(sessionId)
      ? this._backendFor(this.activeSessions.get(sessionId)!.backendId)
      : undefined
    backend?.permissions.clearPendingForSession(sessionId)
    this._flushPendingTab(tabId, false)

    const tab = this.tabs.get(tabId)
    if (!tab) return

    this._currentRateLimitEvent(tab.sessionId)
    const session = this._sessionFor(tab)
    if (session) {
      session.hasPendingInput = false
      session.pendingInputEvents = []
    }
    this.activeSessions.delete(sessionId)
    this.missingRunCounts.delete(sessionId)

    this._broadcastToSession('event', tabId, {
      type: 'session_dead',
      exitCode: null,
      signal: null,
      stderrTail: [],
    })
    this._setStatus({ tabId }, 'dead')
    this._processQueueForSession(sessionId)
  }

  private _pendingInputStatus(session: { hasPendingInput?: boolean; pendingInputEvents: NormalizedEvent[] }): SessionStatus {
    if (!session.hasPendingInput) return 'running'
    const hasPlan = session.pendingInputEvents.some((e) => e.type === 'plan')
    const hasOtherInput = session.pendingInputEvents.some(
      (e) => e.type === 'permission_request' || e.type === 'question_request',
    )
    return hasPlan && !hasOtherInput ? 'awaiting_plan' : 'awaiting_input'
  }

  /** Drive the server-side attention entry from a session status transition.
   *  Creating states (awaiting_input / completed / failed) record an entry;
   *  active/neutral states (running / idle / interrupted) resolve it. The
   *  service dedupes, so calling this on no-op transitions is cheap. */
  private _syncAttention(sessionId: string, newStatus: SessionStatus): void {
    const session = this.activeSessions.get(sessionId)
    const pendingEvent = session
      ? [...session.pendingInputEvents].reverse().find(
          (e) => e.type === 'permission_request' || e.type === 'question_request',
        )
      : undefined
    const pending = pendingEvent?.type === 'question_request'
      ? 'question'
      : pendingEvent?.type === 'permission_request'
        ? 'permission'
        : null

    const action = attentionActionForStatus(newStatus, pending)
    if (action.type === 'ignore') return
    if (action.type === 'resolve') {
      this.attention.resolve(sessionId)
      return
    }

    // projectKey/summary are best-effort: on the process-exit path the session
    // is already gone, so finished/failed entries may carry neither.
    const projectKey = session?.gitContext?.repoRoot
      ?? session?.runInput?.projectPath
      ?? session?.runInput?.workingDirectory
    this.attention.set({
      sessionId,
      kind: action.kind,
      summary: this._attentionSummary(action.kind, pendingEvent),
      projectKey,
    })
  }

  private _attentionSummary(kind: AttentionKind, event?: NormalizedEvent): string {
    switch (kind) {
      case 'needs_approval':
        return event?.type === 'permission_request'
          ? `Approval needed: ${event.toolName}`
          : 'Approval needed'
      case 'question': {
        const q = event?.type === 'question_request' ? event.questions[0]?.question : undefined
        return q ? `Question: ${q.length > 120 ? `${q.slice(0, 117)}…` : q}` : 'Waiting on your answer'
      }
      case 'finished':
        return 'Turn finished'
      case 'failed':
        return 'Run failed'
    }
  }

  private _setStatus(target: { tabId?: string; sessionId?: string }, newStatus: SessionStatus): void {
    const sessionId = target.sessionId ?? (target.tabId ? this.tabs.get(target.tabId)?.sessionId : undefined)

    if (sessionId) this._syncAttention(sessionId, newStatus)

    if (!sessionId) {
      const tabId = target.tabId
      if (!tabId) return
      const tab = this.tabs.get(tabId)
      if (!tab) return
      const oldStatus = tab.status
      if (oldStatus === newStatus) return
      tab.status = newStatus
      log.info(`Tab ${tabId}: ${oldStatus} → ${newStatus}`)
      this._broadcastToSession('event', tabId, { type: 'status_change', status: newStatus, oldStatus })
      return
    }

    const session = this.activeSessions.get(sessionId)
    if (!session) {
      for (const [tabId, tab] of this.tabs) {
        if (tab.sessionId !== sessionId) continue
        if (tab.status === newStatus) continue
        const oldStatus = tab.status
        tab.status = newStatus
        log.info(`Tab ${tabId}: ${oldStatus} → ${newStatus}`)
        this.emit('event', tabId, { type: 'status_change', status: newStatus, oldStatus })
      }
      return
    }

    if (session.status !== newStatus) {
      session.status = newStatus
    }

    if (newStatus === 'interrupted' && session.pendingInputEvents.length > 0) {
      const hasPendingPlans = session.pendingInputEvents.some((e) => e.type === 'plan')
      if (hasPendingPlans) {
        session.pendingInputEvents = session.pendingInputEvents.filter((e) => e.type !== 'plan')
        session.hasPendingInput = session.pendingInputEvents.length > 0
      }
    }

    for (const [tabId, tab] of this.tabs) {
      if (tab.sessionId !== sessionId) continue
      if (tab.status === newStatus) continue
      const oldStatus = tab.status
      tab.status = newStatus
      log.info(`Tab ${tabId}: ${oldStatus} → ${newStatus}`)
      this.emit('event', tabId, { type: 'status_change', status: newStatus, oldStatus })
    }
  }

  shutdown(): void {
    log.info('Shutting down control plane')
    if (this.runWatchdogTimer) {
      clearInterval(this.runWatchdogTimer)
      this.runWatchdogTimer = null
    }
    for (const timer of this.rateLimitTimers.values()) clearTimeout(timer)
    this.rateLimitTimers.clear()
    this.rateLimits.clearAll()
    for (const timer of this.disconnectedClientTimers.values()) this.clearGcTimeout(timer)
    this.disconnectedClientTimers.clear()
    this.disconnectedClients.clear()

    for (const [sessionId, session] of this.activeSessions) {
      const backend = this._backendFor(session.backendId)
      backend.cancelSession(sessionId)
    }
    this.activeSessions.clear()

    for (const backend of this.backends.values()) {
      for (const handle of backend.getPendingHandles()) {
        handle.abortController.abort()
      }
    }

    for (const [tabId] of this.tabs) {
      this._closeTabById(tabId)
    }
    for (const backend of this.backends.values()) {
      try {
        backend.shutdown?.()
      } catch (err) {
        log.warn(`Backend ${backend.id} shutdown failed: ${(err as Error).message}`)
      }
    }
    this._stopTextFlushTimer()
  }

  private _ensureTextFlushTimer(): void {
    if (this.textFlushTimer) return
    this.textFlushTimer = setInterval(() => {
      if (this.pendingFlush.size === 0) {
        this._stopTextFlushTimer()
        return
      }
      // keep=true: a streaming tool/turn is still in flight, so retain the buffer
      // markers to keep coalescing subsequent deltas instead of re-emitting each
      // one immediately.
      for (const tabId of [...this.pendingFlush.keys()]) {
        this._flushPendingTab(tabId, true)
      }
    }, TEXT_FLUSH_INTERVAL_MS)
  }

  private _stopTextFlushTimer(): void {
    if (this.textFlushTimer) {
      clearInterval(this.textFlushTimer)
      this.textFlushTimer = null
    }
  }

  private _broadcastToSession(topic: string, tabId: string, ...args: unknown[]): void {
    const tab = this.tabs.get(tabId)
    const sessionId = tab?.sessionId
    if (!sessionId) {
      this.emit(topic, tabId, ...args)
      return
    }
    for (const [tid, t] of this.tabs) {
      if (t.sessionId === sessionId) {
        this.emit(topic, tid, ...args)
      }
    }
  }

  private _broadcastToSessionId(topic: string, sessionId: string, ...args: unknown[]): void {
    for (const [tid, t] of this.tabs) {
      if (t.sessionId === sessionId) {
        this.emit(topic, tid, ...args)
      }
    }
  }

  /** Broadcast to all tabs on the session except the submitting tab. */
  private _broadcastToSessionExcept(topic: string, excludeTabId: string, sessionId: string | null, ...args: unknown[]): void {
    if (!sessionId) return
    for (const [tid, t] of this.tabs) {
      if (t.sessionId === sessionId && tid !== excludeTabId) {
        this.emit(topic, tid, ...args)
      }
    }
  }


  private _clearPendingInputEvent(questionId: string): void {
    const match = (e: NormalizedEvent) => 'questionId' in e && (e as any).questionId === questionId

    for (const session of this.activeSessions.values()) {
      if (!session.pendingInputEvents.length) continue
      const before = session.pendingInputEvents.length
      session.pendingInputEvents = session.pendingInputEvents.filter((e) => !match(e))
      session.hasPendingInput = session.pendingInputEvents.length > 0

      if (session.pendingInputEvents.length !== before) {
        this._setStatus({ sessionId: session.sessionId }, this._pendingInputStatus(session))
        const remaining = [...session.pendingInputEvents]
        for (const [tabId, tab] of this.tabs) {
          if (tab.sessionId !== session.sessionId) continue
          this.emit('event', tabId, { type: 'pending_input_sync', pendingInputEvents: remaining })
        }
      }
    }
  }

  /** Emit a tab's buffered text immediately (first-chunk latency), keeping the marker so the rest batch. */
  private _flushPendingText(tabId: string): void {
    const text = this.pendingFlush.get(tabId)
    if (!text) return
    this.emit('event', tabId, { type: 'text_chunk', text })
    this.pendingFlush.set(tabId, '')
  }

  /**
   * Drain a tab's buffered text. `keep=true` (interval tick) resets the marker to ''
   * when there was data so an active stream keeps batching, and drops the idle marker
   * so the timer can settle; `keep=false` (boundary/exit) drops it so ordering with
   * the triggering event holds.
   */
  private _flushPendingTab(tabId: string, keep: boolean): void {
    const text = this.pendingFlush.get(tabId)
    if (text === undefined) return
    if (text) this.emit('event', tabId, { type: 'text_chunk', text })
    if (keep && text) this.pendingFlush.set(tabId, '')
    else this.pendingFlush.delete(tabId)
  }
}
