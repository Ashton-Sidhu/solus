import { EventEmitter } from 'events'
import { appendFile, mkdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { createLogger } from './logger'
import { createWorktree, buildBranchNamePrompt } from './git/worktree-manager'
import { computeGitState } from './git/git-helpers'
import { GitWatcher } from './git/git-watcher'
import { warmFinder } from './server/file-finder'
import { TextGenerator } from './agents/text-generator'
import { runInputFromContext } from './agents/run-input'
import { buildHandoff, composeHandoffSeed } from './agents/session-handoff'
import { RateLimitState } from './rate-limits'
import { AttentionService, attentionActionForStatus } from './attention/attention-service'
import type { AttentionKind } from '../shared/attention-types'
import { getTask, formatTaskContext, startTaskWork } from './tasks/task-service'
import { getIndexedSession, persistIndexedSessionStart } from './db/session-indexer'
import {
  buildSessionAwaitingInputReport,
  buildSessionSettledReport,
  formatPendingInputReport,
} from './sessions/session-report'
import type { AgentBackend, RunHandle } from './agents/agent-backend'
import type {
  AgentId,
  AgentMetadata,
  BackendSession,
  SessionStatus,
  TabRegistryEntry,
  NormalizedEvent,
  GitCheckout,
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
  SessionProviderSwitchResult,
  StatusCardState,
  StatusCardStep,
  ThreadGoal,
  ThreadGoalSetRequest,
} from '../shared/types'
import { encodePathAsFolder, gitCheckoutFromState } from '../shared/types'
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
  deviceId?: string
  run: SessionRunRequest
  reason: QueuedPromptReason
  resolve: (value: void) => void
  reject: (reason: Error) => void
  enqueuedAt: number
  sourceSessionId?: string
  rateLimitSessionId?: string
  releaseAt?: number
  rateLimitType?: string
}

interface PendingStart {
  run: SessionRunRequest
  resolve: (value: { agentSessionId: string }) => void
  reject: (reason: Error) => void
}

export interface SessionRunLifecycle {
  agentSessionId: Promise<{ agentSessionId: string }>
  done: Promise<{ output?: string }>
  cancel: () => void
  disposition: 'started' | 'queued'
}

export type DispatchTarget =
  | { kind: 'new-session' }
  | { kind: 'session'; sessionId: string }

export interface SessionRunRequest {
  target: DispatchTarget
  input: SessionRunInput
  options: PromptOptions
  sourceTabId?: string
}

interface StartedRun {
  handle: RunHandle
  run: SessionRunRequest
}

interface TabOwner {
  clientId: string
  deviceId?: string
}

interface DisconnectedClient {
  deviceId?: string
  deadline: number
}

interface PendingSessionHandoff {
  fromProvider: AgentId
  fromSessionId: string
}

interface ControlPlaneOptions {
  tabDisconnectGraceMs?: number
  now?: () => number
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
  buildHandoff?: typeof buildHandoff
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
  private hadActiveWork = false
  private requestQueue = new Map<string, QueuedRequest[]>()
  private activeRunRequests = new Map<string, SessionRunRequest>()
  private pendingStarts = new Map<RunHandle, PendingStart>()
  private pendingHandoffs = new Map<string, PendingSessionHandoff>()
  private sessionSettlementWatchers = new Map<string, Set<string>>()
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
  /** Git identity for every tab, including idle tabs with no backend session. */
  private tabGitEnvironments = new Map<string, { cwd: string; gitContext: GitCheckout }>()
  /** tabId → checkout path currently registered with the watcher, for correct ref-counted teardown. */
  private tabWatchKeys = new Map<string, string>()
  /** cwd → last broadcast git_status (serialized), so an unchanged watcher fire
   *  doesn't re-broadcast identical status to every (possibly hidden) window. */
  private lastGitStatusByCwd = new Map<string, string>()
  private gitWatchRefreshes = new Map<string, Promise<void>>()
  private pendingGitWatchRefreshes = new Set<string>()
  private readonly tabDisconnectGraceMs: number
  private readonly now: () => number
  private readonly setGcTimeout: typeof setTimeout
  private readonly clearGcTimeout: typeof clearTimeout
  private readonly handoffBuilder: typeof buildHandoff

  constructor(backends: Map<AgentId, AgentBackend>, opts: ControlPlaneOptions = {}) {
    super()
    this.backends = backends
    this.tabDisconnectGraceMs = opts.tabDisconnectGraceMs ?? TAB_DISCONNECT_GRACE_MS
    this.now = opts.now ?? (() => Date.now())
    this.setGcTimeout = opts.setTimeout ?? setTimeout
    this.clearGcTimeout = opts.clearTimeout ?? clearTimeout
    this.handoffBuilder = opts.buildHandoff ?? buildHandoff
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
        const pendingStart = initHandle ? this.pendingStarts.get(initHandle) : undefined
        const initTabId = initHandle?.sourceTabId
        const initTab = initTabId ? this.tabs.get(initTabId) : undefined
        const pendingHandoff = initTabId ? this.pendingHandoffs.get(initTabId) : undefined
        if (initTab) {
          initTab.provider = backend.id
          if (pendingHandoff) {
            const handoffFrom = {
              provider: pendingHandoff.fromProvider,
              sessionId: pendingHandoff.fromSessionId,
            }
            initTab.handoffFrom = handoffFrom
            event = { ...event, handoffFrom }
            this.pendingHandoffs.delete(initTabId!)
          }
        }
        let initializedRun = pendingStart?.run
        if (initHandle) {
          if (pendingStart) {
            this.pendingStarts.delete(initHandle)
            initializedRun = {
              ...pendingStart.run,
              target: { kind: 'session', sessionId: event.sessionId },
              input: {
                ...pendingStart.run.input,
                agentSessionId: event.sessionId,
                forked: false,
              },
            }
            this.activeRunRequests.set(event.sessionId, initializedRun)
            pendingStart.resolve({ agentSessionId: event.sessionId })
          }
          if (initTab && !initTab.sessionId) {
            initTab.sessionId = event.sessionId
          }
        }
        // Preserve the run contract so a reattaching client (e.g. after a
        // refresh) can read back the live status, model config and permission
        // mode via bindRuntimeSession, and a backgrounded automation can
        // re-dispatch by run input alone. Without this, a first-run session has
        // no runInput and bind returns null, leaving the tab stuck at idle.
        const existingSession = this.activeSessions.get(event.sessionId)
        const runReqInput = this.activeRunRequests.get(event.sessionId)?.input ?? initializedRun?.input
        if (runReqInput) {
          persistIndexedSessionStart(
            event.sessionId,
            backend.id,
            runReqInput.workingDirectory,
            encodePathAsFolder(runReqInput.workingDirectory),
            runReqInput.model,
            runReqInput.reasoningEffort,
          )
        }
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
        this._notifyActiveWork()
      }

