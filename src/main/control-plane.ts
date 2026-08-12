import { EventEmitter } from 'events'
import { appendFile, mkdir, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { createLogger } from './logger'
import { captureServerEvent } from './analytics'
import { createWorktree } from './git/worktree-manager'
import { computeGitState } from './git/git-helpers'
import { GitWatcher } from './git/git-watcher'
import { warmFinder } from './server/file-finder'
import {
  AgentRunner,
  type AgentRun,
  type AgentRunRequest,
  type AgentRunSessionState,
} from './agents/agent-runner'
import type { AgentTool } from './agents/tools/agent-tool'
import { solusToolbox } from './agents/tools/solus-toolbox'
import { createClaudeSubagentAgentTool } from './agents/claude/claude-subagent-tool'
import { createCodexSubagentAgentTool } from './agents/codex/codex-subagent-tool'
import { runInputFromContext } from './agents/run-input'
import { buildHandoff, composeHandoffSeed } from './agents/session-handoff'
import { buildSystemPrompt } from './agents/system-hint'
import { isWorkspacePath } from './workspace'
import { RateLimitState } from './rate-limits'
import { AttentionService, attentionActionForStatus } from './attention/attention-service'
import type { AttentionKind } from '../shared/attention-types'
import { prepareSessionTask, tasksForSession } from './tasks/task-sessions'
import { Task, taskSnapshot } from './tasks/task'
import { formatTaskContext } from './tasks/task-context'
import { getServerSettings } from './server/settings'
import { clearForeignTaskSnapshot, foreignTaskFor, setForeignTaskSnapshot } from './tasks/foreign-tasks'
import type { TaskSnapshot } from '../shared/task-types'
import { getIndexedSession, persistIndexedSessionStart } from './db/session-indexer'
import {
  buildSessionAwaitingInputReport,
  buildSessionSettledReport,
  formatPendingInputReport,
  agentConversationQuestionFromPendingInput,
} from './sessions/session-report'
import type { AgentConversationWatchRequest } from './sessions/session-tools'
import { ClaudeGoalStore } from './sessions/claude-goal-store'
import type { AgentBackend, RunHandle } from './agents/agent-backend'
import type {
  SessionHandoffLineage,
  AgentId,
  AgentMetadata,
  AgentUsageLimits,
  BackendSession,
  SessionStatus,
  NormalizedEvent,
  GitCheckout,
  IpcContext,
  PromptOptions,
  PromptDelivery,
  PromptDispatchResult,
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
import { defaultContextWindowFor, encodePathAsFolder, gitCheckoutFromState, isSessionBusyStatus, isSteerableStatus } from '../shared/types'
import { solusDir } from './platform/paths'
import type { SessionLoadMessage, SessionPreviewResult } from '../shared/session-history'
import { taskWorktreeKey } from '../shared/task-types'

const MAX_QUEUE_DEPTH = 32
const TEXT_FLUSH_INTERVAL_MS = 300
const RUN_WATCHDOG_INTERVAL_MS = 30_000
const RUN_WATCHDOG_MISSES = 1
const IS_DEV_MODE = Boolean(process.env.ELECTRON_RENDERER_URL)
const NEW_SESSION_PROMPTS_CSV = join(solusDir(), 'new-session-prompts.csv')
const NEW_SESSION_PROMPTS_CSV_HEADER = 'input_prompt,model,agent_provider,reasoning_level\n'

const log = createLogger('ControlPlane', 'control-plane.ts')

function csvCell(value: string | null | undefined): string {
  const text = value ?? ''
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function selectAgentTools(...groups: Array<Record<string, AgentTool>>): AgentTool[] {
  return groups.flatMap((group) => Object.values(group))
}

interface QueuedRequest {
  queueId: string
  prompt: string
  /** The session this prompt is queued against — also the `requestQueue` key. */
  sessionId: string
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
  resolve: (value: { agentSessionId: string; taskId?: string }) => void
  reject: (reason: Error) => void
}

/** An armed agent exchange. `awaitingReported` dedupes awaiting-input prose
 *  report; the watch itself survives until a settle resolves it. */
interface AgentConversationWatch extends AgentConversationWatchRequest {
  awaitingReported: boolean
  /** The caller's provider thread. Held here because the report is delivered
   *  after the caller's run exited and its session record was torn down — the
   *  thread on disk is all that is left to resume. */
  callerAgentSessionId: string
}

export interface SessionRunLifecycle {
  agentSessionId: Promise<{ agentSessionId: string; taskId?: string }>
  done: Promise<{ output?: string }>
  cancel: () => void
  disposition: 'started' | 'steered' | 'queued'
  queueId?: string
}

export type DispatchTarget =
  | { kind: 'new-session' }
  | { kind: 'session'; sessionId: string }

export interface SessionRunRequest {
  target: DispatchTarget
  input: SessionRunInput
  options: PromptOptions
  tools: AgentTool[]
  /** Solus's id for the conversation this run belongs to — the address every
   *  map in ControlPlane is keyed by, and the only one a run has before the
   *  provider answers with a thread of its own. */
  sessionId: string
  /** The client that submitted, so its optimistic bubble is not echoed back to
   *  it. Unset for a run nobody is waiting on (automation, MCP, queue drain). */
  sourceClientId?: string
  /** Set when this run serves a drained queue entry, so a settle can resolve
   *  exactly the agent exchange that queued it. */
  servedQueueId?: string
}

interface StartedRun {
  handle: RunHandle
  run: SessionRunRequest
}

interface PendingSessionHandoff {
  fromProvider: AgentId
  fromSessionId: string
}

interface ControlPlaneOptions {
  buildHandoff?: typeof buildHandoff
}

/**
 * ControlPlane: the single backend authority for session lifecycle.
 *
 * One id, everywhere. Every map here is keyed by Solus's `sessionId`, and events
 * are published to the clients watching that session — a watch is just
 * `Map<sessionId, Set<clientId>>`, with no other fields, because with one id
 * space there is nothing else for it to carry. The main process has never heard
 * of a tab: how a client arranges a session on screen is its own business.
 *
 * The provider's own thread id (`agentSessionId`) is a field on BackendSession,
 * not an address. It is legal at exactly two seams — `_wireBackend`, where
 * backend events arrive tagged with it and are translated once through
 * `agentSessionToSession`, and the disk-backed readers (the session index, the
 * picker, the MCP session tools), whose rows only ever carry a provider id.
 * Anywhere else it is a bug.
 */
export class ControlPlane extends EventEmitter {
  /** sessionId → the clients listening to it. A watch has no other fields:
   *  status belongs to the session, and with one id space there is nothing
   *  else left for it to carry. */
  private watches = new Map<string, Set<string>>()
  /** Keyed by Solus's `sessionId`. */
  private activeSessions = new Map<string, BackendSession>()
  /** The one translation point. Backends emit events tagged with the provider's
   *  thread id and cannot know a Solus id, so every backend handler resolves
   *  through this map once, at its top.
   *
   *  It is an identity index, not run state, so it outlives the run: clearing it
   *  when a session exits would mint a *new* Solus id every time a conversation
   *  is resumed by provider id — from the picker, an automation, or an agent's
   *  session report — which is exactly the instability this design exists to
   *  remove. Cleared only at shutdown. A second one of these is a design
   *  regression, not a convenience. */
  private agentSessionToSession = new Map<string, string>()
  private hadActiveWork = false
  private requestQueue = new Map<string, QueuedRequest[]>()
  private activeRunRequests = new Map<string, SessionRunRequest>()
  private pendingStarts = new Map<RunHandle, PendingStart>()
  /** Worktree setup begins before an agent RunHandle exists, so it needs its
   *  own cancellation path for Stop/Ctrl-C. */
  private pendingSetupControllers = new Map<string, AbortController>()
  private pendingHandoffs = new Map<string, PendingSessionHandoff>()
  /** Armed agent exchanges: target session → caller session → FIFO of exchanges
   *  awaiting that target's next settlements. In-memory only (lost on restart). */
  private agentConversationWatches = new Map<string, Map<string, AgentConversationWatch[]>>()
  private backends: Map<AgentId, AgentBackend>
  private agentRunner: AgentRunner
  private activeAgentRuns = new Set<AgentRun>()
  private activeUnattendedAgentRuns = new Set<AgentRun>()
  private readonly claudeGoals = new ClaudeGoalStore()

  /**
   * Per-session pending buffer of streaming main-thread text (sessionId →
   * buffered text; the key's presence marks an active stream, so '' is
   * meaningful). Flushed on the 300ms interval and before any non-buffered event
   * for that session. The first chunk emits immediately for latency; the rest
   * batch into one event per flush — one stream, one chunking, however many
   * clients are watching.
   */
  private pendingFlush = new Map<string, string>()
  /** Per-session accumulator for all text in the current streaming turn. Read by bindRuntimeSession so late joiners see in-flight text. */
  // Chunks for the in-flight turn, kept as an array so accumulation is O(1) per
  // token instead of O(n²) string concatenation. Joined once if a late-joining
  // client needs to replay the turn (see bindRuntimeSession).
  private turnText = new Map<string, string[]>()
  private textFlushTimer: ReturnType<typeof setInterval> | null = null
  private runWatchdogTimer: ReturnType<typeof setInterval> | null = null
  private rateLimitTimers = new Map<string, ReturnType<typeof setTimeout>>()
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
  /** Git identity for every session, including idle ones with no backend run. */
  private sessionGitEnvironments = new Map<string, { cwd: string; gitContext: GitCheckout }>()
  /** sessionId → checkout path currently registered with the watcher, for correct ref-counted teardown. */
  private gitWatchKeys = new Map<string, string>()
  /** cwd → last broadcast git_status (serialized), so an unchanged watcher fire
   *  doesn't re-broadcast identical status to every (possibly hidden) window. */
  private lastGitStatusByCwd = new Map<string, string>()
  private gitWatchRefreshes = new Map<string, Promise<void>>()
  private pendingGitWatchRefreshes = new Set<string>()
  private readonly handoffBuilder: typeof buildHandoff

  constructor(backends: Map<AgentId, AgentBackend>, opts: ControlPlaneOptions = {}) {
    super()
    this.backends = backends
    this.agentRunner = new AgentRunner(backends)
    this.handoffBuilder = opts.buildHandoff ?? buildHandoff
    for (const backend of this.backends.values()) {
      this._wireBackend(backend)
    }
    this.gitWatcher = new GitWatcher((repoRoot) => { void this._onGitWatchFire(repoRoot) })
    this.runWatchdogTimer = setInterval(() => this._checkActiveRuns(), RUN_WATCHDOG_INTERVAL_MS)
    ;(this.runWatchdogTimer as unknown as { unref?: () => void }).unref?.()
  }

  /** Solus's id for a session named by either id space. The provider-id arm is
   *  seam (b): rows read off disk (the picker, MCP session tools, the session
   *  index) only ever hold a provider thread id. */
  private _sessionIdFor(id: string | null | undefined): string | undefined {
    if (!id) return undefined
    // A session is addressable from the moment anything is happening on its
    // behalf — a client watching it, or a worktree being prepared for it — not
    // only once it has a record and a provider thread.
    if (this.activeSessions.has(id) || this.watches.has(id) || this.pendingSetupControllers.has(id)) return id
    return this.agentSessionToSession.get(id)
  }

  /** The provider thread behind a session, for the calls that cross into a
   *  backend. Null before session_init. */
  private _agentSessionIdFor(sessionId: string): string | null {
    return this.activeSessions.get(sessionId)?.agentSessionId ?? null
  }

  private _wireBackend(backend: AgentBackend): void {
    backend.on('session-index-updated', (event) => {
      this.emit('session-index-updated', event)
    })
    backend.on('normalized', (agentSessionId: string | null, event: NormalizedEvent) => {
      // Backends only emit normalized events after session_init. Drop any stray
      // pre-init emissions (e.g. permission events that race ahead) — they'd
      // have nowhere to route.
      if (!agentSessionId) return
      const eventHandle = backend.getSessionHandle(agentSessionId)
      if (eventHandle?.persistence === 'ephemeral') return
      let initializedGoal: ThreadGoal | null = null

      // ─── Session-level state (always runs, even with nobody watching) ───

      if (event.type === 'session_init') {
        backend.permissions.setCurrentSessionId(event.sessionId)
        // Link the originating run to the freshly-issued provider thread.
        const initHandle = backend.getSessionHandle(event.sessionId)
        const pendingStart = initHandle ? this.pendingStarts.get(initHandle) : undefined
        // A fork carries the source's id to branch from, but the provider issues
        // a brand new conversation here — so this init is its first dispatch, and
        // the task minted for it still needs linking.
        const firstDispatchRun = pendingStart?.run.input.agentSessionId && !pendingStart.run.input.forked
          ? undefined
          : pendingStart?.run
        // The run carried Solus's id in from dispatch; this is where the
        // provider's own id becomes translatable to it.
        const initSessionId = initHandle?.sessionId
          ?? pendingStart?.run.sessionId
          ?? this.agentSessionToSession.get(event.sessionId)
        if (!initSessionId) {
          log.warn('session_init_without_session', { agentSessionId: event.sessionId, provider: backend.id })
          return
        }
        this.agentSessionToSession.set(event.sessionId, initSessionId)
        const pendingHandoff = this.pendingHandoffs.get(initSessionId)
        let initHandoffFrom: SessionHandoffLineage | undefined
        if (pendingHandoff) {
          initHandoffFrom = {
            provider: pendingHandoff.fromProvider,
            sessionId: pendingHandoff.fromSessionId,
          }
          event = { ...event, handoffFrom: initHandoffFrom }
          this.pendingHandoffs.delete(initSessionId)
        }
        let initializedRun = pendingStart?.run
        if (initHandle) {
          if (pendingStart) {
            this.pendingStarts.delete(initHandle)
            initializedRun = {
              ...pendingStart.run,
              target: { kind: 'session', sessionId: initSessionId },
              input: {
                ...pendingStart.run.input,
                agentSessionId: event.sessionId,
                forked: false,
              },
            }
            this.activeRunRequests.set(initSessionId, initializedRun)
            pendingStart.resolve({
              agentSessionId: event.sessionId,
              ...(pendingStart.run.options.taskId ? { taskId: pendingStart.run.options.taskId } : {}),
            })
          }
        }
        // Preserve the run contract so a reattaching client (e.g. after a
        // refresh) can read back the live status, model config and permission
        // mode via bindRuntimeSession, and a backgrounded automation can
        // re-dispatch by run input alone. Without this, a first-run session has
        // no runInput and bind returns null, leaving the session stuck at idle.
        const existingSession = this.activeSessions.get(initSessionId)
        const runReqInput = this.activeRunRequests.get(initSessionId)?.input ?? initializedRun?.input
        if (runReqInput) {
          persistIndexedSessionStart(
            event.sessionId,
            backend.id,
            runReqInput.workingDirectory,
            encodePathAsFolder(runReqInput.workingDirectory),
            runReqInput.model,
            runReqInput.reasoningEffort,
            firstDispatchRun?.options.displayPrompt ?? firstDispatchRun?.options.prompt ?? null,
          )
        }
        if (existingSession) {
          // Claude emits another init for the same session when a background
          // task notification resumes the parent. Treat it as idempotent:
          // replacing the record here would discard pending input and the
          // background task IDs that keep the session running.
          existingSession.backendId = backend.id
          existingSession.agentSessionId = event.sessionId
          if (initHandoffFrom) existingSession.handoffFrom = initHandoffFrom
          existingSession.lastActivityAt = Date.now()
          existingSession.runInput ??= runReqInput
          existingSession.gitContext ??= runReqInput?.gitContext ?? undefined
          // The record now exists from dispatch, so this init is what takes it
          // out of 'connecting'. Anything already busier than that (awaiting
          // input, rate-limited) outranks it and is left alone.
          if (existingSession.status === 'connecting' || !isSessionBusyStatus(existingSession.status)) {
            this._setStatus(initSessionId, 'running')
          }
        } else {
          this.activeSessions.set(initSessionId, {
            sessionId: initSessionId,
            agentSessionId: event.sessionId,
            backendId: backend.id,
            ...(initHandoffFrom ? { handoffFrom: initHandoffFrom } : {}),
            status: 'running',
            pendingInputEvents: [],
            lastActivityAt: Date.now(),
            promptCount: 0,
            activeTurnId: initializedRun?.options.clientPromptId ?? crypto.randomUUID(),
            runInput: runReqInput,
            gitContext: runReqInput?.gitContext ?? undefined,
          })
          // Created directly as running — _applyStatus never sees a transition,
          // so the global feed needs its own emit.
          this.emit('session-status', { sessionId: initSessionId, agentSessionId: event.sessionId, status: 'running' as SessionStatus, at: Date.now() })
        }
        const goalObjective = initializedRun?.options.goalObjective
        if (backend.id === 'claude-code' && goalObjective) {
          initializedGoal = this.claudeGoals.get(event.sessionId)
            ?? this.claudeGoals.create({ threadId: event.sessionId, objective: goalObjective })
        }
        if (firstDispatchRun?.options.taskId) {
          void this._linkPreparedTask(firstDispatchRun, event.sessionId)
        }
        this._notifyActiveWork()
      }

      const sessionId = this.agentSessionToSession.get(agentSessionId)
      const session = sessionId ? this.activeSessions.get(sessionId) : undefined
      if (session) {
        session.lastActivityAt = Date.now()

        if (event.type === 'session_changed_files_updated') {
          if (session.runInput) session.runInput.sessionChangedFiles = [...event.paths]
          const activeRequest = this.activeRunRequests.get(session.sessionId)
          if (activeRequest) activeRequest.input.sessionChangedFiles = [...event.paths]
        } else if (event.type === 'permission_request' || event.type === 'question_request') {
          session.hasPendingInput = true
          session.pendingInputEvents.push(event)
          this.questionIdToSession.set(event.questionId, session.sessionId)
          this._setStatus(session.sessionId, 'awaiting_input')
          this._fireAwaitingInputWatchers(session.sessionId, 'awaiting_input')
        } else if (event.type === 'plan') {
          // The task store indexes artifacts by the provider's thread id, which
          // is what a transcript row on disk carries.
          if (event.planToolUseId) {
            void Task.linkArtifactForSession(agentSessionId, {
              kind: 'plan',
              targetScope: agentSessionId,
              targetKey: event.planToolUseId,
            }).catch((error) => {
              log.warn('task_plan_link_failed', {
                agentSessionId,
                planToolUseId: event.planToolUseId,
                error: error instanceof Error ? error.message : String(error),
              })
            })
          }
          session.hasPendingInput = true
          session.pendingInputEvents.push(event)
          this.questionIdToSession.set(event.questionId, session.sessionId)
          const status = this._pendingInputStatus(session)
          this._setStatus(session.sessionId, status)
          if (status === 'awaiting_input' || status === 'awaiting_plan') {
            this._fireAwaitingInputWatchers(session.sessionId, status)
          }
        } else if (event.type === 'permission_resolved') {
          session.pendingInputEvents = session.pendingInputEvents.filter(
            (e) => !('questionId' in e && (e as any).questionId === event.questionId),
          )
          this.questionIdToSession.delete(event.questionId)
          session.hasPendingInput = session.pendingInputEvents.length > 0
          this._setStatus(session.sessionId, this._pendingInputStatus(session))
        }

        // Both task lifecycle events fall through to delivery below: an async
        // sub-agent's card can only track the agent through them, since the SDK
        // answers its tool call at launch rather than at completion.
        if (event.type === 'background_task_started') {
          ;(session.backgroundTaskIds ??= new Set()).add(event.taskId)
          log.info('task_started', { taskId: event.taskId, sessionId: session.sessionId, inFlight: session.backgroundTaskIds.size })
          // A task can be backgrounded after the turn already settled to idle;
          // pull the session back to running so it reflects the in-flight work.
          if (!isSessionBusyStatus(session.status)) this._setStatus(session.sessionId, 'running')
        }

        if (event.type === 'background_task_settled') {
          session.backgroundTaskIds?.delete(event.taskId)
          log.info('task_settled', { taskId: event.taskId, status: event.status, sessionId: session.sessionId, inFlight: session.backgroundTaskIds?.size ?? 0 })
          // Don't force idle here — the still-open query drives the real terminal
          // status via its next task_complete (set now empty) or its exit event.
        }

        if (event.type === 'task_complete') {
          const handle = backend.getSessionHandle(agentSessionId)
          if (handle) handle.resultText = event.result
          this.activeRunRequests.delete(session.sessionId)
          // Hold 'running' while background sub-agents are still in flight; the SDK
          // query stays open servicing them and will emit exit once they settle.
          if (session.backgroundTaskIds?.size) {
            log.info('turn_complete_tasks_in_flight', { sessionId: session.sessionId, inFlight: session.backgroundTaskIds.size, holdingRunning: true })
          } else if (this._awaitingAgentReply(session.sessionId)) {
            log.info('turn_complete_awaiting_agent_reply', { sessionId: session.sessionId, holdingRunning: true })
          } else {
            this._setStatus(session.sessionId, 'completed')
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

          this._setStatus(session.sessionId, 'rate_limited')
          if (run?.input.rateLimitBehavior === 'queue') {
            this._queueActiveRateLimitedRequest(session.sessionId)
          }
        }
      }

      if (!session && event.type === 'rate_limit') {
        // No session record to key the limit against; without one there is
        // nothing to hold the snapshot for, so route the event through as-is.
        if (!sessionId) return
        const rateLimitEvent = this.rateLimits.record(sessionId, event)
        if (!rateLimitEvent) return
        event = rateLimitEvent
      }

      if (!sessionId) return

      // ─── Delivery ───
      //
      // No early return when nobody is watching: a session with an empty watch
      // set is an ordinary count, and the buffering and turn accumulation below
      // still have to happen so a client that joins later sees the turn.

      if (event.type === 'text_chunk' && !event.parentToolUseId) {
        // Coalesce main-thread streaming text per session; the first chunk emits
        // immediately for latency and the rest batch on the flush timer. One
        // stream now produces one chunking rather than one per watcher. Child
        // text must keep its parent id so the renderer nests it in the spawning
        // subagent card instead of appending it to the main assistant reply.
        const isFirstChunk = !this.pendingFlush.has(sessionId)
        this.pendingFlush.set(sessionId, (this.pendingFlush.get(sessionId) ?? '') + event.text)
        // Text is part of the turn's replayable result, so late joiners see it.
        const chunks = this.turnText.get(sessionId)
        if (chunks) chunks.push(event.text)
        else this.turnText.set(sessionId, [event.text])
        if (isFirstChunk) this._flushPendingText(sessionId)
        this._ensureTextFlushTimer()
        return
      }

      // Any other event is a flush boundary: drain the session's pending text
      // first so the reducer never sees a later event before its buffered text.
      this._flushPendingSession(sessionId, false)
      this.turnText.delete(sessionId)

      if (backend.id === 'claude-code' && event.type === 'task_complete') {
        const goal = this.claudeGoals.recordCompletedTurn(agentSessionId, event.usage, event.durationMs)
        if (goal) this._emit(sessionId, { type: 'goal_updated', goal })
      }

      this._emit(sessionId, event)
      if (initializedGoal) this._emit(sessionId, { type: 'goal_updated', goal: initializedGoal })
    })

    backend.on('exit', (agentSessionId: string | null, code: number | null, signal: string | null) => {
      if (agentSessionId) {
        backend.permissions.clearPendingForSession(agentSessionId)
      }

      // The sessions this exit settles: the one the provider named, or — when it
      // died before ever issuing a thread — whatever runs are still pending on
      // this backend, each of which already knows its own Solus id.
      const namedSessionId = agentSessionId ? this.agentSessionToSession.get(agentSessionId) : undefined
      const settledSessionIds = namedSessionId
        ? [namedSessionId]
        : agentSessionId
          ? []
          : [...new Set(
              backend.getPendingHandles()
                .map((handle) => handle.sessionId)
                .filter((id): id is string => !!id),
            )]

      // No early return when nobody is watching: a headless agent (created via
      // create_session, card not yet opened) still needs its exit lifecycle —
      // status broadcast, cleanup, and above all the queue drain, or prompts
      // relayed into it while busy would hang forever.
      for (const handle of backend.getPendingHandles()) {
        const pending = this.pendingStarts.get(handle)
        if (pending) {
          this.pendingStarts.delete(handle)
          pending.reject(new Error(`Run exited before session_init`))
        }
      }

      for (const sessionId of settledSessionIds) {
        this.turnText.delete(sessionId)
        this._flushPendingSession(sessionId, false)
        this.missingRunCounts.delete(sessionId)

        const rateLimitEvent = this._currentRateLimitEvent(sessionId)
        const hasPendingRateLimit = rateLimitEvent != null
        const exitWasRateLimited = hasPendingRateLimit && rateLimitEvent.deferCurrentRun !== true
        const settledStatus: SessionStatus = exitWasRateLimited
          ? 'rate_limited'
          : code === 0
          ? 'completed'
          : signal === 'SIGINT' || signal === 'SIGKILL'
            ? 'interrupted'
              : code === null
              ? 'dead'
              : 'failed'
        const newStatus: SessionStatus = settledStatus === 'completed'
          && this._awaitingAgentReply(sessionId)
          ? 'running'
          : settledStatus

        // Settle the status while the record still exists, so `_applyStatus`
        // reads the real previous status and the global feed and the watching
        // clients each learn the transition exactly once. A queued prompt about
        // to take over is not a settlement, so it suppresses the terminal
        // status — asked, not dispatched, because the drain must happen after
        // the teardown below or it would delete the record its own run creates.
        const status = this.activeSessions.get(sessionId)?.status
        const queueWillTakeOver = newStatus === 'interrupted' && this._hasReadyQueuedRequest(sessionId)
        const wasStarting = status === 'connecting' || (newStatus === 'interrupted' && status === 'running')
        if (!queueWillTakeOver && !wasStarting) this._setStatus(sessionId, newStatus)

        if (!hasPendingRateLimit) {
          this.activeSessions.delete(sessionId)
          this.activeRunRequests.delete(sessionId)
        }

        if (newStatus === 'failed' || newStatus === 'dead') {
          this._emitError(sessionId, backend.getEnrichedError(agentSessionId, code))
        }

        this._processQueueForSession(sessionId)
      }
    })

    backend.on('error', (agentSessionId: string | null, err: Error) => {
      if (agentSessionId) backend.permissions.clearPendingForSession(agentSessionId)

      const namedSessionId = agentSessionId ? this.agentSessionToSession.get(agentSessionId) : undefined
      const failedSessionIds = namedSessionId
        ? [namedSessionId]
        : agentSessionId
          ? []
          : [...new Set(
              backend.getPendingHandles()
                .map((handle) => handle.sessionId)
                .filter((id): id is string => !!id),
            )]

      for (const handle of backend.getPendingHandles()) {
        const pending = this.pendingStarts.get(handle)
        if (pending) {
          this.pendingStarts.delete(handle)
          pending.reject(err)
        }
      }

      for (const sessionId of failedSessionIds) {
        const rateLimitEvent = this._currentRateLimitEvent(sessionId)
        this.missingRunCounts.delete(sessionId)

        if (rateLimitEvent) {
          this._setStatus(sessionId, 'rate_limited')
          this._emit(sessionId, rateLimitEvent)
          continue
        }

        // Status first, while the record still exists, so the transition is
        // published once rather than once here and once from _applyStatus.
        this._setStatus(sessionId, 'dead')
        this.activeSessions.delete(sessionId)
        this.activeRunRequests.delete(sessionId)
        clearForeignTaskSnapshot(sessionId)

        const enriched = backend.getEnrichedError(agentSessionId, null)
        enriched.message = err.message
        this._emitError(sessionId, enriched)
      }
    })
  }

  runAgent(request: AgentRunRequest, sessionState?: AgentRunSessionState): AgentRun {
    const run = this.agentRunner.run(request, sessionState)
    this.activeAgentRuns.add(run)
    if (request.unattended) {
      this.activeUnattendedAgentRuns.add(run)
      this._notifyActiveWork()
    }
    void run.done.finally(() => {
      this.activeAgentRuns.delete(run)
      if (this.activeUnattendedAgentRuns.delete(run)) this._notifyActiveWork()
    }).catch(() => {})
    return run
  }

  // ─── Watches ───

  /**
   * Resolve identity, then subscribe. `sessionId` is the client's own id for a
   * session it is starting; `agentSessionId` is set when the client is resuming
   * a provider thread it read off disk and does not yet know Solus's id for.
   * Returns the authoritative id — which may not be the one passed in.
   */
  watchSession(input: { sessionId?: string; agentSessionId?: string }, clientId: string): { sessionId: string } {
    // Main resolves; the client asserts nothing. Two clients resuming one live
    // session must land on one id, or "one id" is only true within a client.
    const sessionId = (input.agentSessionId ? this.agentSessionToSession.get(input.agentSessionId) : undefined)
      ?? input.sessionId
      ?? crypto.randomUUID()
    if (input.agentSessionId) this.agentSessionToSession.set(input.agentSessionId, sessionId)

    // Drain what is already buffered to the clients that were here first: the
    // buffer is per-session, so a late joiner would otherwise receive the
    // pending tail on the next flush *and* the same text again from
    // bindRuntimeSession's replay. Drain, then join, then replay.
    this._flushPendingSession(sessionId, false)

    let clients = this.watches.get(sessionId)
    if (!clients) {
      clients = new Set()
      this.watches.set(sessionId, clients)
    }
    clients.add(clientId)
    log.info('session_watched', { sessionId, clientId, watchers: clients.size })
    return { sessionId }
  }

  unwatchSession(sessionId: string, clientId: string): void {
    this._dropWatch(sessionId, clientId)
    // Only an explicit unwatch — the user closed the last view — resolves
    // attention. A dropped socket means the laptop shut, not that the session
    // stopped needing you.
    if (this.watches.has(sessionId)) return
    const agentSessionId = this._agentSessionIdFor(sessionId)
    if (agentSessionId) this.attention.resolve(agentSessionId)
  }

  clientsWatching(sessionId: string): readonly string[] {
    const clients = this.watches.get(sessionId)
    return clients ? [...clients] : []
  }

  private _dropWatch(sessionId: string, clientId: string): void {
    const clients = this.watches.get(sessionId)
    if (!clients?.delete(clientId)) return
    if (clients.size) return
    this.watches.delete(sessionId)
    // Nothing is listening, so nothing is buffering for it either.
    this.pendingFlush.delete(sessionId)
    log.info('session_unwatched', { sessionId, clientId })
  }

  bindRuntimeSession(ctx: IpcContext, clientId: string): RuntimeSessionInfo | null {
    const agentSessionId = ctx.session.agentSessionId
    if (!agentSessionId) return null

    // Whoever is resuming may not know Solus's id for this provider thread yet;
    // the live session is authoritative for it.
    const sessionId = this._sessionIdFor(ctx.session.sessionId)
      ?? this.agentSessionToSession.get(agentSessionId)
      ?? ctx.session.sessionId
    if (!sessionId) return null
    // A watch is the authorization: any paired device watching a session may act
    // on it. Opening a headless session's card is watching it.
    if (!this.watches.get(sessionId)?.has(clientId)) {
      this.watchSession({ sessionId, agentSessionId }, clientId)
    }

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
    const isRuntimeRunning = backend.isSessionRunning(agentSessionId)
    if (!isRuntimeRunning && !pendingRateLimitEvent && !hasQueuedRateLimitRequest) {
      this.activeSessions.delete(sessionId)
      return null
    }

    if (!pendingRateLimitEvent) this._processQueueForSession(sessionId)

    // The joining client alone needs the turn so far; everyone else already has it.
    const accumulatedChunks = this.turnText.get(sessionId)
    if (accumulatedChunks && accumulatedChunks.length) {
      this._emit(sessionId, { type: 'text_chunk', text: accumulatedChunks.join('') }, { only: clientId })
    }

    for (const event of session.pendingInputEvents) {
      this._emit(sessionId, event, { only: clientId })
    }

    const status = pendingRateLimitEvent
      ? 'rate_limited'
      : isRuntimeRunning && session.status === 'completed'
        ? 'running'
        : session.status
    // Keep the stored turn status intact. `completed` can arrive just before the
    // runtime exits; only the reattaching client needs the live-runtime override.
    this._setStatus(sessionId, pendingRateLimitEvent ? 'rate_limited' : session.status)

    if (pendingRateLimitEvent) {
      this._emit(sessionId, pendingRateLimitEvent, { only: clientId })
    }

    // The run contract is how the config is read back, but losing it must not
    // cost the client the session itself: the runtime is alive either way, and
    // returning null here strands the session at 'idle' for the rest of its life.
    const input = session.runInput
    if (!input) {
      log.warn('session_attached_no_run_input', { sessionId, agentSessionId })
    } else {
      log.info('session_attached', { sessionId, agentSessionId })
    }
    return {
      modelConfig: input
        ? { modelId: input.preferredModel, reasoningEffort: input.reasoningEffort, contextWindow: input.contextWindow, fastMode: input.fastMode }
        : null,
      permissionMode: input?.permissionMode ?? null,
      status,
      queuedPrompts: this._queuedPromptsForSession(sessionId),
      rateLimitInfo,
      handoffFrom: session.handoffFrom,
    }
  }

  /** Clear the stored provider thread so the next dispatch won't inject a stale --resume. */
  resetSession(ctx: IpcContext): void {
    const sessionId = this._sessionIdForCtx(ctx)
    if (!sessionId) return
    const session = this.activeSessions.get(sessionId)
    log.info('session_reset', { sessionId, agentSessionId: session?.agentSessionId ?? null })
    this.rateLimits.clear(sessionId)
    this.pendingHandoffs.delete(sessionId)

    if (session) {
      session.agentSessionId = null
      delete session.handoffFrom
      session.runInput = { ...runInputFromContext(ctx), agentSessionId: null }
      session.gitContext = ctx.session.gitContext ?? undefined
    }
    this._setStatus(sessionId, 'idle')
    this.setSessionGitEnvironment(sessionId, ctx.session.workingDirectory, ctx.session.gitContext)
  }

  async listSessionsForProviders(agentIds: AgentId[], projectPath: string, onBatch?: (sessions: SessionMeta[]) => void, limitPerProvider?: number): Promise<SessionMeta[]> {
    const settled = await Promise.allSettled(
      agentIds.map((agentId) => this._backendFor(agentId).listSessions(projectPath, onBatch, limitPerProvider)),
    )
    const sessions = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime())
    // Rows come off disk, so they name sessions by the provider's thread id.
    for (const meta of sessions) {
      const sessionId = this.agentSessionToSession.get(meta.sessionId)
      if (!sessionId) continue
      if (this._currentRateLimitEvent(sessionId)) meta.status = 'rate_limited'
      else {
        const active = this.activeSessions.get(sessionId)
        if (active) meta.status = active.status
      }
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

  invalidatePlanCaches(sessionId: string): void {
    for (const agentId of this.getBackendIds()) {
      this._backendFor(agentId).invalidatePlanCache?.(sessionId)
    }
  }

  loadSession(agentId: AgentId, sessionId: string, projectPath?: string, limit?: number): Promise<SessionLoadMessage[]> {
    return this._backendFor(agentId).loadSession(sessionId, projectPath, limit)
  }

  /** `knownAgentSessionId` is the client's view of the provider thread. A
   *  session only has a record here while a runtime is attached, so an idle
   *  conversation — one whose process exited, or one restored after a restart —
   *  has none, and the caller is the only holder of the thread to hand off. */
  async switchSessionProvider(sessionId: string, newProvider: AgentId, knownAgentSessionId?: string | null): Promise<SessionProviderSwitchResult> {
    const session = this.activeSessions.get(sessionId)

    const pendingHandoff = this.pendingHandoffs.get(sessionId)
    if (pendingHandoff && newProvider === pendingHandoff.fromProvider) {
      const fromProvider = session?.backendId ?? newProvider
      this.pendingHandoffs.delete(sessionId)
      if (session) {
        session.backendId = newProvider
        session.agentSessionId = pendingHandoff.fromSessionId
      }
      this.agentSessionToSession.set(pendingHandoff.fromSessionId, sessionId)
      this._setStatus(sessionId, 'idle')
      return {
        fromProvider,
        fromSessionId: pendingHandoff.fromSessionId,
        restoredSessionId: pendingHandoff.fromSessionId,
        handoffFrom: session?.handoffFrom,
      }
    }

    const oldAgentSessionId = session?.agentSessionId ?? knownAgentSessionId
    if (!oldAgentSessionId) throw new Error(`Session ${sessionId} has no provider thread to switch`)

    const indexedSession = getIndexedSession(oldAgentSessionId)
    const fromProvider = session?.backendId ?? indexedSession?.provider
    if (!fromProvider) {
      throw new Error(`Session ${oldAgentSessionId} has no provider information for a handoff`)
    }
    if (fromProvider === newProvider) {
      throw new Error(`Session ${oldAgentSessionId} already uses ${newProvider}`)
    }
    this._backendFor(newProvider)
    const status = session?.status ?? 'idle'
    const isRateLimited = status === 'rate_limited'
    if (isSessionBusyStatus(status) && !isRateLimited) {
      throw new Error(`Session ${oldAgentSessionId} must be idle before switching providers (current status: ${status})`)
    }
    const queuedRequests = this.requestQueue.get(sessionId) ?? []
    const hasNonRateLimitedQueue = queuedRequests.some(
      (request) => request.rateLimitSessionId !== sessionId,
    )
    if (hasNonRateLimitedQueue || (!isRateLimited && queuedRequests.length > 0)) {
      throw new Error(`Session ${oldAgentSessionId} has queued prompts and cannot switch providers`)
    }

    if (isRateLimited) {
      // Switching providers abandons only the prompt parked by the exhausted
      // provider. Clear that provider's reset state before detaching the session
      // so the renderer sees the card and queued prompt disappear.
      this._clearRateLimitTimer(sessionId)
      this.rateLimits.clear(sessionId)
      this._rejectRateLimitQueue(sessionId, new Error('Provider switched'))
      this.activeRunRequests.delete(sessionId)
      this._broadcastRateLimitResolved(sessionId, 'stop')
      this._setStatus(sessionId, 'idle')
    }

    // Swap the session over immediately — the actual transcript/summary handoff
    // is built lazily in _launchRun, right before the next prompt starts the new
    // provider's session, so the switch itself never blocks on an LLM call.
    this.pendingHandoffs.set(sessionId, { fromProvider, fromSessionId: oldAgentSessionId })
    if (session) {
      session.backendId = newProvider
      session.agentSessionId = null
    }
    this._setStatus(sessionId, 'idle')

    return { fromProvider, fromSessionId: oldAgentSessionId }
  }

  /** Seam (b): the row comes from the on-disk session index, so it is named by
   *  the provider's thread id. */
  async getSessionInfo(agentSessionId: string): Promise<SessionMeta | null> {
    const meta = getIndexedSession(agentSessionId)
    if (!meta) return null
    const sessionId = this.agentSessionToSession.get(agentSessionId)
    const active = sessionId ? this.activeSessions.get(sessionId) : undefined
    if (active && sessionId) {
      meta.provider = active.backendId
      const pendingRateLimit = this._currentRateLimitEvent(sessionId)
      meta.status = pendingRateLimit
        ? 'rate_limited'
        : active.status === 'completed'
          && this._backendFor(active.backendId).isSessionRunning(agentSessionId)
          ? 'running'
          : active.status
      meta.currentTurnStartedAt = this._backendFor(active.backendId)
        .getSessionHandle(agentSessionId)?.startedAt
      meta.lastTimestamp = new Date(active.lastActivityAt).toISOString()
    }
    return meta
  }

  liveSessionStatus(agentSessionId: string): SessionStatus | null {
    const sessionId = this.agentSessionToSession.get(agentSessionId)
    if (!sessionId) return null
    if (this._currentRateLimitEvent(sessionId)) return 'rate_limited'
    return this.activeSessions.get(sessionId)?.status ?? null
  }

  pendingInputEventsForSession(agentSessionId: string): NormalizedEvent[] {
    const sessionId = this.agentSessionToSession.get(agentSessionId)
    if (!sessionId) return []
    return [...(this.activeSessions.get(sessionId)?.pendingInputEvents ?? [])]
  }

  /** Both ids arrive from the agent-tool surface, which addresses peers by their
   *  provider thread id. Watches are held against Solus's id. */
  watchSessionSettled(targetAgentSessionId: string, callerAgentSessionId: string, watch: AgentConversationWatchRequest): void {
    if (targetAgentSessionId === callerAgentSessionId) {
      throw new Error('Cannot watch your own session.')
    }
    const targetSessionId = this.agentSessionToSession.get(targetAgentSessionId)
    const callerSessionId = this.agentSessionToSession.get(callerAgentSessionId)
    if (!targetSessionId || !callerSessionId) {
      throw new Error(`Session ${!targetSessionId ? targetAgentSessionId : callerAgentSessionId} is not live`)
    }

    let callers = this.agentConversationWatches.get(targetSessionId)
    if (!callers) {
      callers = new Map()
      this.agentConversationWatches.set(targetSessionId, callers)
    }
    let watches = callers.get(callerSessionId)
    if (!watches) {
      watches = []
      callers.set(callerSessionId, watches)
    }
    const armed: AgentConversationWatch = { ...watch, awaitingReported: false, callerAgentSessionId }
    watches.push(armed)

    // Catch-up scoped to the new watch only — earlier watchers already heard
    // about the current pause.
    const status = this.liveSessionStatus(targetAgentSessionId)
    if (status === 'awaiting_input' || status === 'awaiting_plan') {
      this._fireAwaitingInputWatchers(targetSessionId, status, { callerSessionId, watch: armed })
    }
  }

  private _awaitingAgentReply(callerSessionId: string): boolean {
    for (const callers of this.agentConversationWatches.values()) {
      if (callers.get(callerSessionId)?.some((watch) => watch.notifyModel)) return true
    }
    return false
  }

  private _cancelPendingAgentReplies(callerSessionId: string): boolean {
    let cancelled = false
    for (const [targetSessionId, callers] of this.agentConversationWatches) {
      const watches = callers.get(callerSessionId)
      if (!watches?.length) continue

      callers.delete(callerSessionId)
      if (!callers.size) this.agentConversationWatches.delete(targetSessionId)
      cancelled = true

      // The card correlates peers by the provider's thread id, not Solus's.
      const agentSessionId = this._agentSessionIdFor(targetSessionId)
      if (!agentSessionId) continue
      for (const watch of watches) {
        this._emit(callerSessionId, {
          type: 'agent_conversation_update',
          update: {
            phase: 'settled',
            agentSessionId,
            exchangeId: watch.exchangeId,
            status: 'interrupted',
            replyText: '',
            settledAt: Date.now(),
          },
        })
      }
    }
    return cancelled
  }

  private _cancelAgentConversationRunWatches(targetSessionId: string, runKey: string): boolean {
    const callers = this.agentConversationWatches.get(targetSessionId)
    if (!callers?.size) return false

    const cancelled: Array<{ callerSessionId: string; watch: AgentConversationWatch }> = []
    for (const [callerSessionId, watches] of callers) {
      for (let index = watches.length - 1; index >= 0; index--) {
        if (watches[index].runKey !== runKey) continue
        cancelled.unshift({ callerSessionId, watch: watches[index] })
        watches.splice(index, 1)
      }
      if (!watches.length) callers.delete(callerSessionId)
    }
    if (!callers.size) this.agentConversationWatches.delete(targetSessionId)

    const agentSessionId = this._agentSessionIdFor(targetSessionId)
    if (!agentSessionId) return cancelled.length > 0
    for (const { callerSessionId, watch } of cancelled) {
      this._emit(callerSessionId, {
        type: 'agent_conversation_update',
        update: {
          phase: 'settled',
          agentSessionId,
          exchangeId: watch.exchangeId,
          status: 'interrupted',
          replyText: '',
          settledAt: Date.now(),
        },
      })
    }
    return cancelled.length > 0
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
    if (agentId === 'claude-code') return Promise.resolve(this.claudeGoals.get(threadId))
    const backend = this._backendFor(agentId)
    if (!backend.getThreadGoal) throw new Error(`${agentId} does not support thread goals`)
    return backend.getThreadGoal(threadId)
  }

  setThreadGoal(agentId: AgentId, request: ThreadGoalSetRequest): Promise<ThreadGoal> {
    if (agentId === 'claude-code') {
      const goal = this.claudeGoals.create(request)
      // Goals are stored against the provider's thread id, so resolve first.
      const sessionId = this.agentSessionToSession.get(request.threadId)
      if (sessionId) this._emit(sessionId, { type: 'goal_updated', goal })
      return Promise.resolve(goal)
    }
    const backend = this._backendFor(agentId)
    if (!backend.setThreadGoal) throw new Error(`${agentId} does not support thread goals`)
    return backend.setThreadGoal(request)
  }

  clearThreadGoal(agentId: AgentId, threadId: string): Promise<boolean> {
    if (agentId === 'claude-code') throw new Error('Clearing goals is only supported for Codex sessions')
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

  /** Agents whose backend can report subscription quota. */
  usageCapableAgents(): AgentId[] {
    return [...this.backends.entries()]
      .filter(([, backend]) => backend.readUsageLimits)
      .map(([agentId]) => agentId)
  }

  /** Null when the provider exposes no quota, or its report didn't parse. */
  readUsageLimits(agentId: AgentId): Promise<AgentUsageLimits | null> {
    const backend = this._backendFor(agentId)
    return backend.readUsageLimits?.() ?? Promise.resolve(null)
  }

  /** Attention entries are keyed by the provider's thread id (seam (b)). */
  isPendingAttentionLive(agentSessionId: string): boolean {
    const sessionId = this.agentSessionToSession.get(agentSessionId)
    if (!sessionId) return false
    const session = this.activeSessions.get(sessionId)
    if (!session?.pendingInputEvents.some(
      (event) => event.type === 'permission_request' || event.type === 'question_request',
    )) return false
    return !!this.watches.get(sessionId)?.size
  }

  /**
   * A dropped socket drops that client's watches and nothing else. It does not
   * end the sessions it was watching and — deliberately — does not resolve their
   * attention: a session awaiting input still needs you when your laptop is
   * shut, which is exactly what the offline push notification assumes.
   */
  handleClientDisconnected(clientId: string): void {
    for (const sessionId of [...this.watches.keys()]) {
      this._dropWatch(sessionId, clientId)
    }
  }

  /** The only execution entry point. Every caller supplies an explicit target
   * and receives the same lifecycle whether the input starts, steers, or queues. */
  async runTurn(request: SessionRunRequest, deviceId?: string): Promise<SessionRunLifecycle> {
    if (request.target.kind === 'session') {
      const sessionId = request.target.sessionId
      const session = this.activeSessions.get(sessionId)
      if (session) {
        const pendingRateLimit = this._currentRateLimitEvent(sessionId)
        if (
          pendingRateLimit?.type === 'rate_limit' &&
          (request.input.rateLimitBehavior === 'ask' || request.input.rateLimitBehavior === 'queue')
        ) {
          return this._enqueueRequest(request, {
            sessionId,
            reason: 'rate_limit',
            deviceId,
            rateLimitSessionId: sessionId,
            releaseAt: pendingRateLimit.resetsAt,
            rateLimitType: pendingRateLimit.rateLimitType,
          })
        }

        const hasQueuedForSession = (this.requestQueue.get(sessionId)?.length ?? 0) > 0
        const wasRunningAtDispatch = session.status === 'running'
        if (isSessionBusyStatus(session.status)) {
          if (request.options.delivery !== 'queue') {
            const steered = session.agentSessionId && isSteerableStatus(session.status)
              ? await this._steerActiveTurn(request, session.agentSessionId, session)
              : null
            if (steered) return steered
            // `turn/steer` is preconditioned on an active turn. If that turn
            // completed while the request was in flight, its exit handler may
            // already have checked an empty queue. Start directly instead of
            // enqueuing work that would have no later event to drain it.
            const currentSession = this.activeSessions.get(sessionId)
            const hasQueuedAfterSteer = (this.requestQueue.get(sessionId)?.length ?? 0) > 0
            if ((!currentSession || !isSessionBusyStatus(currentSession.status)) && !hasQueuedAfterSteer) {
              // The sender withheld its own bubble waiting on a steer verdict
              // (see _steerActiveTurn), and a fresh run broadcasts the user
              // message to every client *but* the sender — so echo it back here.
              if (request.sourceClientId && wasRunningAtDispatch) {
                this._emit(sessionId, this._userMessageEvent(request.options), { only: request.sourceClientId })
              }
              return this._startRunLifecycle(request)
            }
          }
          return this._enqueueRequest(request, {
            sessionId,
            reason: 'busy',
            deviceId,
          })
        }
        if (hasQueuedForSession) {
          return this._enqueueRequest(request, {
            sessionId,
            reason: 'busy',
            deviceId,
          })
        }
      }
    }

    return this._startRunLifecycle(request)
  }

  /** The transcript echo for a prompt whose sender is waiting on us to render
   *  it — every other client gets the same event from the run itself. */
  private _userMessageEvent(
    options: PromptOptions,
    delivery?: PromptDelivery,
  ): NormalizedEvent {
    return {
      type: 'user_message',
      text: options.displayPrompt ?? options.prompt,
      ...(delivery ? { delivery } : {}),
      ...(options.clientPromptId ? { clientPromptId: options.clientPromptId } : {}),
      ...(options.imageAttachments?.length ? { imageAttachments: options.imageAttachments } : {}),
      ...(options.via ? { via: options.via, automationId: options.automationId, automationName: options.automationName } : {}),
      ...(options.agentSessionId ? { agentSessionId: options.agentSessionId, agentExchangeId: options.agentExchangeId } : {}),
    }
  }

  private async _steerActiveTurn(
    request: SessionRunRequest,
    agentSessionId: string,
    session: BackendSession,
  ): Promise<SessionRunLifecycle | null> {
    const backend = this._backendFor(session.backendId)
    const handle = await backend.steerSession(agentSessionId, request.options)
    if (!handle) return null

    session.promptCount = (session.promptCount ?? 0) + 1
    session.lastActivityAt = Date.now()
    const userMessage = this._userMessageEvent(request.options, 'steer')
    this._emit(session.sessionId, userMessage)

    const done = handle.runPromise.then(() => (
      handle.resultText ? { output: handle.resultText } : {}
    ))
    void done.catch(() => {})
    return {
      agentSessionId: Promise.resolve({ agentSessionId }),
      done,
      // Accepted steering input cannot be withdrawn without interrupting the
      // entire active turn, so this lifecycle has no independent cancellation.
      cancel: () => {},
      disposition: 'steered',
    }
  }

  /** Submit a prompt to a session and resolve once it has started, steered, or queued. */
  async submitPrompt(
    ctx: IpcContext,
    options: PromptOptions,
    origin?: { clientId?: string; deviceId?: string },
  ): Promise<PromptDispatchResult> {
    const sessionId = ctx.session.sessionId
    if (!sessionId) {
      throw new Error('No sessionId provided — rejecting to prevent misrouting')
    }
    const input = runInputFromContext(ctx)
    const agentSessionId = this.activeSessions.get(sessionId)?.agentSessionId ?? input.agentSessionId
    if (agentSessionId) this.agentSessionToSession.set(agentSessionId, sessionId)
    const target: DispatchTarget = !input.forked && agentSessionId
      ? { kind: 'session', sessionId }
      : { kind: 'new-session' }
    const lifecycle = await this.runTurn({
      input,
      target,
      sessionId,
      sourceClientId: origin?.clientId,
      options,
      tools: selectAgentTools(
        solusToolbox.works,
        solusToolbox.artifact,
        solusToolbox.automations,
        solusToolbox.cloudflare,
        solusToolbox.sessions,
        solusToolbox.tasks,
        solusToolbox.prs,
      ),
    }, origin?.deviceId)
    await lifecycle.agentSessionId
    return {
      disposition: lifecycle.disposition,
      ...(lifecycle.queueId ? { queueId: lifecycle.queueId } : {}),
    }
  }

  /**
   * Dispatch an automation's prompt *into* an agent session so it runs in-thread
   * with full conversation context (the "run in this chat" path). Builds a plain
   * run input from the session's last run (when resident) or the automation's own
   * config fallback (when not), so a backgrounded or cold session resumes from
   * disk rather than failing. No source client is named, so the injected message
   * reaches every client watching the session. Routes through `runTurn`, so
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
    // Automations name their target by the provider thread they were attached
    // to; a cold one has no live session, so it gets an id when it starts.
    const sessionId = this.agentSessionToSession.get(agentSessionId) ?? crypto.randomUUID()
    const resident = this.activeSessions.get(sessionId)?.runInput
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
            contextWindow: defaultContextWindowFor(fallback.provider, fallback.model),
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
      target: { kind: 'session', sessionId },
      sessionId,
      tools: selectAgentTools(
        solusToolbox.works,
        solusToolbox.artifact,
        solusToolbox.automations,
        solusToolbox.cloudflare,
        solusToolbox.sessions,
        solusToolbox.tasks,
        solusToolbox.prs,
      ),
      options: {
        prompt,
        displayPrompt: prompt,
        skipTaskCreation: true,
        delivery: 'queue',
        via: 'automation',
        automationId,
        automationName,
      },
    })
    await lifecycle.done
  }

  async promptSession(
    agentSessionId: string,
    prompt: string,
    delivery: PromptDelivery = 'queue',
    origin?: Pick<PromptOptions, 'via' | 'agentSessionId' | 'agentExchangeId'> & {
      /** Replaces the session's stored run mode for this prompt and every later
       *  one. A peer that just planned is still in 'plan' mode: prompting it as
       *  is makes Claude plan again and makes Codex refuse to touch anything, so
       *  approving a plan by prompt has to take it out of plan mode. */
      permissionMode?: SessionRunInput['permissionMode']
    },
  ): Promise<{ disposition: SessionRunLifecycle['disposition']; queueId?: string }> {
    const { permissionMode, ...promptOrigin } = origin ?? {}
    // The agent-tool surface addresses peers by their provider thread id; a peer
    // that is only on disk gets a Solus id when this prompt starts it.
    const sessionId = this.agentSessionToSession.get(agentSessionId) ?? crypto.randomUUID()
    const resident = this.activeSessions.get(sessionId)
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
        contextWindow: defaultContextWindowFor(meta.provider, meta.model),
        model: meta.model,
        preferredModel: meta.model,
        reasoningEffort: meta.reasoningEffort,
        fastMode: false,
        permissionMode: 'ask',
        rateLimitBehavior: 'queue',
        extraInstructions: '',
      }
    }
    if (permissionMode) input.permissionMode = permissionMode

    const lifecycle = await this.runTurn({
      input,
      target: { kind: 'session', sessionId },
      sessionId,
      tools: selectAgentTools(
        solusToolbox.works,
        solusToolbox.artifact,
        solusToolbox.automations,
        solusToolbox.cloudflare,
        solusToolbox.sessions,
        solusToolbox.tasks,
        solusToolbox.prs,
      ),
      options: { prompt, displayPrompt: prompt, delivery, ...promptOrigin },
    })
    return { disposition: lifecycle.disposition, queueId: lifecycle.queueId }
  }

  /**
   * Interrupt a session, whichever id the caller holds: the renderer's Stop
   * passes Solus's, an MCP `stop_session` passes the provider thread it read off
   * disk. Covers every phase — a queue waiting its turn, a worktree still being
   * prepared, a live provider turn, and a run that has not reached session_init.
   */
  stopSession(id: string): boolean {
    const sessionId = this._sessionIdFor(id)
    if (!sessionId) return false

    this._drainQueue(sessionId)

    // Worktree creation happens before a backend RunHandle exists. Cancel it
    // first or Stop would report failure while setup continued into a new run.
    const setupController = this.pendingSetupControllers.get(sessionId)
    if (setupController) {
      setupController.abort(new Error('Interrupted'))
      this.pendingSetupControllers.delete(sessionId)
      this._setStatus(sessionId, 'interrupted')
      return true
    }

    const session = this.activeSessions.get(sessionId)
    if (session?.agentSessionId && isSessionBusyStatus(session.status)) {
      const cancelled = this._backendFor(session.backendId).cancelSession(session.agentSessionId)
      if (cancelled) this._setStatus(sessionId, 'interrupted')
      return cancelled
    }

    // Fall back to pre-session_init handles owned by any backend.
    for (const backend of this.backends.values()) {
      const handle = backend.getPendingHandles().find((h) => h.sessionId === sessionId)
      if (!handle) continue
      handle.abortController.abort()
      this._setStatus(sessionId, 'interrupted')
      return true
    }

    if (this._cancelPendingAgentReplies(sessionId)) {
      this._setStatus(sessionId, 'interrupted')
      return true
    }

    return false
  }

  /**
   * Start a fresh background session running `prompt` on the given agent/model —
   * the entry for the `create_session` MCP tool. Builds a plain run input with no
   * client watching it and routes through `runTurn`, resolving once the new
   * session has initialized and returning its id. The caller renders a card,
   * which watches the session when a user opens it.
   */
  async createSession(req: {
    prompt: string
    provider: AgentId
    modelId: string | null
    reasoningEffort: ReasoningEffort
    contextWindow: number | null
    cwd: string
    worktreeBaseBranch?: string | null
    taskId?: string | null
    parentTaskId?: string | null
  }): Promise<{ agentSessionId: string; taskId?: string }> {
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
      model: req.modelId ?? '',
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
      sessionId: crypto.randomUUID(),
      tools: selectAgentTools(
        solusToolbox.works,
        solusToolbox.artifact,
        solusToolbox.automations,
        solusToolbox.cloudflare,
        solusToolbox.sessions,
        solusToolbox.tasks,
        solusToolbox.prs,
      ),
      options: {
        prompt: req.prompt,
        displayPrompt: req.prompt,
        ...(req.taskId ? { taskId: req.taskId } : {}),
        ...(req.parentTaskId ? { parentTaskId: req.parentTaskId } : {}),
      },
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
      contextWindow: defaultContextWindowFor(req.provider, req.modelId),
      model: req.modelId ?? '',
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
      sessionId: crypto.randomUUID(),
      tools: selectAgentTools(
        solusToolbox.works,
        solusToolbox.artifact,
        solusToolbox.cloudflare,
        solusToolbox.sessions,
        solusToolbox.tasks,
        solusToolbox.prs,
      ),
      options: {
        prompt: req.prompt,
        displayPrompt: req.prompt,
        skipTaskCreation: true,
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
    const runStartedAt = Date.now()
    const { handle, run } = await this._launchRun(request)
    if (handle.agentSessionId && !run.input.agentSessionId && run.options.taskId) {
      await this._linkPreparedTask(run, handle.agentSessionId)
    }
    const agentSessionId = handle.agentSessionId
      ? Promise.resolve({
          agentSessionId: handle.agentSessionId,
          ...(run.options.taskId ? { taskId: run.options.taskId } : {}),
        })
      : new Promise<{ agentSessionId: string; taskId?: string }>((resolve, reject) => {
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
    const settledSessionId = request.sessionId
    const captureSettledRun = (status: 'completed' | 'interrupted' | 'failed'): void => {
      const event = status === 'completed'
        ? 'run_completed'
        : status === 'interrupted'
          ? 'run_interrupted'
          : 'run_failed'
      captureServerEvent(event, {
        provider: run.input.provider,
        duration_ms: Math.max(0, Date.now() - handle.startedAt),
        tool_call_count: handle.toolCallCount,
        saw_permission_request: handle.sawPermissionRequest,
        permission_denial_count: handle.permissionDenials.length,
      })
    }
    const done = handle.runPromise.then(
      () => {
        const status = handle.abortController.signal.aborted ? 'interrupted' as const : 'completed' as const
        captureSettledRun(status)
        void this._fireSettledSessionWatchers(settledSessionId, status, handle.resultText, request.input, {
          durationMs: Date.now() - runStartedAt,
          toolCallCount: handle.toolCallCount,
        }, request.servedQueueId)
        return handle.resultText ? { output: handle.resultText } : {}
      },
      (error) => {
        const status = handle.abortController.signal.aborted ? 'interrupted' as const : 'failed' as const
        captureSettledRun(status)
        void this._fireSettledSessionWatchers(settledSessionId, status, handle.resultText, request.input, {
          durationMs: Date.now() - runStartedAt,
          toolCallCount: handle.toolCallCount,
        }, request.servedQueueId)
        throw error
      },
    )
    void done.catch(() => {})
    return {
      agentSessionId,
      done,
      cancel: () => {
        if (handle.agentSessionId && this.stopSession(handle.agentSessionId)) return
        handle.abortController.abort()
      },
      disposition: 'started',
    }
  }

  private _dispatchSessionReport(callerAgentSessionId: string, prompt: string, agent: { agentSessionId: string; exchangeId: string }): void {
    // promptSession addresses its target the way the agent-tool surface does.
    void this.promptSession(callerAgentSessionId, prompt, 'queue', {
      via: 'session-report',
      agentSessionId: agent.agentSessionId,
      agentExchangeId: agent.exchangeId,
    }).catch((error) => {
      log.warn('session_report_failed', { agentSessionId: callerAgentSessionId, error: String(error) })
    })
  }

  /** A watched agent paused for human input. Surfaces the question on the OLDEST
   *  armed exchange in every caller's agent-conversation card — the paused run belongs to
   *  it; newer exchanges are still queued — and injects the prose report once
   *  per watch, WITHOUT consuming the watch, so the eventual settle still lands
   *  in the same exchange (waiting → answered → replying → done). Pass `only`
   *  to scope a registration-time catch-up to the newly armed watch. */
  private _fireAwaitingInputWatchers(
    targetSessionId: string,
    status: 'awaiting_input' | 'awaiting_plan',
    only?: { callerSessionId: string; watch: AgentConversationWatch },
  ): void {
    const session = this.activeSessions.get(targetSessionId)
    if (!session?.agentSessionId) return
    const targetAgentSessionId = session.agentSessionId
    const callers = this.agentConversationWatches.get(targetSessionId)
    if (!callers?.size) return
    const question = agentConversationQuestionFromPendingInput(session.pendingInputEvents)
    const pendingInput = formatPendingInputReport(session.pendingInputEvents)
    const targets = only ? [[only.callerSessionId, [only.watch]] as const] : [...callers]
    for (const [callerSessionId, watches] of targets) {
      const watch = watches[0]
      if (!watch) continue
      if (question) {
        this._emit(callerSessionId, {
          type: 'agent_conversation_update',
          update: { phase: 'awaiting_input', agentSessionId: targetAgentSessionId, exchangeId: watch.exchangeId, ...question },
        })
      }
      if (pendingInput && watch.notifyModel && !watch.awaitingReported) {
        watch.awaitingReported = true
        this._dispatchSessionReport(
          watch.callerAgentSessionId,
          buildSessionAwaitingInputReport(targetAgentSessionId, status, pendingInput),
          { agentSessionId: targetAgentSessionId, exchangeId: watch.exchangeId },
        )
      }
    }
  }

  private async _fireSettledSessionWatchers(
    targetSessionId: string,
    status: 'completed' | 'interrupted' | 'failed',
    resultText: string | undefined,
    input: SessionRunInput,
    runMeta?: { durationMs?: number; toolCallCount?: number },
    servedQueueId?: string,
  ): Promise<void> {
    const callers = this.agentConversationWatches.get(targetSessionId)
    if (!callers?.size) return

    // Each exchange resolves against the run that carried it: 'active' watches
    // rode whatever run was in flight when they armed (started/steered
    // dispatches, wait_for, create), queued watches wait for the run that
    // drains their queueId. No queue sampling — by the time this settle runs,
    // the exit handler may already have drained the next queued prompt.
    const resolved: Array<{ callerSessionId: string; watch: AgentConversationWatch }> = []
    for (const [callerSessionId, watches] of callers) {
      for (let i = watches.length - 1; i >= 0; i--) {
        const watch = watches[i]
        if (watch.runKey === 'active' || watch.runKey === servedQueueId) {
          watches.splice(i, 1)
          resolved.unshift({ callerSessionId, watch })
        }
      }
      if (!watches.length) callers.delete(callerSessionId)
    }
    if (!callers.size) this.agentConversationWatches.delete(targetSessionId)
    if (!resolved.length) return

    // The card and the transcript on disk both name the peer by its provider
    // thread; the run's own input still carries it after the record is gone.
    const targetAgentSessionId = this._agentSessionIdFor(targetSessionId) ?? input.agentSessionId
    if (!targetAgentSessionId) return

    let finalText = resultText?.trim()
    if (!finalText) {
      const messages = await this.loadSession(
        input.provider,
        targetAgentSessionId,
        input.projectPath || input.workingDirectory,
      ).catch(() => [])
      finalText = [...messages].reverse().find(
        (message) => message.role === 'assistant' && !message.parentToolUseId && message.content,
      )?.content?.trim()
    }

    const settledAt = Date.now()
    for (const { callerSessionId, watch } of resolved) {
      this._emit(callerSessionId, {
        type: 'agent_conversation_update',
        update: {
          phase: 'settled',
          agentSessionId: targetAgentSessionId,
          exchangeId: watch.exchangeId,
          status,
          replyText: finalText ?? '',
          durationMs: runMeta?.durationMs,
          toolCallCount: runMeta?.toolCallCount,
          settledAt,
        },
      })
      if (watch.notifyModel) {
        this._dispatchSessionReport(
          watch.callerAgentSessionId,
          buildSessionSettledReport(targetAgentSessionId, status, finalText || '(no final assistant reply available)'),
          { agentSessionId: targetAgentSessionId, exchangeId: watch.exchangeId },
        )
      }
    }
  }

  /**
   * True while any session or detached utility agent is actually executing.
   * Narrower than isSessionBusyStatus on purpose: sessions parked on user input or a
   * rate-limit reset consume no compute, so they must not hold the process
   * power-save blocker (see syncPowerSaveBlocker in main/index.ts).
   */
  hasActiveWork(): boolean {
    if (this.activeUnattendedAgentRuns.size > 0) return true
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

  private _enqueueRequest(
    run: SessionRunRequest,
    metadata: {
      reason: QueuedPromptReason
      sessionId: string
      deviceId?: string
      sourceSessionId?: string
      rateLimitSessionId?: string
      releaseAt?: number
      rateLimitType?: string
    },
  ): SessionRunLifecycle {
    const { options } = run
    const queueKey = metadata.sessionId

    let totalDepth = 0
    for (const q of this.requestQueue.values()) totalDepth += q.length
    if (totalDepth >= MAX_QUEUE_DEPTH) {
      throw new Error('Request queue full — back-pressure')
    }

    const queueId = crypto.randomUUID()
    const enqueuedAt = Date.now()
    const prompt = options.displayPrompt ?? options.prompt
    log.info('request_queued', { sessionId: queueKey, reason: metadata.reason, depth: totalDepth + 1 })
    this._emit(queueKey, {
      type: 'prompt_queued',
      text: prompt,
      queueId,
      enqueuedAt,
      reason: metadata.reason,
      releaseAt: metadata.releaseAt,
      rateLimitType: metadata.rateLimitType,
      images: options.imageAttachments,
      clientPromptId: options.clientPromptId,
      ...(options.via ? { via: options.via } : {}),
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
      sessionId: queueKey,
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
      cancel: () => { this._cancelQueuedPrompt(queueKey, queueId) },
      disposition: 'queued',
      queueId,
    }
  }

  private async _launchRun(request: SessionRunRequest): Promise<StartedRun> {
    const { input, target, options, sessionId, sourceClientId } = request
    const pendingHandoff = this.pendingHandoffs.get(sessionId)
    const isContinuation = target.kind === 'session'
    const existingSession = isContinuation ? this.activeSessions.get(sessionId) : undefined
    // What `--resume` gets. Never the Solus id: the provider has never heard of it.
    const resumeAgentSessionId = isContinuation
      ? existingSession?.agentSessionId ?? input.agentSessionId
      : null
    const provider = pendingHandoff ? existingSession?.backendId ?? input.provider : input.provider
    const backend = this._backendFor(provider)
    this.rateLimits.clear(sessionId)

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
      id: `worktree-${sessionId}`,
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
      const setupController = new AbortController()
      this.pendingSetupControllers.get(sessionId)?.abort(new Error('Interrupted'))
      this.pendingSetupControllers.set(sessionId, setupController)
      worktreeCardActive = true
      this._emit(sessionId, { type: 'status_card', card: buildWorktreeCard(0) })
      try {
        const gitContext: GitCheckout = await createWorktree(resolvedProjectPath, options.prompt, worktreeBaseBranch, {
          signal: setupController.signal,
        })
        if (existingSession) existingSession.gitContext = gitContext
        effectiveGitCtx = gitContext
        log.info('worktree_created', { sessionId, branch: gitContext.branch, worktreePath: gitContext.worktreePath })
        this._emit(sessionId, { type: 'git_context', gitContext })
        // Worktree done → advance to "Linking thread workspace".
        this._emit(sessionId, { type: 'status_card', card: buildWorktreeCard(1) })
      } catch (e) {
        if (setupController.signal.aborted) {
          log.info('worktree_setup_interrupted', { sessionId })
          throw setupController.signal.reason instanceof Error
            ? setupController.signal.reason
            : new Error('Interrupted')
        }
        log.error('worktree_creation_failed', { sessionId, error: String(e) })
        this._emit(sessionId, { type: 'status_card', card: buildWorktreeCard(0, true) })
      } finally {
        if (this.pendingSetupControllers.get(sessionId) === setupController) {
          this.pendingSetupControllers.delete(sessionId)
        }
      }
    }

    const useWorktree = !!effectiveGitCtx?.worktreePath
    const effectiveCwd = useWorktree ? effectiveGitCtx!.worktreePath! : resolvedProjectPath

    // Start mirroring this repo's HEAD/refs/index now that the session's git
    // context is settled, so external branch/commit/stage changes flow back
    // live. Only worth a filesystem watcher when somebody is listening — a
    // headless run nobody has opened would just leak one.
    if (this.watches.has(sessionId)) {
      this.setSessionGitEnvironment(sessionId, effectiveCwd, effectiveGitCtx)
    }

    // Prewarm the file index for the exact path the Files view will query
    // (worktree root when present, else the project) so its first open hits a
    // ready index instead of paying for the initial filesystem scan.
    if (effectiveCwd && effectiveCwd !== '~') warmFinder(effectiveCwd)

    // Workspace linked (git watcher + file index warmed) → advance to the final
    // "Starting session" step; the reducer clears the card once the run begins.
    if (worktreeCardActive) {
      this._emit(sessionId, { type: 'status_card', card: buildWorktreeCard(2) })
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
        loadSession: (threadId, loadProjectPath) => handoffBackend.loadSession(threadId, loadProjectPath),
      })
      handoffPayload = {
        fromProvider: pendingHandoff.fromProvider,
        fromSessionId: pendingHandoff.fromSessionId,
        seedSystemAppend: composeHandoffSeed({ fromProvider: pendingHandoff.fromProvider, ...handoff }),
      }
    }

    const agentSessionId = pendingHandoff
      ? null
      : resumeAgentSessionId ?? (input.forked ? input.agentSessionId : null)

    const effectiveInput: SessionRunInput = {
      ...input,
      provider,
      workingDirectory: effectiveCwd,
      projectPath: resolvedProjectPath,
      additionalDirs: effectiveAdditionalDirs,
      gitContext: effectiveGitCtx,
      agentSessionId,
      forked: pendingHandoff ? false : input.forked,
      sessionChangedFiles: existingSession?.runInput?.sessionChangedFiles ?? input.sessionChangedFiles,
      ...(handoffPayload ? { handoff: handoffPayload } : {}),
    }

    const isForkingSession = !!effectiveInput.forked && !!effectiveInput.agentSessionId
    // The provider thread this run resumes, or null when it will mint a new one.
    const dispatchAgentSessionId = isForkingSession ? null : effectiveInput.agentSessionId
    const newStatus: SessionStatus = dispatchAgentSessionId ? 'running' : 'connecting'
    const activeTurnId = options.clientPromptId ?? crypto.randomUUID()
    if (dispatchAgentSessionId) this.agentSessionToSession.set(dispatchAgentSessionId, sessionId)

    // Recorded at dispatch, not at session_init: the session exists — and is
    // addressable — from the moment work starts on its behalf. It carries the
    // status it had coming in, so `_setStatus` below performs a real transition
    // and publishes it once; writing `newStatus` here would make the dispatch
    // silent to everyone watching.
    this.activeSessions.set(sessionId, {
      sessionId,
      agentSessionId: dispatchAgentSessionId,
      backendId: backend.id,
      status: existingSession?.status ?? 'idle',
      pendingInputEvents: [],
      runInput: effectiveInput,
      gitContext: effectiveGitCtx ?? undefined,
      lastActivityAt: Date.now(),
      promptCount: existingSession ? existingSession.promptCount : 1,
      activeTurnId,
      settledTurnId: existingSession?.settledTurnId,
    })
    this._setStatus(sessionId, newStatus)
    this._notifyActiveWork()

    // A first dispatch becomes or binds a local task before the provider starts.
    // The store returns null for a resumed provider session, which structurally
    // enforces the clean-slate/no-backfill rule.
    if (!options.skipTaskCreation && pendingHandoff && !options.taskId) {
      const existingTask = await tasksForSession(pendingHandoff.fromSessionId)
      if (existingTask) options.taskId = existingTask.task.id
    }
    const task = options.skipTaskCreation
      ? null
      : await prepareSessionTask({
        // A provider handoff is a new backend conversation, not a new Solus
        // session. Treat the prior provider id as the structural no-mint gate;
        // the existing task link (when present) is copied on session_init.
        // A fork carries its source's id purely to branch from, and the provider
        // mints a fresh conversation for it — so it is a first dispatch, not the
        // resume the no-backfill rule exists to exclude.
        existingAgentSessionId: isForkingSession
          ? null
          : effectiveInput.agentSessionId ?? pendingHandoff?.fromSessionId ?? null,
        existingTaskId: options.taskId,
        parentTaskId: options.parentTaskId,
        projectKey: resolvedProjectPath,
        worktreeKey: taskWorktreeKey(resolvedProjectPath, effectiveGitCtx),
        prompt: options.displayPrompt ?? options.prompt,
        branch: effectiveGitCtx?.branch ?? null,
      })
    if (task) options.taskId = task.id
    // The ticket is scaffolding the agent works from, not something the user
    // typed, so it rides the system prompt rather than the transcript. As a
    // prompt prefix it was read back as the user's own turn on reload, and a
    // session's whole history folds behind one row when its first turn has no
    // user message to lead it. Re-hydrated on every dispatch: the system prompt
    // is rebuilt per run, so the agent sees the task's live status and comments
    // instead of a snapshot taken when the session opened.
    if (options.taskId) {
      const context = await this._taskSystemContext(options.taskId, options.taskSnapshot ?? null, sessionId)
      if (context) {
        options.systemPrompt = [options.systemPrompt, context].filter(Boolean).join('\n\n')
      }
    } else {
      setForeignTaskSnapshot(sessionId, null)
    }

    // A queue drain already told the submitter its prompt left the queue, so the
    // message goes to everyone; a direct dispatch skips the sender, whose
    // optimistic bubble is already on screen.
    this._emit(sessionId, this._userMessageEvent(options), {
      except: request.servedQueueId ? undefined : sourceClientId,
    })

    let handle: RunHandle
    const activeRun: SessionRunRequest = { ...request, input: effectiveInput }
    try {
      this.activeRunRequests.set(sessionId, activeRun)
      if (!dispatchAgentSessionId) {
        await this._logNewSessionPrompt(effectiveInput, options, backend.id)
      }
      const baseSystemPrompt = buildSystemPrompt({
        agent: provider === 'codex' ? 'codex' : 'claude',
        general: isWorkspacePath(effectiveCwd),
        extraInstructions: effectiveInput.extraInstructions,
        modelInstructions: effectiveInput.modelInstructions,
        planMode: effectiveInput.permissionMode === 'plan',
        prReview: effectiveInput.prReview,
      })
      const systemPrompt = [
        baseSystemPrompt,
        options.systemPrompt,
        handoffPayload?.seedSystemAppend,
      ].filter(Boolean).join('\n\n')
      const agentRun = this.runAgent({
        provider,
        prompt: options.prompt,
        cwd: effectiveCwd,
        tools: [
          ...request.tools,
          provider === 'codex'
            ? createClaudeSubagentAgentTool(this)
            : createCodexSubagentAgentTool(this),
        ],
        model: effectiveInput.model,
        reasoningEffort: effectiveInput.reasoningEffort,
        permissionMode: effectiveInput.permissionMode,
        persistence: 'session',
        sessionId: effectiveInput.agentSessionId,
        forkSession: effectiveInput.forked,
        additionalDirectories: effectiveAdditionalDirs,
        imageAttachments: options.imageAttachments,
        contextWindow: effectiveInput.contextWindow,
        fastMode: effectiveInput.fastMode,
        systemPrompt,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
      }, {
        changedFiles: effectiveInput.sessionChangedFiles,
      })
      handle = agentRun.handle
      handle.sessionId = sessionId
    } catch (err) {
      this.activeRunRequests.delete(sessionId)
      this._setStatus(sessionId, 'failed')
      this.activeSessions.delete(sessionId)
      throw err
    }

    return { handle, run: activeRun }
  }

  private async _linkPreparedTask(run: SessionRunRequest, sessionId: string): Promise<void> {
    const taskId = run.options.taskId
    if (!taskId) return
    // A shipped snapshot marks the task as foreign — its row lives on another
    // host, where the dispatching client writes this link itself.
    if (run.options.taskSnapshot) return
    try {
      await (await Task.byId(taskId)).linkSession(sessionId, 'working', {
        branch: run.input.gitContext?.branch ?? null,
        originSessionId: sessionId,
      })
    } catch (err) {
      log.error('task_session_link_failed', { taskId, sessionId, error: String(err) })
    }
  }

  /**
   * Hydrate the task into the packet appended to the run's system prompt: from
   * the snapshot the dispatching client shipped when the task is foreign, from
   * this host's own store otherwise. The foreign snapshot is also held for the
   * session so `read_task` (and op overlays) answer from the same state.
   */
  private async _taskSystemContext(
    taskId: string,
    shipped: TaskSnapshot | null,
    sessionId: string,
  ): Promise<string | null> {
    const lifecyclePolicy = getServerSettings().agentTaskLifecyclePolicy
    if (shipped && shipped.details.task.id === taskId) {
      setForeignTaskSnapshot(sessionId, shipped)
      const overlaid = foreignTaskFor(sessionId, taskId) ?? shipped
      return formatTaskContext(overlaid.details, overlaid.parent, overlaid.sessions, lifecyclePolicy)
    }
    setForeignTaskSnapshot(sessionId, null)
    try {
      const snapshot = await taskSnapshot(taskId)
      return formatTaskContext(snapshot.details, snapshot.parent, snapshot.sessions, lifecyclePolicy)
    } catch (err) {
      // On a dispatch this once failed silently — the task's row lives on
      // another host. A taskId this host cannot read now always names a defect:
      // either the snapshot was not shipped or the local row is gone.
      log.warn('task_context_injection_failed', { taskId, sessionId, shippedSnapshot: !!shipped, error: String(err) })
      return null
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
      log.warn('new_session_prompt_csv_failed', { error: String(err) })
    }
  }

  /** The session an IPC context is acting on. A client that only knows the
   *  provider thread (a resume it has not bound yet) resolves through seam (b). */
  private _sessionIdForCtx(ctx: IpcContext): string | undefined {
    return ctx.session.sessionId || this._sessionIdFor(ctx.session.agentSessionId)
  }

  private _drainQueue(sessionId: string): void {
    const reason = new Error('Interrupted')
    const queue = this.requestQueue.get(sessionId)
    if (!queue) return
    for (let i = queue.length - 1; i >= 0; i--) {
      const req = queue[i]
      queue.splice(i, 1)
      // A queued prompt never reaches the normal settlement path when Stop
      // drains it, so its caller would otherwise stay held forever.
      this._cancelAgentConversationRunWatches(sessionId, req.queueId)
      req.reject(reason)
      this._emit(req.sessionId, { type: 'prompt_dequeued', queueId: req.queueId })
      if (req.rateLimitSessionId) this._cleanupRateLimitTimerIfUnused(req.rateLimitSessionId)
      log.info('queued_request_drained', { queueId: req.queueId, sessionId })
    }
    if (queue.length === 0) this.requestQueue.delete(sessionId)
  }

  cancelQueuedPrompt(ctx: IpcContext, queueId: string): boolean {
    const sessionId = this._sessionIdForCtx(ctx)
    if (!sessionId) return false
    return this._cancelQueuedPrompt(sessionId, queueId)
  }

  /** Callers outside the renderer name the session by its provider thread. */
  cancelQueuedPromptForSession(agentSessionId: string, queueId: string): boolean {
    const sessionId = this.agentSessionToSession.get(agentSessionId)
    if (!sessionId) return false
    return this._cancelQueuedPrompt(sessionId, queueId)
  }

  private _cancelQueuedPrompt(sessionId: string, queueId: string): boolean {
    const queue = this.requestQueue.get(sessionId)
    if (!queue) return false
    const idx = queue.findIndex((r) => r.queueId === queueId)
    if (idx === -1) return false
    const [req] = queue.splice(idx, 1)
    req.reject(new Error('Cancelled by user'))
    this._emit(req.sessionId, { type: 'prompt_dequeued', queueId: req.queueId })
    if (req.rateLimitSessionId) this._cleanupRateLimitTimerIfUnused(req.rateLimitSessionId)
    if (queue.length === 0) this.requestQueue.delete(sessionId)
    log.info('queued_request_cancelled', { queueId, sessionId })
    return true
  }

  /** Rewrite a prompt that is still waiting its turn. Both fields matter: the
   *  queue displays `displayPrompt ?? prompt`, the run sends `prompt`. */
  editQueuedPrompt(ctx: IpcContext, queueId: string, text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed) return false
    const sessionId = this._sessionIdForCtx(ctx)
    if (!sessionId) return false
    const req = this.requestQueue.get(sessionId)?.find((r) => r.queueId === queueId)
    if (!req) return false

    req.prompt = trimmed
    req.run.options.prompt = trimmed
    req.run.options.displayPrompt = trimmed
    this._emit(req.sessionId, { type: 'prompt_queue_updated', queueId, text: trimmed })
    log.info('queued_request_edited', { queueId, sessionId })
    return true
  }

  /** Re-submit the same prompt. If the session is dead, drop its provider
   *  thread so a fresh one starts. */
  async retry(ctx: IpcContext, options: PromptOptions, clientId?: string): Promise<void> {
    const sessionId = this._sessionIdForCtx(ctx)
    if (!sessionId) throw new Error('No session to retry')
    const session = this.activeSessions.get(sessionId)
    const sourceClientId = clientId

    let request: SessionRunRequest
    const input = runInputFromContext(ctx)
    const tools = selectAgentTools(
      solusToolbox.works,
      solusToolbox.artifact,
      solusToolbox.automations,
      solusToolbox.cloudflare,
      solusToolbox.sessions,
      solusToolbox.tasks,
      solusToolbox.prs,
    )
    if (session?.status === 'dead') {
      session.agentSessionId = null
      this._setStatus(sessionId, 'idle')
      request = {
        input: { ...input, agentSessionId: null },
        target: { kind: 'new-session' },
        sessionId,
        sourceClientId,
        options,
        tools,
      }
    } else {
      const agentSessionId = session?.agentSessionId ?? ctx.session.agentSessionId
      request = !input.forked && agentSessionId
        ? { input, target: { kind: 'session', sessionId }, sessionId, sourceClientId, options, tools }
        : { input, target: { kind: 'new-session' }, sessionId, sourceClientId, options, tools }
    }

    const lifecycle = await this.runTurn(request)
    await lifecycle.agentSessionId
  }

  async rewindSessionFiles(ctx: IpcContext, checkpointId: string): Promise<void> {
    const sessionId = this._sessionIdForCtx(ctx)
    const session = sessionId ? this.activeSessions.get(sessionId) : undefined
    const agentSessionId = session?.agentSessionId ?? ctx.session.agentSessionId
    if (!agentSessionId) throw new Error('No provider thread to rewind')
    const backend = this._backendFor(session?.backendId ?? (session?.runInput?.provider ?? ctx.session.provider ?? ctx.settings.activeAgent))
    if (!backend) throw new Error('No backend found for this session')
    if (!backend.rewindFiles) throw new Error('Active backend does not support file rewind')
    const cwd = session?.gitContext?.worktreePath || ctx.session.workingDirectory
    await backend.rewindFiles(agentSessionId, checkpointId, cwd)
  }

  /** Answers a pending permission by questionId alone — the question already
   *  knows which session it belongs to, so this is callable from the RPC handler
   *  and from an agent tool acting on a peer session alike. */
  respondToPermission(questionId: string, optionId: string, updatedPlan?: string): boolean {
    const backend = this._backendForQuestion(questionId)
    const backends = backend ? [backend] : Array.from(this.backends.values())
    for (const b of backends) {
      const pendingInfo = b.permissions.getPendingInfo(questionId)
      if (b.permissions.respondToPermission(questionId, optionId, updatedPlan)) {
        this._clearPendingInputEvent(questionId)
        this.questionIdToSession.delete(questionId)
        captureServerEvent('permission_responded', {
          decision: optionId,
          ...(pendingInfo?.toolName ? { tool_name: pendingInfo.toolName } : {}),
        })
        if (pendingInfo?.toolName === 'ExitPlanMode') {
          captureServerEvent('plan_responded', { approved: optionId === 'allow' })
        }
        if (pendingInfo?.toolName === 'ExitPlanMode' && optionId === 'deny') {
          // The permission responder only knows the provider's thread id.
          const agentSessionId = pendingInfo.sessionId
          const sessionId = agentSessionId ? this.agentSessionToSession.get(agentSessionId) : undefined
          if (agentSessionId) b.cancelSession(agentSessionId)
          if (sessionId) this._setStatus(sessionId, 'interrupted')
        }
        return true
      }
    }
    return false
  }

  respondToQuestion(questionId: string, answers: Record<string, string>): boolean {
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
    const sessionId = this._sessionIdForCtx(ctx)
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
      this._setStatus(sessionId, 'idle')
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

  setSessionGitCheckout(sessionId: string, gitContext: GitCheckout | undefined): void {
    const existing = this.sessionGitEnvironments.get(sessionId)
    const cwd = gitContext?.worktreePath ?? existing?.cwd ?? gitContext?.repoRoot ?? '~'
    this.setSessionGitEnvironment(sessionId, cwd, gitContext ?? null)
  }

  /** Register the checkout a session currently represents. This deliberately
   * lives outside BackendSession: an idle session still needs branch/status
   * events. A source with no session of its own registers nothing. */
  setSessionGitEnvironment(sessionId: string, cwd: string, gitContext: GitCheckout | null): void {
    if (!sessionId) return
    const session = this.activeSessions.get(sessionId)
    if (session) session.gitContext = gitContext ?? undefined
    if (!gitContext || !cwd || cwd === '~') {
      this.sessionGitEnvironments.delete(sessionId)
      this._syncGitWatcher(sessionId, null)
      return
    }
    const checkoutCwd = gitContext.worktreePath ?? cwd
    this.sessionGitEnvironments.set(sessionId, { cwd: checkoutCwd, gitContext })
    this._syncGitWatcher(sessionId, checkoutCwd)
  }

  /**
   * Register/deregister the live git watcher for a session as its checkout comes
   * and goes. Keyed by checkout cwd so sessions sharing one checkout share
   * watchers, while linked worktrees retain their own HEAD/index targets. The
   * per-session key is tracked so teardown ref-counts correctly even when the
   * context changes (e.g. branch → worktree).
   */
  private _syncGitWatcher(sessionId: string, cwd: string | null): void {
    const nextKey = cwd && cwd !== '~' ? cwd : null
    const prevKey = this.gitWatchKeys.get(sessionId) ?? null
    if (prevKey === nextKey) return
    if (prevKey) {
      this.gitWatcher.deregister(prevKey)
      this.gitWatchKeys.delete(sessionId)
    }
    if (nextKey) {
      this.gitWatcher.register(nextKey)
      this.gitWatchKeys.set(sessionId, nextKey)
    }
  }

  /**
   * A watched repo changed on disk. Recompute branch + status for every session
   * in that repo (deduped by working dir) and broadcast so the renderer mirrors
   * it without a click. Branch goes out as the already-handled `git_context`
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
    const sessionIds = [...this.gitWatchKeys.entries()].filter(([, key]) => key === watchCwd).map(([id]) => id)
    if (!sessionIds.length) return

    const statusByCwd = new Map<string, Awaited<ReturnType<typeof computeGitState>>>()
    // Whether each cwd's status actually changed since its last broadcast —
    // decided once per cwd so sessions sharing a cwd all deliver (or all skip) together.
    const changedByCwd = new Map<string, boolean>()
    for (const sessionId of sessionIds) {
      const environment = this.sessionGitEnvironments.get(sessionId)
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
          this.sessionGitEnvironments.set(sessionId, { cwd, gitContext })
          const session = this.activeSessions.get(sessionId)
          if (session) session.gitContext = gitContext
          this._emit(sessionId, { type: 'git_context', gitContext })
        }
      }
      // Skip the git_status broadcast when nothing changed since the last fire —
      // belt-and-braces to cut IPC to hidden windows (the renderer diffs too).
      if (changedByCwd.get(cwd)) {
        this._emit(sessionId, { type: 'git_status', cwd, state: status })
      }
    }
  }

  /** Only the worktree paths are read; the id they were registered under is not. */
  listGitContexts(): GitCheckout[] {
    const result: GitCheckout[] = []
    for (const environment of this.sessionGitEnvironments.values()) {
      if (environment.gitContext.worktreePath) result.push({ ...environment.gitContext })
    }
    return result
  }

  getGitContext(sessionId: string): GitCheckout | undefined {
    return this.sessionGitEnvironments.get(sessionId)?.gitContext
  }

  /** Whether the next drain would actually dispatch — the same question
   *  `_processQueueForSession` asks, for callers that must decide before it is
   *  safe to run the drain itself. */
  private _hasReadyQueuedRequest(sessionId: string): boolean {
    const next = this.requestQueue.get(sessionId)?.[0]
    return !!next && this._isQueuedRequestReady(next)
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
      }, {
        sessionId,
        reason: 'rate_limit',
        rateLimitSessionId: sessionId,
        releaseAt: event.resetsAt,
        rateLimitType: event.rateLimitType,
      })
    } catch (err) {
      log.error('rate_limit_queue_failed', { sessionId, error: String(err) })
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
      this._setStatus(sessionId, hasQueued ? 'running' : 'idle')
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
      this._emit(req.sessionId, { type: 'prompt_dequeued', queueId: req.queueId })
    }
    if (queue.length === 0) this.requestQueue.delete(sessionId)
  }

  private _broadcastRateLimitResolved(sessionId: string, action: RateLimitDecisionAction): void {
    // The event's own `sessionId` is what the renderer matches its rate-limit
    // card against — the provider thread it was raised for.
    const agentSessionId = this._agentSessionIdFor(sessionId)
    if (!agentSessionId) return
    this._emit(sessionId, {
      type: 'rate_limit_resolved',
      sessionId: agentSessionId,
      action,
    })
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
    log.info('queued_request_processing', { queueId: req.queueId })

    this._emit(req.sessionId, { type: 'prompt_dequeued', queueId: req.queueId })

    const reqInput = req.run.input
    const dispatchSession = this.activeSessions.get(req.sessionId)
    const freshProvider = dispatchSession?.backendId ?? reqInput.provider
    const input: SessionRunInput = {
      ...reqInput,
      provider: freshProvider,
      agentSessionId: dispatchSession?.agentSessionId ?? reqInput.agentSessionId,
    }

    this._startRunLifecycle({
      ...req.run,
      input,
      target: { kind: 'session', sessionId: req.sessionId },
      sessionId: req.sessionId,
      servedQueueId: req.queueId,
    })
      .then((lifecycle) => lifecycle.done)
      .then(() => req.resolve())
      .catch((e) => req.reject(e))
    return true
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
        clientPromptId: r.run.options.clientPromptId,
        text: r.prompt,
        enqueuedAt: r.enqueuedAt,
        reason: r.reason,
        releaseAt: r.releaseAt,
        rateLimitType: r.rateLimitType,
        images: r.run.options.imageAttachments,
      }))
  }

  private _checkActiveRuns(): void {
    // One loop, over sessions. Whether anybody is watching only decides whether
    // the death is announced, not whether it is noticed.
    for (const [sessionId, session] of this.activeSessions) {
      const backend = this._backendFor(session.backendId)
      const agentSessionId = session.agentSessionId
      const alive = !!agentSessionId && backend.isSessionRunning(agentSessionId)
      const hasPendingRun = !alive && backend.getPendingHandles().some((handle) => handle.sessionId === sessionId)
      if (alive || hasPendingRun) {
        this.missingRunCounts.delete(sessionId)
        continue
      }
      if (!isSessionBusyStatus(session.status) && !this.watches.get(sessionId)?.size) {
        // An idle unwatched session is not a stuck run; leave it resident.
        this.missingRunCounts.delete(sessionId)
        continue
      }

      const misses = (this.missingRunCounts.get(sessionId) ?? 0) + 1
      this.missingRunCounts.set(sessionId, misses)
      if (misses < RUN_WATCHDOG_MISSES) continue

      log.warn('active_session_not_running', { sessionId, agentSessionId })
      this._markSessionDead(sessionId)
    }

    // Self-heal for any active-work transition that bypassed _setStatus
    // (e.g. the last watch dropping while running); at worst the power blocker lingers one tick.
    this._notifyActiveWork()
  }

  private _markSessionDead(sessionId: string): void {
    const session = this.activeSessions.get(sessionId)
    const agentSessionId = session?.agentSessionId
    if (session && agentSessionId) {
      this._backendFor(session.backendId).permissions.clearPendingForSession(agentSessionId)
    }
    this._flushPendingSession(sessionId, false)
    this._currentRateLimitEvent(sessionId)
    if (session) {
      session.hasPendingInput = false
      session.pendingInputEvents = []
    }

    this._emit(sessionId, {
      type: 'session_dead',
      exitCode: null,
      signal: null,
      stderrTail: [],
    })
    this._setStatus(sessionId, 'dead')
    this.activeSessions.delete(sessionId)
    this.missingRunCounts.delete(sessionId)
    clearForeignTaskSnapshot(sessionId)
    if (agentSessionId) this.attention.resolve(agentSessionId)
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
  private _syncAttention(agentSessionId: string, sessionId: string, newStatus: SessionStatus): void {
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
      this.attention.resolve(agentSessionId)
      return
    }

    // projectKey/summary are best-effort: on the process-exit path the session
    // is already gone, so finished/failed entries may carry neither.
    const projectKey = session?.gitContext?.repoRoot
      ?? session?.runInput?.projectPath
      ?? session?.runInput?.workingDirectory
    this.attention.set({
      sessionId: agentSessionId,
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

  private _setStatus(sessionId: string, newStatus: SessionStatus): void {
    this._applyStatus(sessionId, newStatus)
    this._notifyActiveWork()
  }

  /** Publish one Solus-owned terminal boundary for the active top-level turn.
   *  Queueing the event preserves result-before-settlement ordering when a
   *  provider's `task_complete` caused the status transition in this same stack. */
  private _queueTurnSettlement(
    sessionId: string,
    session: BackendSession,
    outcome: 'completed' | 'failed' | 'interrupted' | 'dead',
  ): void {
    const turnId = session.activeTurnId ?? crypto.randomUUID()
    session.activeTurnId = turnId
    if (session.settledTurnId === turnId) return
    session.settledTurnId = turnId
    const settledAt = Date.now()
    queueMicrotask(() => {
      log.info('turn_settled', { sessionId, turnId, outcome, settledAt })
      this._emit(sessionId, { type: 'turn_settled', turnId, outcome, settledAt })
    })
  }

  private _applyStatus(sessionId: string, newStatus: SessionStatus): void {
    const session = this.activeSessions.get(sessionId)
    // Attention persists across restarts and is correlated with rows read off
    // disk, so it stays keyed by the provider's thread id — seam (b).
    const agentSessionId = session?.agentSessionId ?? null
    if (agentSessionId) this._syncAttention(agentSessionId, sessionId, newStatus)

    const oldStatus = session?.status ?? 'idle'
    if (oldStatus === newStatus) return

    let goalUpdate: ThreadGoal | null = null
    if (session) {
      session.status = newStatus
      if (session.backendId === 'claude-code' && agentSessionId) {
        goalUpdate = this.claudeGoals.applySessionStatus(agentSessionId, newStatus)
      }
    }
    // Global (not watch-scoped) feed so agent-conversation cards can track
    // sessions no client is looking at.
    this.emit('session-status', { sessionId, agentSessionId, status: newStatus, at: Date.now() })

    if (session && newStatus === 'interrupted' && session.pendingInputEvents.length > 0) {
      const hasPendingPlans = session.pendingInputEvents.some((e) => e.type === 'plan')
      if (hasPendingPlans) {
        session.pendingInputEvents = session.pendingInputEvents.filter((e) => e.type !== 'plan')
        session.hasPendingInput = session.pendingInputEvents.length > 0
      }
    }

    log.info('session_status_changed', { sessionId, agentSessionId, oldStatus, newStatus })
    this._emit(sessionId, { type: 'status_change', status: newStatus, oldStatus })
    if (
      session &&
      (newStatus === 'completed' || newStatus === 'failed' || newStatus === 'interrupted' || newStatus === 'dead')
    ) {
      this._queueTurnSettlement(sessionId, session, newStatus)
    }
    if (goalUpdate) this._emit(sessionId, { type: 'goal_updated', goal: goalUpdate })
  }

  shutdown(): void {
    log.info('control_plane_shutdown')
    if (this.runWatchdogTimer) {
      clearInterval(this.runWatchdogTimer)
      this.runWatchdogTimer = null
    }
    for (const timer of this.rateLimitTimers.values()) clearTimeout(timer)
    this.rateLimitTimers.clear()
    this.rateLimits.clearAll()
    for (const run of this.activeAgentRuns) run.cancel()
    this.activeAgentRuns.clear()
    this.activeUnattendedAgentRuns.clear()

    for (const session of this.activeSessions.values()) {
      if (!session.agentSessionId) continue
      this._backendFor(session.backendId).cancelSession(session.agentSessionId)
    }
    this.activeSessions.clear()
    this.agentSessionToSession.clear()

    for (const backend of this.backends.values()) {
      for (const handle of backend.getPendingHandles()) {
        handle.abortController.abort()
      }
    }

    this.watches.clear()
    for (const backend of this.backends.values()) {
      try {
        backend.shutdown?.()
      } catch (err) {
        log.warn('backend_shutdown_failed', { backendId: backend.id, error: err instanceof Error ? err.message : String(err) })
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
      for (const sessionId of [...this.pendingFlush.keys()]) {
        this._flushPendingSession(sessionId, true)
      }
    }, TEXT_FLUSH_INTERVAL_MS)
  }

  private _stopTextFlushTimer(): void {
    if (this.textFlushTimer) {
      clearInterval(this.textFlushTimer)
      this.textFlushTimer = null
    }
  }

  /**
   * The whole routing surface. One publish per watching client — two panes on
   * one renderer are one client and get one payload. `except` drops the client
   * whose optimistic bubble is already on screen; `only` narrows to the client
   * that asked (a reattach replay, or a sender's own withheld echo).
   */
  private _emit(sessionId: string, event: NormalizedEvent, to?: { only?: string; except?: string }): void {
    this.emit('event', sessionId, event, to)
  }

  private _emitError(sessionId: string, error: ReturnType<AgentBackend['getEnrichedError']>): void {
    this.emit('error', sessionId, error)
  }


  private _clearPendingInputEvent(questionId: string): void {
    const match = (e: NormalizedEvent) => 'questionId' in e && (e as any).questionId === questionId

    for (const session of this.activeSessions.values()) {
      if (!session.pendingInputEvents.length) continue
      const before = session.pendingInputEvents.length
      session.pendingInputEvents = session.pendingInputEvents.filter((e) => !match(e))
      session.hasPendingInput = session.pendingInputEvents.length > 0

      if (session.pendingInputEvents.length !== before) {
        // The pause a watcher already reported has been answered — by a human
        // looking at this session or by a peer agent's answer tool. Re-arm the prose
        // report so a SECOND pause in the same exchange still surfaces to the
        // caller instead of going silent.
        for (const watches of this.agentConversationWatches.get(session.sessionId)?.values() ?? []) {
          for (const watch of watches) watch.awaitingReported = false
        }
        this._setStatus(session.sessionId, this._pendingInputStatus(session))
        this._emit(session.sessionId, {
          type: 'pending_input_sync',
          pendingInputEvents: [...session.pendingInputEvents],
        })
      }
    }
  }

  /** Emit a session's buffered text immediately (first-chunk latency), keeping the marker so the rest batch. */
  private _flushPendingText(sessionId: string): void {
    const text = this.pendingFlush.get(sessionId)
    if (!text) return
    this._emit(sessionId, { type: 'text_chunk', text })
    this.pendingFlush.set(sessionId, '')
  }

  /**
   * Drain a session's buffered text. `keep=true` (interval tick) resets the marker to ''
   * when there was data so an active stream keeps batching, and drops the idle marker
   * so the timer can settle; `keep=false` (boundary/exit) drops it so ordering with
   * the triggering event holds.
   */
  private _flushPendingSession(sessionId: string, keep: boolean): void {
    const text = this.pendingFlush.get(sessionId)
    if (text === undefined) return
    if (text) this._emit(sessionId, { type: 'text_chunk', text })
    if (keep && text) this.pendingFlush.set(sessionId, '')
    else this.pendingFlush.delete(sessionId)
  }
}