      const session = this.activeSessions.get(sessionId)
      if (session) {
        session.lastActivityAt = Date.now()

        if (event.type === 'permission_request' || event.type === 'question_request') {
          session.hasPendingInput = true
          session.pendingInputEvents.push(event)
          this.questionIdToSession.set(event.questionId, session.sessionId)
          this._setStatus({ sessionId: session.sessionId }, 'awaiting_input')
          this._fireAwaitingInputWatchers(session.sessionId, 'awaiting_input')
        } else if (event.type === 'plan') {
          session.hasPendingInput = true
          session.pendingInputEvents.push(event)
          this.questionIdToSession.set(event.questionId, session.sessionId)
          const status = this._pendingInputStatus(session)
          this._setStatus({ sessionId: session.sessionId }, status)
          if (status === 'awaiting_input' || status === 'awaiting_plan') {
            this._fireAwaitingInputWatchers(session.sessionId, status)
          }
        } else if (event.type === 'permission_resolved') {
          session.pendingInputEvents = session.pendingInputEvents.filter(
            (e) => !('questionId' in e && (e as any).questionId === event.questionId),
          )
          this.questionIdToSession.delete(event.questionId)
          session.hasPendingInput = session.pendingInputEvents.length > 0
          this._setStatus({ sessionId: session.sessionId }, this._pendingInputStatus(session))
        }

        // Both task lifecycle events fall through to tab routing below: an async
        // sub-agent's card can only track the agent through them, since the SDK
        // answers its tool call at launch rather than at completion.
        if (event.type === 'background_task_started') {
          ;(session.backgroundTaskIds ??= new Set()).add(event.taskId)
          log.info(`Task ${event.taskId} started for session ${session.sessionId} (${session.backgroundTaskIds.size} in flight)`)
          // A task can be backgrounded after the turn already settled to idle;
          // pull the session back to running so it reflects the in-flight work.
          if (!this._isBusyStatus(session.status)) this._setStatus({ sessionId: session.sessionId }, 'running')
        }

        if (event.type === 'background_task_settled') {
          session.backgroundTaskIds?.delete(event.taskId)
          log.info(`Task ${event.taskId} settled (${event.status}) for session ${session.sessionId} (${session.backgroundTaskIds?.size ?? 0} still in flight)`)
          // Don't force idle here — the still-open query drives the real terminal
          // status via its next task_complete (set now empty) or its exit event.
        }

        if (event.type === 'task_complete') {
          const handle = backend.getSessionHandle(session.sessionId)
          if (handle) handle.resultText = event.result
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
          tab.provider = backend.id
          if (event.handoffFrom) tab.handoffFrom = event.handoffFrom
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
        listeningTabIds = pendingHandles.map((h) => h.sourceTabId).filter((tabId): tabId is string => !!tabId)
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
      const hasPendingRateLimit = rateLimitEvent != null
      const exitWasRateLimited = hasPendingRateLimit && rateLimitEvent.deferCurrentRun !== true
      const newStatus: SessionStatus = exitWasRateLimited
        ? 'rate_limited'
        : code === 0
        ? 'completed'
        : signal === 'SIGINT' || signal === 'SIGKILL'
          ? 'interrupted'
            : code === null
            ? 'dead'
            : 'failed'

      if (sessionId && !hasPendingRateLimit) {
        this.activeSessions.delete(sessionId)
        this.activeRunRequests.delete(sessionId)
      }
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
        tabId = pendingHandles.map((h) => h.sourceTabId).find(Boolean) ?? null
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
      provider: null,
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

  bindRuntimeSession(
    tabId: string,
    sessionId: string,
    tabOwner: TabOwner,
    handoffFrom?: TabRegistryEntry['handoffFrom'],
    provider?: AgentId | null,
  ): RuntimeSessionInfo | null {
    const tab = this.tabs.get(tabId)
    if (!tab) return null
    if (!this._tabBelongsToOwner(tab, tabOwner)) return null
    this._adoptDisconnectedSessionWatch(tabId, sessionId, tabOwner)

    tab.sessionId = sessionId
    tab.provider = provider ?? tab.provider
    if (handoffFrom) tab.handoffFrom = handoffFrom
    tab.clientId = tabOwner.clientId
    tab.deviceId = tabOwner.deviceId

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

    tab.provider = session.backendId
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
      handoffFrom: tab.handoffFrom,
    }
  }

  /** Clear stored session ID so _dispatch won't inject a stale --resume. */
  resetTabSession(ctx: IpcContext, owner: TabOwner): void {
    const tab = this.tabs.get(ctx.session.tabId)
    if (!tab) return
    if (!this._tabBelongsToOwner(tab, owner)) return
    const session = this._sessionFor(tab)
    log.info(`Resetting session for tab ${ctx.session.tabId} (was: ${tab.sessionId})`)
    if (tab.sessionId) {
      this.rateLimits.clear(tab.sessionId)
    }
    tab.sessionId = null
    tab.status = 'idle'

    if (session) {
      session.runInput = { ...runInputFromContext(ctx), agentSessionId: null }
      session.gitContext = ctx.session.gitContext ?? undefined
    }
    this.setTabGitEnvironment(ctx.session.tabId, ctx.session.workingDirectory, ctx.session.gitContext)
  }

  async listSessionsForProviders(agentIds: AgentId[], projectPath: string, onBatch?: (sessions: SessionMeta[]) => void, limitPerProvider?: number): Promise<SessionMeta[]> {
    const settled = await Promise.allSettled(
      agentIds.map((agentId) => this._backendFor(agentId).listSessions(projectPath, onBatch, limitPerProvider)),
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

  async switchSessionProvider(tabId: string, newProvider: AgentId): Promise<SessionProviderSwitchResult> {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error(`Tab ${tabId} does not exist`)
    if (!tab.sessionId) throw new Error(`Tab ${tabId} has no live session to switch`)

    const oldSessionId = tab.sessionId
    const session = this.activeSessions.get(oldSessionId)
    const indexedSession = session ? null : getIndexedSession(oldSessionId)
    const fromProvider = session?.backendId ?? indexedSession?.provider ?? tab.provider
    if (!fromProvider) {
      throw new Error(`Session ${oldSessionId} has no provider information for a handoff`)
    }
    if (fromProvider === newProvider) {
      throw new Error(`Session ${oldSessionId} already uses ${newProvider}`)
    }
    this._backendFor(newProvider)
    const status = session?.status ?? tab.status
    if (this._isBusyStatus(status)) {
      throw new Error(`Session ${oldSessionId} must be idle before switching providers (current status: ${status})`)
    }
    if ((this.requestQueue.get(oldSessionId)?.length ?? 0) > 0) {
      throw new Error(`Session ${oldSessionId} has queued prompts and cannot switch providers`)
    }

    // Swap the tab over immediately — the actual transcript/summary handoff is
    // built lazily in _launchRun, right before the next prompt starts the new
    // provider's session, so the switch itself never blocks on an LLM call.
    this.pendingHandoffs.set(tabId, { fromProvider, fromSessionId: oldSessionId })
    tab.provider = newProvider
    tab.sessionId = null
    this._setStatus({ tabId }, 'idle')

    return { fromProvider, fromSessionId: oldSessionId }
  }

  async getSessionInfo(sessionId: string): Promise<SessionMeta | null> {
    const meta = getIndexedSession(sessionId)
    if (!meta) return null
    const active = this.activeSessions.get(sessionId)
    if (active) {
      meta.provider = active.backendId
      meta.status = this._currentRateLimitEvent(sessionId) ? 'rate_limited' : active.status
      meta.lastTimestamp = new Date(active.lastActivityAt).toISOString()
    }
    return meta
  }

  liveSessionStatus(agentSessionId: string): SessionStatus | null {
    const pendingRateLimit = this._currentRateLimitEvent(agentSessionId)
    if (pendingRateLimit) return 'rate_limited'
    return this.activeSessions.get(agentSessionId)?.status ?? null
  }

  pendingInputEventsForSession(agentSessionId: string): NormalizedEvent[] {
    return [...(this.activeSessions.get(agentSessionId)?.pendingInputEvents ?? [])]
  }

  watchSessionSettled(targetSessionId: string, callerSessionId: string): void {
    if (targetSessionId === callerSessionId) {
      throw new Error('Cannot watch your own session.')
    }

    let watchers = this.sessionSettlementWatchers.get(targetSessionId)
    if (!watchers) {
      watchers = new Set()
      this.sessionSettlementWatchers.set(targetSessionId, watchers)
    }
    watchers.add(callerSessionId)

    const status = this.liveSessionStatus(targetSessionId)
    if (status === 'awaiting_input' || status === 'awaiting_plan') {
      this._fireAwaitingInputWatchers(targetSessionId, status)
    }
  }

  loadSessionPreview(agentId: AgentId, sessionId: string, projectPath?: string): Promise<SessionPreviewResult> {
    const backend = this._backendFor(agentId)
    if (backend.loadSessionPreview) return backend.loadSessionPreview(sessionId, projectPath)
    return backend.loadSession(sessionId, projectPath).then((allMsgs) => {
      // Reasoning turns ride along for provider handoffs; a preview shows real
      // conversation, so drop them before sampling the head/tail.
      const msgs = allMsgs.filter((m) => m.role !== 'reasoning')
      return {
        head: msgs.slice(0, 4),
        tail: msgs.slice(-1),
        totalMessages: msgs.length,
      }
    })
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

  isPendingAttentionLive(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId)
    if (!session?.pendingInputEvents.some(
      (event) => event.type === 'permission_request' || event.type === 'question_request',
    )) return false
    return [...this.tabs.values()].some((tab) => tab.sessionId === sessionId)
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
        if (req.run.sourceTabId === tabId) req.run.sourceTabId = undefined
      }
    }

    this.pendingFlush.delete(tabId)
    this.pendingHandoffs.delete(tabId)
    this._syncGitWatcher(tabId, null)
    this.tabGitEnvironments.delete(tabId)
    this.tabs.delete(tabId)
    if (tab.sessionId && ![...this.tabs.values()].some((candidate) => candidate.sessionId === tab.sessionId)) {
      this.attention.resolve(tab.sessionId)
    }
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

  /** The only execution entry point. Every caller supplies an explicit target
   * and receives the same lifecycle whether the turn starts now or queues. */
  async runTurn(request: SessionRunRequest, deviceId?: string): Promise<SessionRunLifecycle> {
    if (request.target.kind === 'session') {
      const agentSessionId = request.target.sessionId
      const session = this.activeSessions.get(agentSessionId)
      if (session) {
        const pendingRateLimit = this._currentRateLimitEvent(agentSessionId)
        if (
          pendingRateLimit?.type === 'rate_limit' &&
          (request.input.rateLimitBehavior === 'ask' || request.input.rateLimitBehavior === 'queue')
        ) {
          return this._enqueueRequest(request, {
            agentSessionId,
            reason: 'rate_limit',
            deviceId,
            rateLimitSessionId: agentSessionId,
            releaseAt: pendingRateLimit.resetsAt,
            rateLimitType: pendingRateLimit.rateLimitType,
          })
        }

        const hasQueuedForSession = (this.requestQueue.get(agentSessionId)?.length ?? 0) > 0
        if (this._isBusyStatus(session.status) || hasQueuedForSession) {
          return this._enqueueRequest(request, {
            agentSessionId,
            reason: 'busy',
            deviceId,
          })
        }
      }
    }

    return this._startRunLifecycle(request)
  }

  /** Submit a prompt to a tab and resolve once it has started or queued. */
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
    const input = runInputFromContext(ctx)
    const sessionId = this.tabs.get(tabId)?.sessionId ?? input.agentSessionId
    const target: DispatchTarget = !input.forked && sessionId
      ? { kind: 'session', sessionId }
      : { kind: 'new-session' }
    const lifecycle = await this.runTurn({ input, target, sourceTabId: tabId, options }, deviceId)
    await lifecycle.agentSessionId
  }

  /**
   * Dispatch an automation's prompt *into* an agent session so it runs in-thread
   * with full conversation context (the "run in this chat" path). Builds a plain
   * run input from the session's last run (when resident) or the automation's own
   * config fallback (when not), so a backgrounded or cold session resumes from
   * disk rather than failing. The tabId is left unset so the injected message
   * broadcasts to every tab watching the session. Routes through `runTurn`, so
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
      ? { ...resident, agentSessionId, forked: false }
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
            sessionChangedFiles: [],
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
    const lifecycle = await this.runTurn({
      input,
      target: { kind: 'session', sessionId: agentSessionId },
      options: {
        prompt,
        displayPrompt: prompt,
        via: 'automation',
        automationId,
        automationName,
      },
    })
    await lifecycle.done
  }

  async promptSession(agentSessionId: string, prompt: string): Promise<{ queued: boolean }> {
    const resident = this.activeSessions.get(agentSessionId)
    let input: SessionRunInput | undefined
    if (resident?.runInput) {
      input = { ...resident.runInput, agentSessionId, forked: false }
    } else {
      const meta = await this.getSessionInfo(agentSessionId)
      if (!meta) throw new Error(`Session ${agentSessionId} not found`)
      if (!meta.model || !meta.reasoningEffort) {
        throw new Error(`Session ${agentSessionId} has no persisted starting model configuration`)
      }
      input = {
        provider: meta.provider,
        agentSessionId,
        forked: false,
        workingDirectory: meta.cwd,
        projectPath: meta.cwd,
        additionalDirs: [],
        gitContext: null,
        worktreeBaseBranch: null,
        sessionChangedFiles: [],
        contextWindow: null,
        model: meta.model,
        preferredModel: meta.model,
        reasoningEffort: meta.reasoningEffort,
        fastMode: false,
        permissionMode: 'ask',
        rateLimitBehavior: 'queue',
        extraInstructions: '',
      }
    }

    const lifecycle = await this.runTurn({
      input,
      target: { kind: 'session', sessionId: agentSessionId },
      options: { prompt, displayPrompt: prompt },
    })
    return { queued: lifecycle.disposition === 'queued' }
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
   * and routes through `runTurn`, resolving once the new session has
   * initialized, returning its id. The caller renders a card to open it in a tab.
   */
  async createSession(req: {
    prompt: string
    provider: AgentId
    modelId: string
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
      sessionChangedFiles: [],
      contextWindow: req.contextWindow,
      model: req.modelId,
      preferredModel: req.modelId,
      reasoningEffort: req.reasoningEffort,
      fastMode: false,
      permissionMode: 'auto',
      rateLimitBehavior: 'queue',
      extraInstructions: '',
    }
    const lifecycle = await this.runTurn({
      input,
      target: { kind: 'new-session' },
      options: { prompt: req.prompt, displayPrompt: req.prompt },
    })
    return lifecycle.agentSessionId
  }

  /** Start an isolated automation as a normal headless session. The session id
   *  resolves at session_init so the UI can attach while `done` continues to
   *  track the same backend RunHandle through completion. */
  async startAutomationSession(req: {
    prompt: string
    automationId: string
    automationName: string
    provider: AgentId
    modelId: string | null
    reasoningEffort: ReasoningEffort
    cwd: string
    gitContext?: GitCheckout | null
    abortSignal?: AbortSignal
  }): Promise<{ agentSessionId: string; done: Promise<{ output?: string }> }> {
    const input: SessionRunInput = {
      provider: req.provider,
      agentSessionId: null,
      forked: false,
      workingDirectory: req.cwd,
      projectPath: req.cwd,
      additionalDirs: [],
      gitContext: req.gitContext ?? null,
      worktreeBaseBranch: null,
      sessionChangedFiles: [],
      contextWindow: null,
      model: req.modelId ?? '',
      preferredModel: req.modelId,
      reasoningEffort: req.reasoningEffort,
      fastMode: false,
      permissionMode: 'auto',
      rateLimitBehavior: 'queue',
      toolProfile: 'automation',
      extraInstructions: '',
    }
    const lifecycle = await this.runTurn({
      input,
      target: { kind: 'new-session' },
      options: {
        prompt: req.prompt,
        displayPrompt: req.prompt,
        via: 'automation',
        automationId: req.automationId,
        automationName: req.automationName,
      },
    })
    const cancel = () => lifecycle.cancel()
    if (req.abortSignal) {
      if (req.abortSignal.aborted) cancel()
      else req.abortSignal.addEventListener('abort', cancel, { once: true })
    }
    const trackedDone = lifecycle.done.finally(() => req.abortSignal?.removeEventListener('abort', cancel))
    void trackedDone.catch(() => {})
    try {
      const { agentSessionId } = await lifecycle.agentSessionId
      const done = trackedDone.then(async (result) => {
        if (result.output) return result
        const messages = await this.loadSession(
          req.provider,
          agentSessionId,
          req.gitContext?.worktreePath ?? req.cwd,
        ).catch(() => [])
        const output = messages
          .filter((message) => message.role === 'assistant' && !message.parentToolUseId && message.content)
          .map((message) => message.content)
          .join('\n\n')
        return output ? { output } : {}
      })
      return { agentSessionId, done }
    } catch (err) {
      await trackedDone.catch(() => {})
      throw err
    }
  }

  private async _startRunLifecycle(request: SessionRunRequest): Promise<SessionRunLifecycle> {
    const { handle, run } = await this._launchRun(request)
    const agentSessionId = handle.sessionId
      ? Promise.resolve({ agentSessionId: handle.sessionId })
      : new Promise<{ agentSessionId: string }>((resolve, reject) => {
          this.pendingStarts.set(handle, {
            run,
            resolve,
            reject,
          })
          handle.runPromise.then(
            () => {
              if (!this.pendingStarts.has(handle)) return
              this.pendingStarts.delete(handle)
              reject(new Error('Run completed before session_init'))
            },
            (err) => {
              if (!this.pendingStarts.has(handle)) return
              this.pendingStarts.delete(handle)
              reject(err instanceof Error ? err : new Error(String(err)))
            },
          )
        })
    const settledSessionId = () => handle.sessionId
      ?? (request.target.kind === 'session' ? request.target.sessionId : null)
    const done = handle.runPromise.then(
      () => {
        const sessionId = settledSessionId()
        if (sessionId) {
          const status: SessionStatus = handle.abortController.signal.aborted ? 'interrupted' : 'completed'
          void this._fireSettledSessionWatchers(sessionId, status, handle.resultText, request.input)
        }
        return handle.resultText ? { output: handle.resultText } : {}
      },
      (error) => {
        const sessionId = settledSessionId()
        if (sessionId) {
          const status: SessionStatus = handle.abortController.signal.aborted ? 'interrupted' : 'failed'
          void this._fireSettledSessionWatchers(sessionId, status, handle.resultText, request.input)
        }
        throw error
      },
    )
    void done.catch(() => {})
    return {
      agentSessionId,
      done,
      cancel: () => {
        if (handle.sessionId && this.stopSession(handle.sessionId)) return
        handle.abortController.abort()
      },
      disposition: 'started',
    }
  }

  private _takeSessionWatchers(targetSessionId: string): string[] {
    const watchers = this.sessionSettlementWatchers.get(targetSessionId)
    if (!watchers?.size) return []
    this.sessionSettlementWatchers.delete(targetSessionId)
    return [...watchers]
  }

  private _dispatchSessionReport(callerSessionIds: string[], prompt: string): void {
    for (const callerSessionId of callerSessionIds) {
      void this.promptSession(callerSessionId, prompt).catch((error) => {
        log.warn(`Failed to report watched session completion to ${callerSessionId}: ${String(error)}`)
      })
    }
  }

  private _fireAwaitingInputWatchers(
    targetSessionId: string,
    status: 'awaiting_input' | 'awaiting_plan',
  ): void {
    const session = this.activeSessions.get(targetSessionId)
    if (!session) return
    const pendingInput = formatPendingInputReport(session.pendingInputEvents)
    if (!pendingInput) return
    const watchers = this._takeSessionWatchers(targetSessionId)
    if (!watchers.length) return
    this._dispatchSessionReport(
      watchers,
      buildSessionAwaitingInputReport(targetSessionId, status, pendingInput),
    )
  }

  private async _fireSettledSessionWatchers(
    targetSessionId: string,
    status: SessionStatus,
    resultText: string | undefined,
    input: SessionRunInput,
  ): Promise<void> {
    const watchers = this._takeSessionWatchers(targetSessionId)
    if (!watchers.length) return

    let finalText = resultText?.trim()
    if (!finalText) {
      const messages = await this.loadSession(
        input.provider,
        targetSessionId,
        input.projectPath || input.workingDirectory,
      ).catch(() => [])
      finalText = [...messages].reverse().find(
        (message) => message.role === 'assistant' && !message.parentToolUseId && message.content,
      )?.content?.trim()
    }

    this._dispatchSessionReport(
      watchers,
      buildSessionSettledReport(targetSessionId, status, finalText || '(no final assistant reply available)'),
    )
  }

  /**
   * True while any agent is actually executing ('connecting'/'running').
   * Narrower than _isBusyStatus on purpose: sessions parked on user input or a
   * rate-limit reset consume no compute, so they must not hold the process
   * power-save blocker (see syncPowerSaveBlocker in main/index.ts).
   */
  hasActiveWork(): boolean {
    for (const tab of this.tabs.values()) {
      if (tab.status === 'connecting' || tab.status === 'running') return true
    }
    for (const session of this.activeSessions.values()) {
      if (session.status === 'connecting' || session.status === 'running') return true
    }
    return false
  }

  private _notifyActiveWork(): void {
    const active = this.hasActiveWork()
    if (active === this.hadActiveWork) return
    this.hadActiveWork = active
    this.emit('active-work-changed', active)
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
    run: SessionRunRequest,
    metadata: {
      reason: QueuedPromptReason
      agentSessionId: string
      deviceId?: string
      sourceSessionId?: string
      rateLimitSessionId?: string
      releaseAt?: number
      rateLimitType?: string
    },
  ): SessionRunLifecycle {
    const { options } = run
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

    let resolveDone!: () => void
    let rejectDone!: (reason: Error) => void
    const queuedDone = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    let queue = this.requestQueue.get(queueKey)
    if (!queue) { queue = []; this.requestQueue.set(queueKey, queue) }
    queue.push({
      queueId,
      prompt,
      agentSessionId: queueKey,
      deviceId: metadata.deviceId,
      run,
      reason: metadata.reason,
      sourceSessionId: metadata.sourceSessionId,
      rateLimitSessionId: metadata.rateLimitSessionId,
      releaseAt: metadata.releaseAt,
      rateLimitType: metadata.rateLimitType,
      resolve: resolveDone,
      reject: rejectDone,
      enqueuedAt,
    })

    const done = queuedDone.then(() => ({}))
    void done.catch(() => {})
    return {
      agentSessionId: Promise.resolve({ agentSessionId: queueKey }),
      done,
      cancel: () => { this.cancelQueuedPromptForSession(queueKey, queueId) },
      disposition: 'queued',
    }
  }

  private async _launchRun(request: SessionRunRequest): Promise<StartedRun> {
    const { input, target, options, sourceTabId: tabId } = request
    const tab = tabId ? this.tabs.get(tabId) : undefined
    const pendingHandoff = tabId ? this.pendingHandoffs.get(tabId) : undefined
    const existingSessionId = target.kind === 'session' ? target.sessionId : undefined
    const existingSession = existingSessionId ? this.activeSessions.get(existingSessionId) : undefined
    const provider = pendingHandoff && tab?.provider ? tab.provider : input.provider
    const backend = this._backendFor(provider)
    if (existingSessionId) this.rateLimits.clear(existingSessionId)
    if (tab) tab.lastActivityAt = Date.now()

    if (existingSession) {
      existingSession.promptCount = (existingSession.promptCount ?? 0) + 1
      existingSession.lastActivityAt = Date.now()
    }

    const incoming = input.gitContext
    const isForkingInput = !pendingHandoff && !!input.forked && !!input.agentSessionId
    const sessionGitContext = isForkingInput ? null : existingSession?.gitContext
    const resolvedProjectPath = input.projectPath || input.workingDirectory
    let effectiveGitCtx = sessionGitContext ?? incoming ?? null
    if (!effectiveGitCtx?.worktreePath && resolvedProjectPath && resolvedProjectPath !== '~') {
      const statusGitCtx = gitCheckoutFromState(await computeGitState(resolvedProjectPath).catch(() => null))
      effectiveGitCtx = statusGitCtx
      if (existingSession) existingSession.gitContext = statusGitCtx ?? undefined
    }

    const worktreeBaseBranch = input.worktreeBaseBranch
    // Inline status card mirroring the pre-run worktree setup. The renderer
    // clears it once the session leaves 'connecting'; a failed card is kept so
    // the (otherwise swallowed) error stays visible.
    let worktreeCardActive = false
    const buildWorktreeCard = (activeIndex: number, errored = false): StatusCardState => ({
      id: `worktree-${tabId ?? 'headless'}`,
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
      if (tabId) this._broadcastToSession('event', tabId, { type: 'status_card', card: buildWorktreeCard(0) })
      try {
        const branchModel = provider === 'codex'
          ? 'gpt-5.4-mini'
          : 'claude-haiku-4-5-20251001'
        const gitContext: GitCheckout = await createWorktree(resolvedProjectPath, options.prompt, worktreeBaseBranch, {
          generateName: (prompt) => textGenerator.generate({
            provider,
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
        log.info(`Worktree created for ${tabId ? `tab ${tabId}` : 'headless session'}: ${gitContext.branch} at ${gitContext.worktreePath}`)
        if (tabId) this._broadcastToSession('event', tabId, { type: 'git_context', gitContext })
        // Worktree done → advance to "Linking thread workspace".
        if (tabId) this._broadcastToSession('event', tabId, { type: 'status_card', card: buildWorktreeCard(1) })
      } catch (e) {
        log.error(`Worktree creation failed for ${tabId ? `tab ${tabId}` : 'headless session'}: ${e}`)
        if (tabId) this._broadcastToSession('event', tabId, { type: 'status_card', card: buildWorktreeCard(0, true) })
      }
    }

    const useWorktree = !!effectiveGitCtx?.worktreePath
    const effectiveCwd = useWorktree ? effectiveGitCtx!.worktreePath! : resolvedProjectPath

    // Start mirroring this repo's HEAD/refs/index now that the session's git
    // context is settled, so external branch/commit/stage changes flow back live.
    if (tab && tabId) this.setTabGitEnvironment(tabId, effectiveCwd, effectiveGitCtx)

    // Prewarm the file index for the exact path the Files view will query
    // (worktree root when present, else the project) so its first open hits a
    // ready index instead of paying for the initial filesystem scan.
    if (effectiveCwd && effectiveCwd !== '~') warmFinder(effectiveCwd)

    // Workspace linked (git watcher + file index warmed) → advance to the final
    // "Starting session" step; the reducer clears the card once the run begins.
    if (worktreeCardActive && tabId) {
      this._broadcastToSession('event', tabId, { type: 'status_card', card: buildWorktreeCard(2) })
    }

    const effectiveAdditionalDirs = useWorktree && resolvedProjectPath
      ? [...new Set([...(input.additionalDirs || []), resolvedProjectPath])]
      : input.additionalDirs

    // The provider switch itself is instant (see switchSessionProvider); the
    // handoff transcript is only assembled now, on the first prompt sent to the
    // new provider. It's a local read (on-disk transcript, no LLM call), so
    // this stays fast.
    let handoffPayload: SessionRunInput['handoff']
    if (pendingHandoff) {
      const handoffBackend = this._backendFor(pendingHandoff.fromProvider)
      const handoff = await this.handoffBuilder(pendingHandoff.fromSessionId, resolvedProjectPath, {
        loadSession: (sessionId, loadProjectPath) => handoffBackend.loadSession(sessionId, loadProjectPath),
      })
      handoffPayload = {
        fromProvider: pendingHandoff.fromProvider,
        fromSessionId: pendingHandoff.fromSessionId,
        seedSystemAppend: composeHandoffSeed({ fromProvider: pendingHandoff.fromProvider, ...handoff }),
      }
    }

    const agentSessionId = pendingHandoff
      ? null
      : existingSessionId ?? (input.forked ? input.agentSessionId : null)

    const effectiveInput: SessionRunInput = {
      ...input,
      provider,
      workingDirectory: effectiveCwd,
      projectPath: resolvedProjectPath,
      additionalDirs: effectiveAdditionalDirs,
      gitContext: effectiveGitCtx,
      agentSessionId,
      forked: pendingHandoff ? false : input.forked,
      ...(handoffPayload ? { handoff: handoffPayload } : {}),
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
    if (tab) tab.provider = backend.id
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
      this._notifyActiveWork()
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

    const sourceTabId = request.sourceTabId
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
    const activeRun: SessionRunRequest = { ...request, input: effectiveInput }
    try {
      if (dispatchSessionId) {
        this.activeRunRequests.set(dispatchSessionId, activeRun)
      } else {
        await this._logNewSessionPrompt(effectiveInput, options, backend.id)
      }
      handle = backend.startRun(effectiveInput, options)
      handle.sourceTabId = tabId
    } catch (err) {
      if (dispatchSessionId) this.activeRunRequests.delete(dispatchSessionId)
      if (sessionId) this.activeSessions.delete(sessionId)
      this._setStatus(dispatchSessionId ? { sessionId: dispatchSessionId } : { tabId }, 'failed')
      throw err
    }

    return { handle, run: activeRun }
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
      const handle = b.getPendingHandles().find((h) => h.sourceTabId === tabId)
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
        if (req.run.sourceTabId !== tabId) continue
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

    let request: SessionRunRequest
    const input = runInputFromContext(ctx)
    if (tab.status === 'dead') {
      tab.sessionId = null
      this._setStatus({ tabId }, 'idle')
      request = { input, target: { kind: 'new-session' }, sourceTabId: tabId, options }
    } else {
      const sessionId = tab.sessionId ?? ctx.session.agentSessionId
      request = !input.forked && sessionId
        ? { input, target: { kind: 'session', sessionId }, sourceTabId: tabId, options }
        : { input, target: { kind: 'new-session' }, sourceTabId: tabId, options }
    }

    const lifecycle = await this.runTurn(request)
    await lifecycle.agentSessionId
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

  setTabGitCheckout(tabId: string, gitContext: GitCheckout | undefined): void {
    const existing = this.tabGitEnvironments.get(tabId)
    const cwd = gitContext?.worktreePath ?? existing?.cwd ?? gitContext?.repoRoot ?? '~'
    this.setTabGitEnvironment(tabId, cwd, gitContext ?? null)
  }

  /** Register the checkout a tab currently represents. This deliberately lives
   * outside BackendSession: an idle tab still needs branch/status events. */
  setTabGitEnvironment(tabId: string, cwd: string, gitContext: GitCheckout | null): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const session = this._sessionFor(tab)
    if (session) session.gitContext = gitContext ?? undefined
    if (!gitContext || !cwd || cwd === '~') {
      this.tabGitEnvironments.delete(tabId)
      this._syncGitWatcher(tabId, null)
      return
    }
    const checkoutCwd = gitContext.worktreePath ?? cwd
    this.tabGitEnvironments.set(tabId, { cwd: checkoutCwd, gitContext })
    this._syncGitWatcher(tabId, checkoutCwd)
  }

  /**
   * Register/deregister the live git watcher for a tab as its checkout comes
   * and goes. Keyed by checkout cwd so tabs sharing one checkout share watchers,
   * while linked worktrees retain their own HEAD/index targets. The
   * per-tab key is tracked so teardown ref-counts correctly even when the
   * context changes (e.g. branch → worktree).
   */
  private _syncGitWatcher(tabId: string, cwd: string | null): void {
    const nextKey = cwd && cwd !== '~' ? cwd : null
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
  private async _onGitWatchFire(watchCwd: string): Promise<void> {
    const existing = this.gitWatchRefreshes.get(watchCwd)
    if (existing) {
      this.pendingGitWatchRefreshes.add(watchCwd)
      return existing
    }
    const refresh = (async () => {
      do {
        this.pendingGitWatchRefreshes.delete(watchCwd)
        await this._refreshWatchedGitState(watchCwd)
      } while (this.pendingGitWatchRefreshes.has(watchCwd))
    })().finally(() => this.gitWatchRefreshes.delete(watchCwd))
    this.gitWatchRefreshes.set(watchCwd, refresh)
    return refresh
  }

  private async _refreshWatchedGitState(watchCwd: string): Promise<void> {
    const tabIds = [...this.tabWatchKeys.entries()].filter(([, key]) => key === watchCwd).map(([id]) => id)
    if (!tabIds.length) return

    const statusByCwd = new Map<string, Awaited<ReturnType<typeof computeGitState>>>()
    // Whether each cwd's status actually changed since its last broadcast —
    // decided once per cwd so tabs sharing a cwd all deliver (or all skip) together.
    const changedByCwd = new Map<string, boolean>()
    for (const tabId of tabIds) {
      const environment = this.tabGitEnvironments.get(tabId)
      if (!environment) continue
      const { cwd } = environment

      if (!statusByCwd.has(cwd)) {
        const computed = await computeGitState(cwd)
        statusByCwd.set(cwd, computed)
        const serialized = JSON.stringify(computed)
        const changed = this.lastGitStatusByCwd.get(cwd) !== serialized
        if (changed) this.lastGitStatusByCwd.set(cwd, serialized)
        changedByCwd.set(cwd, changed)
      }
      const status = statusByCwd.get(cwd) ?? null

      if (status) {
        const liveBranch = status.branch
        const gitContext: GitCheckout = {
          ...environment.gitContext,
          branch: liveBranch,
          ...(liveBranch === null ? { detachedHeadSha: status.headSha } : { detachedHeadSha: undefined }),
          targetBranch: status.targetBranch,
          repoRoot: status.repoRoot,
        }
        if (JSON.stringify(gitContext) !== JSON.stringify(environment.gitContext)) {
          this.tabGitEnvironments.set(tabId, { cwd, gitContext })
          const tab = this.tabs.get(tabId)
          const session = tab ? this._sessionFor(tab) : undefined
          if (session) session.gitContext = gitContext
          this.emit('event', tabId, { type: 'git_context', gitContext })
        }
      }
      // Skip the git_status broadcast when nothing changed since the last fire —
      // belt-and-braces to cut IPC to hidden windows (the renderer diffs too).
      if (changedByCwd.get(cwd)) {
        this.emit('event', tabId, { type: 'git_status', cwd, state: status })
      }
    }
  }

  listGitContexts(): Array<GitCheckout & { tabId: string }> {
    const result: Array<GitCheckout & { tabId: string }> = []
    for (const [tabId, environment] of this.tabGitEnvironments) {
      if (environment.gitContext.worktreePath) result.push({ ...environment.gitContext, tabId })
    }
    return result
  }

  getGitContext(tabId: string): GitCheckout | undefined {
    return this.tabGitEnvironments.get(tabId)?.gitContext
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

    try {
      this._enqueueRequest({
        ...run,
        target: { kind: 'session', sessionId },
        input: { ...run.input, agentSessionId: sessionId },
      }, {
        agentSessionId: sessionId,
        reason: 'rate_limit',
        rateLimitSessionId: sessionId,
        releaseAt: event.resetsAt,
        rateLimitType: event.rateLimitType,
      })
    } catch (err) {
      log.error(`Failed to queue rate-limited request for session ${sessionId}: ${err}`)
      return false
    }
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

    const { sourceTabId, options } = req.run
    if (sourceTabId) {
      this.emit('event', sourceTabId, {
        type: 'user_message',
        text: options.displayPrompt ?? options.prompt,
        ...(options.imageAttachments?.length ? { imageAttachments: options.imageAttachments } : {}),
        ...(options.via ? { via: options.via, automationId: options.automationId, automationName: options.automationName } : {}),
      })
    }

    const reqInput = req.run.input
    const dispatchSession = this.activeSessions.get(req.agentSessionId)
    const freshProvider = dispatchSession?.backendId ?? reqInput.provider
    const input: SessionRunInput = {
      ...reqInput,
      provider: freshProvider,
      agentSessionId: req.agentSessionId,
    }

    this._startRunLifecycle({
      ...req.run,
      input,
      target: { kind: 'session', sessionId: req.agentSessionId },
    })
      .then((lifecycle) => lifecycle.done)
      .then(() => req.resolve())
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
        images: r.run.options.imageAttachments,
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
      this.attention.resolve(sessionId)
    }

    // Self-heal for any active-work transition that bypassed _setStatus
    // (e.g. tab close while running); at worst the power blocker lingers one tick.
    this._notifyActiveWork()
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
    this._applyStatus(target, newStatus)
    this._notifyActiveWork()
  }

  private _applyStatus(target: { tabId?: string; sessionId?: string }, newStatus: SessionStatus): void {
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
