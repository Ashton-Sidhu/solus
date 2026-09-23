import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import { questionKey } from '@solus/contracts/question-answer'
import { installedRoutingProviders, routeModelPrompt } from './agents/model-routing'
import { loadHistoryPage, type HistorySegment } from './sessions/history-page'
import { EventEmitter } from 'events'
import { appendFile, mkdir, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { createLogger } from './logger'
import { captureServerEvent } from './analytics'
import { createWorktree } from './git/worktree-manager'
import { generateWorktreeName } from './git/worktree-name'
import { computeGitState } from './git/git-helpers'
import { checkoutWithLiveIdentity } from './git/git-context'
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
import { resolvePromptImages } from './agents/prompt-image-refs'
import { isRawReviewSkill } from './agents/review-command'
import { hostInstructionsFor, hostModelInputFor, providerConversationFor, runInputFromContext } from './agents/run-input'
import { buildHandoff, composeHandoffSeed } from './agents/session-handoff'
import { buildSystemPrompt } from './agents/system-hint'
import { isWindowClosed, RateLimitState } from './rate-limits'
import { UsageLimitsStore } from './usage/usage-store'
import { AttentionService, attentionActionForStatus } from './attention/attention-service'
import { finishedSummary } from './attention/finished-summary'
import type { AttentionKind } from '@solus/contracts/attention-types'
import { prepareSessionTask, rekeyTaskSessionLinks, taskIdForSession, tasksForSession } from './tasks/task-sessions'
import { Task, taskSnapshot } from './tasks/task'
import { formatTaskContext } from './tasks/task-context'
import { ResponseTextBuffer } from './sessions/response-text-buffer'
import { getHostConfig } from './server/settings'
import { LOCAL_ORGANIZATION_ID } from './server/principal'
import { sessionRecordStatusOf, setSessionRecordStatus } from './sessions/session-records'
import { clearForeignTaskSnapshot, foreignTaskFor, setForeignTaskSnapshot } from './tasks/foreign-tasks'
import type { TaskSnapshot } from '@solus/contracts/task-types'
import { getIndexedSession, persistIndexedSessionStart, setSessionBranch } from './db/session-indexer'
import {
  beginSessionHandoff,
  cancelProvisionalSessionHandoff,
  completeSessionHandoff,
  registerSessionLineage,
  resolveSessionLineage,
  resolveSessionLineageById,
  replaceSessionLineageThread,
  stableSessionIdForProviderThread,
} from './sessions/session-lineage'
import {
  buildSessionAwaitingInputReport,
  buildSessionSettledReport,
  formatPendingInputReport,
  agentConversationQuestionFromPendingInput,
} from './sessions/session-report'
import type { AgentConversationWatchRequest, AgentReplyRoute } from './sessions/session-tools'
import { ClaudeGoalStore } from './sessions/claude-goal-store'
import type { AgentBackend, RunHandle } from './agents/agent-backend'
import type {
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
  SessionDescription,
  SessionLineageResolution,
  SessionProviderSwitchResult,
  SessionRecordStatus,
  SentSessionMessage,
  AgentConversationQuestion,
  StatusCardState,
  StatusCardStep,
  ThreadGoal,
  ThreadGoalSetRequest,
  WatchSessionInput,
  WatchSessionResult,
} from '@solus/contracts/types'
import { defaultContextWindowFor, encodePathAsFolder, gitCheckoutFromState, isSessionBusyStatus, isSteerableStatus, modelLabelFor, projectScopeOf, sameGitCheckout } from '@solus/contracts/types'
import { solusDir } from './platform/paths'
import { indexLivePlan } from './plans/plan-index'
import { activityLeases } from './server/activity-leases'
import type { SessionHistoryPageRequest, ProviderHistoryPage, SessionLoadMessage, SessionPreviewResult } from '@solus/contracts/session-history'
import { SessionEmitter, annotateDispatch, dispatchStep, dispatchStepSync } from './observability/session-emitter'
import { SeatRequiredError, type SeatStore, type TurnActor, type TurnSeat } from './seats/seat-manager'
import { withCredentialScope } from './vault/credential-scope'
import { HOST_OWNER_USER_ID } from '@solus/contracts/sharing'
import { sessionActivityStateOf, type SessionActiveTurn, type SessionActivity } from '@solus/contracts/presence'
import { activeTurnFor, turnAuthorOf } from './presence/presence-manager'
import { SPAN_SERVICES } from './observability/registries'

const CODEX_RATE_LIMIT_SEND_BUFFER_SECONDS = 2 * 60
const MAX_QUEUE_DEPTH = 32
const RUN_WATCHDOG_INTERVAL_MS = 30_000
/** Cap on the in-flight turn's replay log. A turn this long is pathological; the
 *  bound keeps one runaway session from growing the process without limit. */
const TURN_LOG_MAX_EVENTS = 2000
/** Consecutive watchdog ticks a session may be missing a run before it is
 *  declared dead. The timer is a fixed interval, so at one miss a session
 *  created just before a tick was killed milliseconds after it started —
 *  measured at 248ms. Two misses guarantee a session at least one full
 *  interval to produce its run. */
const RUN_WATCHDOG_MISSES = 2
const IS_DEV_MODE = Boolean(process.env.ELECTRON_RENDERER_URL)
const NEW_SESSION_PROMPTS_CSV = join(solusDir(), 'new-session-prompts.csv')
const NEW_SESSION_PROMPTS_CSV_HEADER = 'input_prompt,model,agent_provider,reasoning_level\n'

const log = createLogger('ControlPlane', 'control-plane.ts')

const AGENT_DISPLAY_NAMES = new Map<AgentId, string>([
  ['claude-code', 'Claude Code'],
  ['codex', 'Codex'],
  ['opencode', 'OpenCode'],
])

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

interface AgentTransportInfo {
  'claude-code'?: string
  codex?: string
  opencode?: string
}

interface CreateSessionRequest {
  prompt: string
  provider: AgentId
  modelId: string | null
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
  cwd: string
  worktreeBaseBranch?: string | null
  taskId?: string | null
  parentTaskId?: string | null
  skipTaskCreation?: boolean
  reply?: AgentReplyRoute
  delegation?: { parentAgentSessionId: string; intent: 'delegate' | 'fire_and_forget' }
}

function startedSession(agentSessionId: string, taskId?: string): Parameters<PendingStart['resolve']>[0] {
  const result: Parameters<PendingStart['resolve']>[0] = { agentSessionId }
  if (taskId) result.taskId = taskId
  return result
}

function buildCreatedSessionPromptOptions(request: CreateSessionRequest): PromptOptions {
  const options: PromptOptions = {
    prompt: request.prompt,
    promptSource: 'agent',
    displayPrompt: request.prompt,
  }
  if (request.taskId) options.taskId = request.taskId
  if (request.parentTaskId) options.parentTaskId = request.parentTaskId
  if (request.skipTaskCreation) options.skipTaskCreation = true
  return options
}

const CHILD_INTERRUPTED_BY_RESTART = 'The host restarted while this session was running. Its turn ended without a reply. Use read_session to see how far it got, and prompt_session to continue it.'

function planRulingText(optionId: string, updatedPlan: string | undefined): string {
  if (optionId === 'deny') return 'Rejected the plan'
  return updatedPlan ? 'Approved the plan, with edits' : 'Approved the plan'
}

function eventHasQuestionId(event: NormalizedEvent, questionId: string): boolean {
  return 'questionId' in event && event.questionId === questionId
}

/** One completion route owned by the exact run that must settle it. Provider
 *  identities are captured when the route is armed, before run teardown can
 *  remove live session records. */
interface AgentCompletionRoute extends AgentConversationWatchRequest {
  awaitingReported: boolean
  callerSessionId: string
  callerAgentSessionId: string
  targetAgentSessionId: string
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
  /** Dispatch timestamp of the drained queue entry. */
  servedEnqueuedAt?: number
  /** Agent exchanges waiting on this exact run. A route arrives with the prompt
   *  (or, for `wait_for_session`, joins the run already in flight), moves with
   *  a queued retry, and settles before this request is released. */
  completionRoutes?: AgentCompletionRoute[]
  /** The session that created this one, recorded with the new thread's first
   *  index row so the child is never indexed without its parent. */
  delegation?: { parentSessionId: string; messageId: string; intent: 'delegate' | 'fire_and_forget'; createdAt: number }
  /** Who asked and whose provider seat the turn runs on (Step 2 plan §3.3). Unset
   *  for the host's own work: automations, agent follow-ups, and local prompts. */
  actor?: TurnActor
}

/**
 * A member's turn calls GitHub, Google, and Atlassian as that member
 * (cloud-service-model.md §22): every tool the run is handed executes under
 * their credential scope. The host's own work keeps the host's connections.
 */
function credentialScopedAgentTools(tools: AgentTool[], actor: TurnActor | undefined): AgentTool[] {
  const userId = actor?.credentialUserId !== undefined ? actor.credentialUserId : (actor && actor.userId !== HOST_OWNER_USER_ID ? actor.userId : null)
  return tools.map((agentTool) => ({
    ...agentTool,
    execute: (input, context) => withCredentialScope(userId, () => agentTool.execute(input, context)),
  }))
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
  prepareSessionTask?: typeof prepareSessionTask
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
  /** Client-generated prompt ids this plane already accepted, insertion-ordered
   *  so the oldest fall off first (outbox replay dedupe, dispatch-client step 6). */
  private acceptedClientPromptIds = new Set<string>()
  /** Provider thread id → the session record status this process last wrote for it. */
  private recordStatusWritten = new Map<string, SessionRecordStatus>()
  /** Provider threads whose lineage this process has registered; later inits of the same thread skip the transaction. */
  private registeredLineageThreads = new Set<string>()
  /** Provider threads whose start this process has indexed, with the model and effort it recorded. */
  private indexedThreadStarts = new Map<string, string>()
  /** Sessions whose durable lineage showed no provisional handoff. Only this plane begins one, and it records it in `pendingHandoffs` first. */
  private sessionsWithoutPendingHandoff = new Set<string>()
  private hadActiveWork = false
  private requestQueue = new Map<string, QueuedRequest[]>()
  private activeRunRequests = new Map<string, SessionRunRequest>()
  private pendingStarts = new Map<RunHandle, PendingStart>()
  /** Worktree setup begins before an agent RunHandle exists, so it needs its
   *  own cancellation path for Stop/Ctrl-C. */
  private pendingSetupControllers = new Map<string, AbortController>()
  /** Full prompt retained until a failed setup is retried or cancelled on any client. */
  private failedSetupPrompts = new Map<string, PromptOptions>()
  private pendingHandoffs = new Map<string, PendingSessionHandoff>()
  private backends: Map<AgentId, AgentBackend>
  private agentRunner: AgentRunner
  private activeAgentRuns = new Set<AgentRun>()
  private activeUnattendedAgentRuns = new Set<AgentRun>()
  private readonly claudeGoals = new ClaudeGoalStore()
  private readonly sessionEmitter = new SessionEmitter()

  private readonly responseText = new ResponseTextBuffer()
  /**
   * Every event the in-flight turn has broadcast, in order, per session. Replayed
   * by bindRuntimeSession so a client that opens a running session mid-turn is
   * level with the clients that were already watching — the same tool calls, not
   * just the text. Durable transcripts on disk never contain an unsettled turn, so
   * this is the only place that history exists. Cleared when the turn settles.
   */
  private turnLog = new Map<string, NormalizedEvent[]>()
  private runWatchdogTimer: ReturnType<typeof setInterval> | null = null
  private rateLimitTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private missingRunCounts = new Map<string, number>()
  private rateLimits = new RateLimitState()
  /** Cached provider quota windows. Fed by the provider streams
   *  below and by the polled read in the usage handlers. */
  readonly usageLimits = new UsageLimitsStore()
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
  /** Repo roots that changed while no client held a foreground lease. */
  private deferredGitWatchCwds = new Set<string>()
  private readonly handoffBuilder: typeof buildHandoff
  private readonly sessionTaskPreparer: typeof prepareSessionTask
  /** Provider seats, once the host has opened its database. */
  private seats: SeatStore | null = null

  constructor(backends: Map<AgentId, AgentBackend>, opts: ControlPlaneOptions = {}) {
    super()
    this.backends = backends
    this.agentRunner = new AgentRunner(backends)
    this.handoffBuilder = opts.buildHandoff ?? buildHandoff
    this.sessionTaskPreparer = opts.prepareSessionTask ?? prepareSessionTask
    for (const backend of this.backends.values()) {
      this._wireBackend(backend)
    }
    this.gitWatcher = new GitWatcher((repoRoot) => { void this._onGitWatchFire(repoRoot) })
    this.runWatchdogTimer = setInterval(() => this._checkActiveRuns(), RUN_WATCHDOG_INTERVAL_MS)
    this.runWatchdogTimer.unref?.()
  }

  /** The stable id a share list is keyed on, for a session named by either id space. */
  canonicalSessionId(id: string): string {
    return this._sessionIdFor(id) ?? id
  }

  /**
   * Whether this host has any record of a session, by either id: something live on
   * its behalf, a lineage, or an index row. The share manager treats an unknown id
   * as a session being started, which its starter may do.
   */
  isKnownSession(id: string): boolean {
    return this._sessionIdFor(id) !== undefined || getIndexedSession(id) !== null
  }

  /** Solus's id for a session named by either id space. The provider-id arm is
   *  seam (b): rows read off disk (the picker, MCP session tools, the session
   *  index) only ever hold a provider thread id. */
  private _sessionIdFor(id: string | null | undefined): string | undefined {
    if (!id) return undefined
    // The registered lineage outranks anything held locally. A client that never
    // adopted the id we answered with still has a watch under its own name, so
    // trusting "is watched" first would let a stale name win over the durable one.
    // The two id spaces never collide, so this lookup cannot misfire on a Solus id.
    const registered = this.agentSessionToSession.get(id) ?? stableSessionIdForProviderThread(id)
    if (registered) return registered
    // A session is addressable from the moment anything is happening on its
    // behalf — a client watching it, or a worktree being prepared for it — not
    // only once it has a record and a provider thread.
    if (this.activeSessions.has(id) || this.watches.has(id) || this.pendingSetupControllers.has(id) || this.failedSetupPrompts.has(id)) return id
    return undefined
  }

  /** The provider thread behind a session, for the calls that cross into a
   *  backend. Null before session_init. */
  private _agentSessionIdFor(sessionId: string): string | null {
    return this.activeSessions.get(sessionId)?.agentSessionId ?? null
  }

  /** What the transcript mirror needs to read a session's history: the provider,
   *  its thread id, and the project folder. Null before session_init. */
  sessionTranscriptSource(sessionId: string): { provider: AgentId; agentSessionId: string; projectPath: string | undefined } | null {
    const session = this.activeSessions.get(sessionId)
    if (!session?.agentSessionId) return null
    return { provider: session.backendId, agentSessionId: session.agentSessionId, projectPath: session.runInput?.projectPath }
  }

  /** Restore a provisional handoff after a server restart. The SQLite chain is
   * authoritative; the map only avoids repeating the lookup while this host runs. */
  private _pendingHandoffFor(sessionId: string): PendingSessionHandoff | undefined {
    const inMemory = this.pendingHandoffs.get(sessionId)
    if (inMemory) return inMemory
    if (this.sessionsWithoutPendingHandoff.has(sessionId)) return undefined
    const handoff = resolveSessionLineageById(sessionId)
    const activeMember = handoff?.active
    const previousMember = handoff?.members.at(-2)
    if (activeMember?.providerSessionId !== null || !previousMember?.providerSessionId) {
      this.sessionsWithoutPendingHandoff.add(sessionId)
      return undefined
    }
    const restored = {
      fromProvider: previousMember.provider,
      fromSessionId: previousMember.providerSessionId,
    }
    this.pendingHandoffs.set(sessionId, restored)
    return restored
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

      // Quota is an account fact, not a conversation one: it goes to the store
      // and stops there. Both providers report it on nearly every turn, which
      // is what keeps a reset time available the moment a limit lands.
      if (event.type === 'usage_limits') {
        this.usageLimits.applyWindows(backend.id, event.windows)
        return
      }

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
        // Register the binding durably, once. First writer wins: if this thread is
        // already registered — another client named it first, or we named it before
        // a restart — the registered id comes back and the proposed one is dropped.
        // Everything below routes by the registered id, so two clients cannot end up
        // holding two names for one conversation.
        // Claude reports init on every turn. A thread this process already
        // registered under the same id has nothing new to write.
        const alreadyRegistered = this.registeredLineageThreads.has(event.sessionId)
          && this.agentSessionToSession.get(event.sessionId) === initSessionId
        if (!alreadyRegistered) {
          const registered = registerSessionLineage({
            sessionId: initSessionId,
            provider: backend.id,
            providerSessionId: event.sessionId,
            cwd: pendingStart?.run.input.workingDirectory
              ?? this.activeSessions.get(initSessionId)?.runInput?.workingDirectory
              ?? getIndexedSession(event.sessionId)?.cwd
              ?? '~',
          })
          if (registered.sessionId !== initSessionId) {
            log.warn('session_init_id_already_registered', {
              sessionId: registered.sessionId,
              proposedSessionId: initSessionId,
              agentSessionId: event.sessionId,
              provider: backend.id,
            })
          }
          const sourceRun = pendingStart?.run ?? this.activeRunRequests.get(initSessionId)
          if (sourceRun?.input.forked && sourceRun.input.agentSessionId
            && registered.active.providerSessionId === sourceRun.input.agentSessionId) {
            replaceSessionLineageThread({
              sessionId: initSessionId, provider: backend.id,
              sourceThreadId: sourceRun.input.agentSessionId,
              providerSessionId: event.sessionId, cwd: sourceRun.input.workingDirectory,
            })
          }
          this.registeredLineageThreads.add(event.sessionId)
        }
        this.agentSessionToSession.set(event.sessionId, initSessionId)
        const pendingHandoff = this.pendingHandoffs.get(initSessionId)
        if (pendingHandoff) {
          const handoffCwd = pendingStart?.run.input.workingDirectory
            ?? this.activeSessions.get(initSessionId)?.runInput?.workingDirectory
            ?? getIndexedSession(event.sessionId)?.cwd
            ?? '~'
          try {
            completeSessionHandoff(initSessionId, backend.id, event.sessionId, handoffCwd)
            this.pendingHandoffs.delete(initSessionId)
          } catch (error) {
            log.error('session_handoff_binding_failed', {
              sessionId: initSessionId,
              agentSessionId: event.sessionId,
              provider: backend.id,
              error: error instanceof Error ? error.message : String(error),
            })
          }
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
            // A created child's routes were addressed to its pending card; from
            // here its updates name the real thread, as `attached` does.
            for (const route of initializedRun.completionRoutes ?? []) {
              if (route.targetAgentSessionId.startsWith('pending:')) route.targetAgentSessionId = event.sessionId
            }
            const started: Parameters<PendingStart['resolve']>[0] = { agentSessionId: event.sessionId }
            if (pendingStart.run.options.taskId) started.taskId = pendingStart.run.options.taskId
            pendingStart.resolve(started)
          }
        }
        // Preserve the run contract so a reattaching client (e.g. after a
        // refresh) can read back the live status, model config and permission
        // mode via bindRuntimeSession, and a backgrounded automation can
        // re-dispatch by run input alone. Without this, a first-run session has
        // no runInput and bind returns null, leaving the session stuck at idle.
        const existingSession = this.activeSessions.get(initSessionId)
        const runReqInput = this.activeRunRequests.get(initSessionId)?.input ?? initializedRun?.input
        // Every column the index row fills is COALESCE-guarded, and status has its
        // own writer, so a later init of the same thread only matters when the
        // model or effort the record shows has changed.
        const indexedStart = runReqInput ? `${runReqInput.model}\u0000${runReqInput.reasoningEffort}` : null
        if (runReqInput && indexedStart && this.indexedThreadStarts.get(event.sessionId) !== indexedStart) {
          this.indexedThreadStarts.set(event.sessionId, indexedStart)
          this.recordStatusWritten.set(event.sessionId, 'running')
          persistIndexedSessionStart(
            event.sessionId,
            backend.id,
            runReqInput.workingDirectory,
            encodePathAsFolder(runReqInput.workingDirectory),
            runReqInput.model,
            runReqInput.reasoningEffort,
            firstDispatchRun?.options.displayPrompt ?? firstDispatchRun?.options.prompt ?? null,
            runReqInput.gitContext?.branch ?? null,
            firstDispatchRun?.delegation,
          )
        }
        if (existingSession) {
          // Claude emits another init for the same session when a background
          // task notification resumes the parent. Treat it as idempotent:
          // replacing the record here would discard pending input and the
          // background task IDs that keep the session running.
          existingSession.backendId = backend.id
          existingSession.agentSessionId = event.sessionId
          delete existingSession.handoffFrom
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
          this.emit('session-status', { sessionId: initSessionId, agentSessionId: event.sessionId, status: 'running', at: Date.now() })
        }
        const goalObjective = initializedRun?.options.goalObjective
        if (backend.id === 'claude-code' && goalObjective) {
          initializedGoal = this.claudeGoals.get(event.sessionId)
            ?? this.claudeGoals.create({ threadId: event.sessionId, objective: goalObjective })
        }
        if (firstDispatchRun?.options.taskId) {
          // Task attempts use the stable Solus session id. The renderer writes
          // the same binding after session_init; using the provider thread id
          // here creates a second link that resolves to the same conversation.
          void this._linkPreparedTask(firstDispatchRun, initSessionId)
        }
        this._notifyActiveWork()
      }

      const sessionId = this.agentSessionToSession.get(agentSessionId)
      if (sessionId && event.type !== 'rate_limit') {
        this.sessionEmitter.onEvent(sessionId, event)
      }
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
          const cwd = session.runInput?.workingDirectory ?? getIndexedSession(agentSessionId)?.cwd ?? '~'
          if (event.planToolUseId && event.planContent.trim()) {
            const planToolUseId = event.planToolUseId
            void indexLivePlan(LOCAL_ORGANIZATION_ID, {
              provider: backend.id,
              sessionId: agentSessionId,
              planToolUseId,
              projectPath: encodePathAsFolder(cwd),
              cwd,
              timestamp: Date.now(),
              planFilePath: event.planFilePath || undefined,
              content: event.planContent,
            }).catch((error) => {
              log.warn('plan_index_live_failed', { agentSessionId, planToolUseId, error: String(error) })
            })
          }
          // The task store indexes artifacts by the provider's thread id, which
          // is what a transcript row on disk carries.
          if (event.planToolUseId) {
            void Task.linkArtifactForSession(LOCAL_ORGANIZATION_ID, agentSessionId, {
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
            (pendingEvent) => !eventHasQuestionId(pendingEvent, event.questionId),
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
          // The agent is done, but the SDK query stays open while its background
          // tasks run and emits exit only once they settle. A task that never
          // ends (a log tail, a dev server) would otherwise hold 'running' for
          // the life of the query, so the turn settles into 'background'.
          if (this._awaitingAgentReply(session.sessionId)) {
            log.info('turn_complete_awaiting_agent_reply', { sessionId: session.sessionId, holdingRunning: true })
          } else if (session.backgroundTaskIds?.size) {
            log.info('turn_complete_tasks_in_flight', { sessionId: session.sessionId, inFlight: session.backgroundTaskIds.size })
            this._setStatus(session.sessionId, 'background')
            this._processQueueForSession(session.sessionId)
          } else {
            this._setStatus(session.sessionId, 'completed')
          }
        }

        if (event.type === 'rate_limit') {
          const rateLimitEvent = this.rateLimits.record(session.sessionId, this._prepareRateLimit(backend.id, event))
          if (!rateLimitEvent) return
          event = rateLimitEvent
        }

        if (event.type === 'rate_limit' && event.status !== 'allowed' && !event.isUsingOverage) {
          const run = this.activeRunRequests.get(session.sessionId)
          const deferCurrentRun = event.deferCurrentRun === true && !!run
          this._scheduleRateLimitRelease(session.sessionId, event.resetsAt)
          if (deferCurrentRun) {
            // Codex can report that the account is exhausted while it is still
            // completing the current turn. Keep that snapshot for the next send,
            // but do not interrupt the stream or present it as a failed prompt.
            return
          }

          this.sessionEmitter.acceptRateLimit(session.sessionId, event.rateLimitType)
          if (run && run.options.promptSource !== 'agent' && run.options.promptSource !== 'automation') {
            // Host settings can change while a user turn is running. Read the
            // current preference here; an old client snapshot is not the policy.
            run.input.rateLimitBehavior = getHostConfig().config.rateLimitBehavior
          }
          if (run?.input.rateLimitBehavior === 'queue') {
            this._queueActiveRateLimitedRequest(session.sessionId)
          }
          // Publish the queue before the status so clients cannot briefly show
          // a decision card for a retry the host already chose to queue.
          this._setStatus(session.sessionId, 'rate_limited')
        }
      }

      if (!session && event.type === 'rate_limit') {
        // No session record to key the limit against; without one there is
        // nothing to hold the snapshot for, so route the event through as-is.
        if (!sessionId) return
        const rateLimitEvent = this.rateLimits.record(sessionId, this._prepareRateLimit(backend.id, event))
        if (!rateLimitEvent) return
        event = rateLimitEvent
      }

      if (!sessionId) return

      // ─── Delivery ───
      //
      // No early return when nobody is watching: a session with an empty watch
      // set is an ordinary count, and the buffering and turn accumulation below
      // still have to happen so a client that joins later sees the turn.

      if (event.type === 'text_chunk') {
        for (const delivered of this.responseText.append(sessionId, event, getHostConfig().config.responseStreamingMode, Date.now())) {
          this._emit(sessionId, delivered)
        }
        return
      }

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
        this._flushPendingSession(sessionId)
        // The turn is over, so its replay log has done its job — durable history
        // covers it from here. Cleared after the flush so the final text is logged
        // for anyone binding in the same tick.
        this.turnLog.delete(sessionId)
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
        this.sessionEmitter.recordTerminal(
          sessionId,
          settledStatus === 'completed' || settledStatus === 'rate_limited'
            ? 'ok'
            : settledStatus === 'interrupted'
              ? 'interrupted'
              : 'error',
        )

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
        this.sessionEmitter.recordTerminal(sessionId, 'error')
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
    // Helpers called by an accepted turn must be able to finish its workflow.
    if (!sessionState && this.updateWorkCount === 0) this.assertNewWorkAllowed()
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
  watchSession(input: WatchSessionInput, clientId: string): WatchSessionResult {
    // Main resolves; the client asserts nothing. Two clients resuming one live
    // session must land on one id, or "one id" is only true within a client.
    const handoff = input.agentSessionId && input.provider
      ? resolveSessionLineage(input.provider, input.agentSessionId)
      : null
    const sessionId = handoff?.sessionId
      ?? (input.agentSessionId ? this.agentSessionToSession.get(input.agentSessionId) : undefined)
      ?? input.sessionId
      ?? crypto.randomUUID()
    if (handoff) {
      for (const member of handoff.members) {
        if (member.providerSessionId) this.agentSessionToSession.set(member.providerSessionId, sessionId)
      }
    } else if (input.agentSessionId) this.agentSessionToSession.set(input.agentSessionId, sessionId)

    // Drain what is already buffered to the clients that were here first: the
    // Buffered mode drains before joining. Paragraph mode leaves its unfinished
    // tail on the host and replays only blocks that have already been published.
    this._flushPendingSession(sessionId, true)

    let clients = this.watches.get(sessionId)
    if (!clients) {
      clients = new Set()
      this.watches.set(sessionId, clients)
    }
    if (!clients.has(clientId)) {
      clients.add(clientId)
      this.emit('watchers-changed', sessionId)
    }
    log.info('session_watched', { sessionId, clientId, watchers: clients.size })
    if (!input.attachRuntime || !input.agentSessionId) return { sessionId }
    // Same order a separate bind would follow: drained, joined, then replayed.
    return { sessionId, runtime: this._attachRuntime(sessionId, input.agentSessionId, clientId) }
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

  /** The sessions one client has open, for the rooms to republish when it comes or goes. */
  sessionsWatchedBy(clientId: string): string[] {
    const sessionIds: string[] = []
    for (const [sessionId, clients] of this.watches) if (clients.has(clientId)) sessionIds.push(sessionId)
    return sessionIds
  }

  /** The turn in flight, as the session room reports it: whose prompt, on which provider. */
  activeTurnFor(sessionId: string): SessionActiveTurn | null {
    const run = this.activeRunRequests.get(sessionId)
    return run ? activeTurnFor(run.actor, run.input.provider) : null
  }

  /**
   * What a session is doing, for the host roster: its name and task from the
   * index, its state from the live session. The index is keyed by the provider's
   * thread, so the lineage answers which thread is current; a session not yet
   * indexed has no name and rests.
   */
  async sessionActivityFor(sessionId: string): Promise<SessionActivity> {
    const providerSessionId = resolveSessionLineageById(sessionId)?.active.providerSessionId
      ?? this._agentSessionIdFor(sessionId)
      ?? sessionId
    const meta = getIndexedSession(providerSessionId)
    return {
      sessionId,
      title: meta?.customTitle || meta?.firstMessage?.replace(/\s+/g, ' ') || meta?.slug || null,
      taskId: await taskIdForSession(LOCAL_ORGANIZATION_ID, sessionId),
      state: sessionActivityStateOf(this.activeSessions.get(sessionId)?.status),
      activeTurn: this.activeTurnFor(sessionId),
    }
  }

  private _dropWatch(sessionId: string, clientId: string): void {
    const clients = this.watches.get(sessionId)
    if (!clients?.delete(clientId)) return
    this.emit('watchers-changed', sessionId)
    if (clients.size) return
    this.watches.delete(sessionId)
    // Keep pending text for clients that reconnect during this turn.
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
    return this._attachRuntime(sessionId, agentSessionId, clientId)
  }

  /** Join a watching client to a session's live runtime: replay the turn so far
   *  to that client alone and read the run config back. Null when nothing is
   *  running for the session any more. */
  private _attachRuntime(sessionId: string, agentSessionId: string, clientId: string): RuntimeSessionInfo | null {
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
    // Buffered delivery drains first. Paragraph delivery replays only published
    // blocks; its pending tail is sent once when complete.
    this._flushPendingSession(sessionId, true)
    const replayed = new Set<NormalizedEvent>()
    for (const event of this.turnLog.get(sessionId) ?? []) {
      replayed.add(event)
      this._emit(sessionId, event, { only: clientId })
    }

    // Pending input outlives the turn that raised it, so it is replayed on its own
    // — but the log holds the very same objects when the ask happened in this turn.
    // Send each one once or the client stacks duplicate permission cards.
    for (const event of session.pendingInputEvents) {
      if (replayed.has(event)) continue
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

    if (pendingRateLimitEvent && !replayed.has(pendingRateLimitEvent)) {
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
  async resetSession(ctx: IpcContext): Promise<void> {
    const sessionId = this._sessionIdForCtx(ctx)
    if (!sessionId) return
    const session = this.activeSessions.get(sessionId)
    log.info('session_reset', { sessionId, agentSessionId: session?.agentSessionId ?? null })
    this.rateLimits.clear(sessionId)
    const pendingHandoff = this._pendingHandoffFor(sessionId)
    if (pendingHandoff) {
      const restoredHandoff = cancelProvisionalSessionHandoff(sessionId)
      if (!restoredHandoff) await rekeyTaskSessionLinks(LOCAL_ORGANIZATION_ID, sessionId, pendingHandoff.fromSessionId)
    }
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
      // Handoff members must be grouped across providers before a batch reaches
      // the client. Streaming raw provider rows would briefly show duplicates.
      agentIds.map((agentId) => this._backendFor(agentId).listSessions(projectPath, undefined, limitPerProvider)),
    )
    const providerSessions = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    const sessions: SessionMeta[] = []
    const emittedSessions = new Set<string>()
    for (const meta of providerSessions) {
      const lineage = resolveSessionLineage(meta.provider, meta.sessionId)
      if (!lineage) {
        // Never registered — it has not run since registration existed. It stays
        // named by its provider thread until its next turn registers it.
        sessions.push(meta)
        continue
      }
      for (const member of lineage.members) {
        if (member.providerSessionId) this.agentSessionToSession.set(member.providerSessionId, lineage.sessionId)
      }
      if (emittedSessions.has(lineage.sessionId)) continue
      emittedSessions.add(lineage.sessionId)
      const active = lineage.active
      const activeMeta = active.providerSessionId
        ? providerSessions.find((candidate) => candidate.provider === active.provider && candidate.sessionId === active.providerSessionId)
          ?? getIndexedSession(active.providerSessionId)
        : null
      // A single-member lineage is just this row under its stable name, so keep the
      // indexed cwd — it tracks a retarget, while the lineage row records where the
      // provider thread began. Only a handoff needs the member's own cwd.
      const cwd = lineage.members.length > 1 ? active.cwd : (activeMeta ?? meta).cwd
      sessions.push(activeMeta
        ? { ...activeMeta, sessionId: lineage.sessionId, provider: active.provider, cwd }
        : { ...meta, sessionId: lineage.sessionId, provider: active.provider, cwd })
    }
    sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime())
    // A registered row is already named by its stable session id; an unregistered
    // one still carries the provider thread id. _sessionIdFor accepts either, so
    // live status lands on both.
    for (const meta of sessions) {
      const sessionId = this._sessionIdFor(meta.sessionId)
      if (!sessionId) continue
      if (this._currentRateLimitEvent(sessionId)) meta.status = 'rate_limited'
      else {
        const active = this.activeSessions.get(sessionId)
        if (active) meta.status = active.status
      }
    }
    onBatch?.(sessions)
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

  resolveSessionLineage(agentId: AgentId, providerSessionId: string): SessionLineageResolution | null {
    return resolveSessionLineage(agentId, providerSessionId)
      ?? resolveSessionLineageById(providerSessionId)
  }

  async loadSessionPage(request: SessionHistoryPageRequest): Promise<ProviderHistoryPage> {
    const { provider, sessionId, projectPath } = request
    const lineage = this.resolveSessionLineage(provider, sessionId)
    const segments: HistorySegment[] = lineage ? lineage.members.map((member, index) => {
      const previous = lineage.members[index - 1]
      return {
        provider: member.provider,
        sessionId: member.providerSessionId,
        projectPath: member.cwd || projectPath,
        divider: previous ? {
          messageId: `handoff:${lineage.sessionId}:${member.position}`,
          role: 'system',
          content: `Switched to ${AGENT_DISPLAY_NAMES.get(member.provider)}`,
          agentChangedTo: AGENT_DISPLAY_NAMES.get(member.provider),
          agentChangedFromProvider: previous.provider,
          agentChangedToProvider: member.provider,
          agentChangedFromModel: modelLabelFor(previous.provider, previous.providerSessionId
            ? getIndexedSession(previous.providerSessionId)?.model : undefined) ?? undefined,
          agentChangedToModel: modelLabelFor(member.provider, member.providerSessionId
            ? getIndexedSession(member.providerSessionId)?.model : undefined) ?? undefined,
          timestamp: member.startedAt,
        } : undefined,
      }
    }) : [{ provider, sessionId, projectPath }]
    return loadHistoryPage(
      JSON.stringify(lineage ? [lineage.sessionId] : [provider, sessionId]), segments,
      request.limit ?? 200, request.before,
      async (segment, limit, before) => {
        const backend = this._backendFor(segment.provider)
        if (!backend.loadSessionPage) throw new Error('This provider does not support history pages.')
        return backend.loadSessionPage(segment.sessionId!, segment.projectPath, limit, before)
      },
    )
  }

  async loadSession(agentId: AgentId, sessionId: string, projectPath?: string, limit?: number): Promise<SessionLoadMessage[]> {
    let handoff = resolveSessionLineage(agentId, sessionId) ?? resolveSessionLineageById(sessionId)
    if (!handoff) return this._backendFor(agentId).loadSession(sessionId, projectPath, limit)

    for (let attempt = 0; attempt < 2; attempt++) {
      const loaded: SessionLoadMessage[][] = []
      for (const member of handoff.members) {
        if (!member.providerSessionId) {
          loaded.push([])
          continue
        }
        try {
          loaded.push(await this._backendFor(member.provider).loadSession(
            member.providerSessionId,
            member.cwd || projectPath,
            limit,
          ))
        } catch (error) {
          log.warn('session_handoff_segment_load_failed', {
            sessionId: handoff.sessionId,
            provider: member.provider,
            agentSessionId: member.providerSessionId,
            error: error instanceof Error ? error.message : String(error),
          })
          loaded.push([{
            messageId: `handoff-unavailable:${handoff.sessionId}:${member.position}`,
            role: 'system',
            content: `${AGENT_DISPLAY_NAMES.get(member.provider)} transcript unavailable`,
            timestamp: member.startedAt,
          }])
        }
      }

      const latest = resolveSessionLineageById(handoff.sessionId)
      if (latest && latest.lineageToken !== handoff.lineageToken && attempt === 0) {
        handoff = latest
        continue
      }

      const composite: SessionLoadMessage[] = []
      for (let index = 0; index < handoff.members.length; index++) {
        const member = handoff.members[index]
        if (index > 0) {
          const previousMember = handoff.members[index - 1]
          const previousModelId = previousMember.providerSessionId
            ? getIndexedSession(previousMember.providerSessionId)?.model
            : undefined
          const targetModelId = member.providerSessionId
            ? getIndexedSession(member.providerSessionId)?.model
            : undefined
          composite.push({
            messageId: `handoff:${handoff.sessionId}:${member.position}`,
            role: 'system',
            content: `Switched to ${AGENT_DISPLAY_NAMES.get(member.provider)}`,
            agentChangedTo: AGENT_DISPLAY_NAMES.get(member.provider),
            agentChangedFromModel: modelLabelFor(previousMember.provider, previousModelId) ?? undefined,
            agentChangedToModel: modelLabelFor(member.provider, targetModelId) ?? undefined,
            agentChangedFromProvider: previousMember.provider,
            agentChangedToProvider: member.provider,
            timestamp: member.startedAt,
          })
        }
        composite.push(...loaded[index])
      }
      return limit && composite.length > limit ? composite.slice(-limit) : composite
    }
    return []
  }

  /** `knownAgentSessionId` is the client's view of the provider thread. A
   *  session only has a record here while a runtime is attached, so an idle
   *  conversation — one whose process exited, or one restored after a restart —
   *  has none, and the caller is the only holder of the thread to hand off. */
  async switchSessionProvider(sessionId: string, newProvider: AgentId, knownAgentSessionId?: string | null): Promise<SessionProviderSwitchResult> {
    const session = this.activeSessions.get(sessionId)

    const pendingHandoff = this._pendingHandoffFor(sessionId)
    if (pendingHandoff && newProvider === pendingHandoff.fromProvider) {
      const fromProvider = session?.backendId ?? newProvider
      const restoredHandoff = cancelProvisionalSessionHandoff(sessionId)
      this.pendingHandoffs.delete(sessionId)
      if (session) {
        session.backendId = newProvider
        session.agentSessionId = pendingHandoff.fromSessionId
      }
      this.agentSessionToSession.set(pendingHandoff.fromSessionId, sessionId)
      this._setStatus(sessionId, 'idle')
      const result: SessionProviderSwitchResult = {
        fromProvider,
        fromSessionId: pendingHandoff.fromSessionId,
        restoredSessionId: pendingHandoff.fromSessionId,
        taskSessionMove: {
          sourceSessionId: sessionId,
          targetSessionId: restoredHandoff?.sessionId ?? pendingHandoff.fromSessionId,
        },
        handoffFrom: session?.handoffFrom,
      }
      if (restoredHandoff) result.handoffId = restoredHandoff.sessionId
      return result
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
    const existingHandoff = resolveSessionLineageById(oldAgentSessionId)
    const handoff = beginSessionHandoff({
      sessionId,
      sourceProvider: fromProvider,
      sourceProviderSessionId: oldAgentSessionId,
      targetProvider: newProvider,
      cwd: session?.runInput?.workingDirectory ?? indexedSession?.cwd ?? '~',
    })
    this.pendingHandoffs.set(sessionId, { fromProvider, fromSessionId: oldAgentSessionId })
    // Clear both sidebar aliases before replacing the provider endpoint. The
    // ordinary attempt still uses the provider id until its task link reloads;
    // the handoff attempt uses the stable session id immediately after re-key.
    this.emit('session-status', {
      sessionId,
      agentSessionId: oldAgentSessionId,
      status: 'idle',
      at: Date.now(),
    })
    if (session) {
      this._setStatus(sessionId, 'idle')
      session.backendId = newProvider
      session.agentSessionId = null
    }

    return {
      fromProvider,
      fromSessionId: oldAgentSessionId,
      handoffId: handoff.sessionId,
      taskSessionMove: {
        sourceSessionId: existingHandoff?.sessionId ?? oldAgentSessionId,
        targetSessionId: handoff.sessionId,
      },
    }
  }

  /** Seam (b): the row comes from the on-disk session index, so it is named by
   *  the provider's thread id. */
  /** One read for opening a saved session: what the client used to ask for as
   *  a lineage lookup and then a metadata lookup on whichever member it named. */
  async describeSession(agentId: AgentId, providerSessionId: string): Promise<SessionDescription> {
    const lineage = this.resolveSessionLineage(agentId, providerSessionId)
    const active = lineage?.active
    // An active member with no transcript yet has no metadata to read; the
    // lineage alone carries what the client needs for it.
    if (active && !active.providerSessionId) return { lineage, meta: null }
    const meta = await this.getSessionInfo(active?.providerSessionId ?? providerSessionId)
    return { lineage, meta }
  }

  async getSessionInfo(agentSessionId: string): Promise<SessionMeta | null> {
    const handoff = resolveSessionLineageById(agentSessionId)
    const metadataMember = handoff?.active.providerSessionId
      ? handoff.active
      : handoff?.members.findLast((member) => !!member.providerSessionId)
    const indexedSessionId = metadataMember?.providerSessionId ?? agentSessionId
    const meta = getIndexedSession(indexedSessionId)
    if (!meta) return null
    if (handoff) {
      meta.sessionId = handoff.sessionId
      meta.provider = handoff.active.provider
      meta.cwd = handoff.active.cwd
    }
    const sessionId = handoff?.sessionId ?? this.agentSessionToSession.get(agentSessionId)
    const active = sessionId ? this.activeSessions.get(sessionId) : undefined
    if (active && sessionId) {
      meta.provider = active.backendId
      const runtimeAgentSessionId = active.agentSessionId ?? indexedSessionId
      const pendingRateLimit = this._currentRateLimitEvent(sessionId)
      meta.status = pendingRateLimit
        ? 'rate_limited'
        : active.status === 'completed'
          && this._backendFor(active.backendId).isSessionRunning(runtimeAgentSessionId)
          ? 'running'
          : active.status
      meta.currentTurnStartedAt = this._backendFor(active.backendId)
        .getSessionHandle(runtimeAgentSessionId)?.startedAt
      meta.lastTimestamp = new Date(active.lastActivityAt).toISOString()
    }
    return meta
  }

  /** True while the session is mid-turn or parked on input it still owes an answer to. */
  isSessionBusy(sessionId: string): boolean {
    const status = this.activeSessions.get(sessionId)?.status
    return status !== undefined && isSessionBusyStatus(status)
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

  /** A route for a reply to `targetAgentSessionId`, addressed to the calling
   *  session. Both ids arrive from the agent-tool surface and are normalized
   *  here once. The caller is live: it is the session making the call. */
  private _replyRoute(targetAgentSessionId: string, reply: AgentReplyRoute, targetSessionId?: string): AgentCompletionRoute {
    const { callerAgentSessionId, ...watch } = reply
    const callerSessionId = this._sessionIdFor(callerAgentSessionId)
    if (!callerSessionId) throw new Error(`Session ${callerAgentSessionId} is not live`)
    if (targetAgentSessionId === callerAgentSessionId || targetSessionId === callerSessionId) {
      throw new Error('Cannot watch your own session.')
    }
    return { ...watch, awaitingReported: false, callerSessionId, callerAgentSessionId, targetAgentSessionId }
  }

  /** Attach a route to the turn running now, for `wait_for_session`. Returns
   *  false when no turn is running, so the caller never waits on nothing. */
  watchSessionSettled(targetAgentSessionId: string, callerAgentSessionId: string, watch: AgentConversationWatchRequest): boolean {
    const targetSessionId = this._sessionIdFor(targetAgentSessionId)
    if (!targetSessionId) return false
    const run = this.activeRunRequests.get(targetSessionId)
    if (!run) return false
    const armed = this._replyRoute(targetAgentSessionId, { ...watch, callerAgentSessionId }, targetSessionId)
    const routes = run.completionRoutes ??= []
    routes.push(armed)
    log.info('agent_conversation_watch_armed', {
      targetSessionId,
      targetAgentSessionId,
      callerSessionId: armed.callerSessionId,
      callerAgentSessionId,
      messageId: watch.messageId,
      notifyModel: watch.notifyModel,
      watchCount: routes.length,
    })

    // Catch-up scoped to the new watch only — earlier watchers already heard
    // about the current pause.
    const status = this.liveSessionStatus(targetAgentSessionId)
    if (status === 'awaiting_input' || status === 'awaiting_plan') {
      this._fireAwaitingInputWatchers(targetSessionId, status, armed)
    }
    return true
  }

  private *_completionRouteRuns(): Iterable<SessionRunRequest> {
    const seen = new Set<SessionRunRequest>()
    for (const run of this.activeRunRequests.values()) {
      seen.add(run)
      yield run
    }
    for (const queue of this.requestQueue.values()) {
      for (const request of queue) {
        if (seen.has(request.run)) continue
        seen.add(request.run)
        yield request.run
      }
    }
  }

  /** The messages a session sent that this process still carries: every route
   *  on a run not yet settled, and every reply queued back to the sender. What
   *  is missing has finished or died with an earlier process. */
  sessionMessagesSentBy(senderId: string): SentSessionMessage[] {
    const senderSessionId = this._sessionIdFor(senderId)
    if (!senderSessionId) return []
    const sent: SentSessionMessage[] = []
    for (const run of this._completionRouteRuns()) {
      const isActive = this.activeRunRequests.get(run.sessionId) === run
      const parkedOn = isActive ? this._parkedQuestion(run.sessionId) : null
      for (const route of run.completionRoutes ?? []) {
        if (route.callerSessionId !== senderSessionId) continue
        const message: SentSessionMessage = {
          messageId: route.messageId,
          targetAgentSessionId: route.targetAgentSessionId,
          state: !isActive ? 'queued' : parkedOn ? 'awaiting_input' : 'running',
        }
        if (parkedOn) message.question = parkedOn
        sent.push(message)
      }
    }
    for (const queued of this.requestQueue.get(senderSessionId) ?? []) {
      const { via, agentSessionId, agentMessageId } = queued.run.options
      if (via !== 'session-report' || !agentSessionId || !agentMessageId) continue
      sent.push({ messageId: agentMessageId, targetAgentSessionId: agentSessionId, state: 'reply_queued' })
    }
    return sent
  }

  /** What a session's turn is parked on, if it is parked. */
  private _parkedQuestion(sessionId: string): AgentConversationQuestion | null {
    const session = this.activeSessions.get(sessionId)
    if (session?.status !== 'awaiting_input' && session?.status !== 'awaiting_plan') return null
    const parkedOn = agentConversationQuestionFromPendingInput(session.pendingInputEvents)
    if (!parkedOn) return null
    const question: AgentConversationQuestion = { kind: parkedOn.kind, text: parkedOn.questionText }
    if (parkedOn.questionId) question.questionId = parkedOn.questionId
    if (parkedOn.answerKey) question.answerKey = parkedOn.answerKey
    return question
  }

  private _awaitingAgentReply(callerSessionId: string): boolean {
    for (const run of this._completionRouteRuns()) {
      if (run.completionRoutes?.some((route) => route.callerSessionId === callerSessionId && route.notifyModel)) return true
    }
    return false
  }

  private _cancelPendingAgentReplies(callerSessionId: string): boolean {
    let cancelled = false
    for (const run of this._completionRouteRuns()) {
      const routes = run.completionRoutes
      if (!routes?.length) continue
      for (let index = routes.length - 1; index >= 0; index--) {
        const route = routes[index]
        if (route.callerSessionId !== callerSessionId) continue
        routes.splice(index, 1)
        cancelled = true
        this._emit(callerSessionId, {
          type: 'agent_conversation_update',
          update: {
            phase: 'settled',
            agentSessionId: route.targetAgentSessionId,
            messageId: route.messageId,
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
    const run = runKey === 'active'
      ? this.activeRunRequests.get(targetSessionId)
      : this.requestQueue.get(targetSessionId)?.find((request) => request.queueId === runKey)?.run
    const routes = run?.completionRoutes?.splice(0) ?? []
    for (const route of routes) {
      this._emit(route.callerSessionId, {
        type: 'agent_conversation_update',
        update: {
          phase: 'settled',
          agentSessionId: route.targetAgentSessionId,
          messageId: route.messageId,
          status: 'interrupted',
          replyText: '',
          settledAt: Date.now(),
        },
      })
    }
    return routes.length > 0
  }

  loadSessionPreview(agentId: AgentId, sessionId: string, projectPath?: string): Promise<SessionPreviewResult> {
    // Every session has a lineage now, so its mere existence says nothing. Only a
    // multi-member lineage needs the composite read; a single member is one
    // provider transcript and keeps the backend's cheap preview. This is the
    // session picker's hot path — reading full transcripts here would cost a
    // whole-list stall on every open.
    const lineage = resolveSessionLineage(agentId, sessionId) ?? resolveSessionLineageById(sessionId)
    if (lineage && lineage.members.length > 1) {
      return this.loadSession(agentId, sessionId, projectPath).then((allMsgs) => {
        const msgs = allMsgs.filter((message) => message.role !== 'reasoning')
        return {
          head: msgs.slice(0, 4),
          tail: msgs.slice(-1),
          totalMessages: msgs.length,
        }
      })
    }
    // A task link names the stable Solus session. A lineage of one is still
    // backed by a provider thread with a different id, so route the cheap read
    // to that endpoint instead of asking the provider for the Solus id. The old
    // session picker did not expose this because its history rows carried the
    // provider thread id directly.
    const member = lineage?.active.providerSessionId
      ? lineage.active
      : lineage?.members.findLast((candidate) => !!candidate.providerSessionId)
    const previewAgentId = member?.provider ?? agentId
    const previewSessionId = member?.providerSessionId ?? sessionId
    const previewProjectPath = member?.cwd || projectPath
    const backend = this._backendFor(previewAgentId)
    if (backend.loadSessionPreview) {
      return backend.loadSessionPreview(previewSessionId, previewProjectPath)
    }
    return backend.loadSession(previewSessionId, previewProjectPath).then((allMsgs) => {
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

  async listPluginCommands(agentId: AgentId, workingDirectory: string, ctx?: IpcContext): Promise<PluginCommandsResult> {
    const result = await this._backendFor(agentId).listPluginCommands(workingDirectory, ctx)
    const aliases = [
      { name: 'review', description: 'Review working-tree changes', kind: 'skill' as const },
      { name: 'review:working-tree', description: 'Review staged, unstaged, and untracked changes', kind: 'skill' as const },
      { name: 'review:session', description: 'Review this session\'s changes', kind: 'skill' as const },
      { name: 'review:branch', description: 'Review the current branch', kind: 'skill' as const },
      { name: 'review:pr', description: 'Review a pull request', argumentHint: 'PR URL', kind: 'skill' as const },
    ]
    const listed: PluginCommandsResult = {
      global: [...aliases, ...result.global.filter((command) => !isRawReviewSkill(command))],
      project: result.project.filter((command) => !isRawReviewSkill(command)),
    }
    if (result.builtin) listed.builtin = result.builtin.filter((command) => !isRawReviewSkill(command))
    return listed
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

  /** Null when the provider exposes no quota, or its report didn't parse. With a seat, that member's quota. */
  readUsageLimits(agentId: AgentId, seat?: TurnSeat): Promise<AgentUsageLimits | null> {
    const backend = this._backendFor(agentId)
    return backend.readUsageLimits?.(seat) ?? Promise.resolve(null)
  }

  /**
   * Provider seats (Step 2 plan §3.3). Every turn with an actor resolves its seat
   * before anything is spawned; the host's own work runs on the host's login.
   */
  useSeats(seats: SeatStore): void {
    this.seats = seats
  }

  /**
   * The seat a turn runs under, or null for the host's login. Throws
   * `SeatRequiredError` when the author has none. Asynchronous because a runner
   * in an organization leases a member's credential from the vault (§5).
   */
  async seatForTurn(actor: TurnActor | undefined, provider: AgentId): Promise<TurnSeat | null> {
    if (!this.seats || !actor) return null
    return this.seats.resolveForTurn(actor.seatUserId, provider)
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
   * An expired client — gone long enough that the transport gave up on recovering
   * its stream — drops its watches and nothing else. It does not end the sessions
   * it was watching and — deliberately — does not resolve their attention: a
   * session awaiting input still needs you when your laptop is shut, which is
   * exactly what the offline push notification assumes.
   *
   * Deliberately not called on a bare disconnect. A phone that backgrounds for a
   * second reconnects with its stream recovered and never re-watches, so dropping
   * on the first blip would leave it silently deaf to a session it still has open.
   * Watch lifetime tracks event-delivery lifetime.
   */
  handleClientExpired(clientId: string): void {
    for (const sessionId of Array.from(this.watches.keys())) {
      this._dropWatch(sessionId, clientId)
    }
  }

  /** The only execution entry point. Every caller supplies an explicit target
   * and receives the same lifecycle whether the input starts, steers, or queues. */
  private updatePending = false
  private updateWorkCount = 0

  setUpdatePending(pending: boolean): void { this.updatePending = pending }
  hasWorkForUpdate(): boolean { return this.updateWorkCount > 0 || this.activeAgentRuns.size > 0 || this.pendingSetupControllers.size > 0 || this.requestQueue.size > 0 }

  assertNewWorkAllowed(): void {
    if (this.updatePending) throw new Error('This host is waiting to update Solus. Cancel the update to start new work.')
  }

  async runTurn(request: SessionRunRequest, deviceId?: string): Promise<SessionRunLifecycle> {
    // Existing automation runs and agent follow-ups drain with their parent
    // work. User submissions and new automation triggers are gated separately.
    if (request.options.promptSource !== 'automation' && !(request.options.promptSource === 'agent' && this.hasWorkForUpdate())) this.assertNewWorkAllowed()
    // Count before the first await: a concurrent update must see setup and
    // accepted queued work, not just an already-running provider process.
    this.updateWorkCount++
    try {
      const lifecycle = await this._acceptTurn(request, deviceId)
      void lifecycle.done.finally(() => { this.updateWorkCount-- }).catch(() => {})
      return lifecycle
    } catch (error) {
      this.updateWorkCount--
      throw error
    }
  }

  private async _acceptTurn(request: SessionRunRequest, deviceId?: string): Promise<SessionRunLifecycle> {
    if (request.target.kind === 'session') {
      const sessionId = request.target.sessionId
      const session = this.activeSessions.get(sessionId)
      if (session) {
        const pendingRateLimit = this._currentRateLimitEvent(sessionId)
        if (
          pendingRateLimit?.type === 'rate_limit' &&
          // A limit kept past its window is only holding the card's question
          // open. Nothing would drain a prompt queued behind it, so a prompt
          // typed after the window reopened runs.
          isWindowClosed(pendingRateLimit) &&
          (request.input.rateLimitBehavior === 'ask' || request.input.rateLimitBehavior === 'queue')
        ) {
          return this._enqueueRequest(request, {
            sessionId,
            reason: 'rate_limit',
            deviceId,
            rateLimitSessionId: sessionId,
            releaseAt: pendingRateLimit.resetsAt ?? undefined,
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
              // Legacy senders withheld their bubble for a steer verdict but
              // cannot match the normal confirmation without a prompt id.
              if (request.sourceClientId && wasRunningAtDispatch && !request.options.clientPromptId) {
                this._emit(sessionId, this._userMessageEvent(request.options, undefined, request.actor), { only: request.sourceClientId })
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
        // The turn is over, so a queued delivery has nothing to wait behind:
        // any prompt goes into the query that the background work keeps open.
        if (session.status === 'background' && session.agentSessionId) {
          const steered = await this._steerActiveTurn(request, session.agentSessionId, session)
          if (steered) return steered
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
    actor?: TurnActor,
  ): NormalizedEvent {
    const event: Extract<NormalizedEvent, { type: 'user_message' }> = {
      type: 'user_message',
      text: options.displayPrompt ?? options.prompt,
    }
    if (delivery) event.delivery = delivery
    // Every client labels the bubble with its author; the host's own work
    // (automations, follow-ups) carries no name, and neither does a history reload.
    const author = turnAuthorOf(actor)
    if (author) event.author = author
    if (options.clientPromptId) event.clientPromptId = options.clientPromptId
    // Refs win: they name bytes the host already holds, so the echo every client
    // receives stays small. Inline images are only what an older client sent.
    if (options.imageAttachmentRefs?.length) event.imageAttachmentRefs = options.imageAttachmentRefs
    if (options.imageAttachments?.length) event.imageAttachments = options.imageAttachments
    if (options.via) {
      event.via = options.via
      event.automationId = options.automationId
      event.automationName = options.automationName
    }
    if (options.agentSessionId) {
      event.agentSessionId = options.agentSessionId
      event.agentMessageId = options.agentMessageId
    }
    return event
  }

  private async _steerActiveTurn(
    request: SessionRunRequest,
    agentSessionId: string,
    session: BackendSession,
  ): Promise<SessionRunLifecycle | null> {
    const backend = this._backendFor(session.backendId)
    const handle = await backend.steerSession(agentSessionId, {
      prompt: request.options.prompt,
      imageAttachments: await resolvePromptImages(request.options),
    })
    if (!handle) return null
    // A steer is answered by the turn that accepted it. Its routes join that
    // turn now, in the same microtask the acceptance resolved in, before any
    // event of that turn's end can be handled, so they settle with it and hear
    // its questions.
    const steeredRoutes = request.completionRoutes?.splice(0) ?? []
    if (steeredRoutes.length) {
      const activeRun = this.activeRunRequests.get(request.sessionId)
      if (activeRun) (activeRun.completionRoutes ??= []).push(...steeredRoutes)
      else {
        // A backgrounded turn has already released its run record.
        request.completionRoutes = steeredRoutes
        void handle.runPromise.then(
          () => this._settleCompletionRoutes(request, handle.abortController.signal.aborted ? 'interrupted' : 'completed', handle.resultText),
          () => this._settleCompletionRoutes(request, handle.abortController.signal.aborted ? 'interrupted' : 'failed', handle.resultText),
        )
      }
    }

    session.promptCount = (session.promptCount ?? 0) + 1
    session.lastActivityAt = Date.now()
    const userMessage = this._userMessageEvent(request.options, 'steer', request.actor)
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
    origin?: { clientId?: string; deviceId?: string; actor?: TurnActor },
  ): Promise<PromptDispatchResult> {
    this.assertNewWorkAllowed()
    const proposedSessionId = ctx.session.sessionId
    if (!proposedSessionId) {
      throw new Error('No sessionId provided — rejecting to prevent misrouting')
    }
    // No seat, no turn: refused here, before the prompt is echoed or queued, so the
    // client can show the connect card instead of a bubble that never answers.
    const provider = ctx.session.provider ?? resolveSessionLineageById(proposedSessionId)?.active.provider
    if (provider && ctx.session.preferredModel !== AUTO_MODEL_ID) await this.seatForTurn(origin?.actor, provider)
    if (options.clientPromptId) {
      const dedupeKey = `${proposedSessionId}:${options.clientPromptId}`
      if (this.acceptedClientPromptIds.has(dedupeKey)) {
        log.info('prompt_deduplicated', { sessionId: proposedSessionId, clientPromptId: options.clientPromptId })
        return { disposition: 'duplicate' }
      }
      this.acceptedClientPromptIds.add(dedupeKey)
      if (this.acceptedClientPromptIds.size > 512) {
        const oldest = this.acceptedClientPromptIds.values().next().value
        if (oldest !== undefined) this.acceptedClientPromptIds.delete(oldest)
      }
    }
    const input = runInputFromContext(ctx)
    const currentLineage = resolveSessionLineageById(proposedSessionId)?.active
    if (!input.forked && !input.agentSessionId && currentLineage?.providerSessionId) {
      input.agentSessionId = currentLineage.providerSessionId
      input.provider = currentLineage.provider
    }
    const agentSessionId = this.activeSessions.get(proposedSessionId)?.agentSessionId ?? input.agentSessionId
    // Route by the registered id, never the caller's. A client that resumed this
    // thread from disk without adopting our answer still proposes its own name;
    // obeying it re-points the binding and splits one conversation into two
    // addresses, so each client then sees only the turns it started. A fork is
    // exempt: it carries the source thread's id but is deliberately a new session.
    const sessionId = (!input.forked && agentSessionId ? this._sessionIdFor(agentSessionId) : undefined)
      ?? proposedSessionId
    if (agentSessionId && !input.forked) this.agentSessionToSession.set(agentSessionId, sessionId)
    const target: DispatchTarget = !input.forked && agentSessionId
      ? { kind: 'session', sessionId }
      : { kind: 'new-session' }
    const lifecycle = await this.runTurn({
      input,
      target,
      sessionId,
      sourceClientId: origin?.clientId,
      actor: origin?.actor,
      options: {
        ...options,
        promptSource: ctx.session.origin === 'dispatch' ? 'dispatch' : 'typed',
      },
      tools: selectAgentTools(
        solusToolbox.works,
        solusToolbox.docs,
        solusToolbox.artifact,
        solusToolbox.automations,
        solusToolbox.connections,
        solusToolbox.insights,
        solusToolbox.intelligence,
        solusToolbox.browser,
        solusToolbox.sessions,
        solusToolbox.tasks,
        solusToolbox.config,
      ),
    }, origin?.deviceId)
    await lifecycle.agentSessionId
    const dispatch: PromptDispatchResult = {
      disposition: lifecycle.disposition,
    }
    if (lifecycle.queueId) dispatch.queueId = lifecycle.queueId
    return dispatch
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
    displayPrompt?: string
    automationId: string
    automationName: string
    fallback?: { provider: AgentId; model: string | null; reasoningEffort: ReasoningEffort; cwd: string }
  }): Promise<void> {
    const { prompt, automationId, automationName, fallback } = opts
    const requestedMeta = getIndexedSession(opts.agentSessionId)
    const handoff = requestedMeta
      ? resolveSessionLineage(requestedMeta.provider, opts.agentSessionId)
      : null
    const agentSessionId = handoff?.active.providerSessionId ?? opts.agentSessionId
    const activeProvider = handoff?.active.provider ?? fallback?.provider
    const activeCwd = handoff?.active.cwd ?? fallback?.cwd
    // Automations name their target by the provider thread they were attached
    // to; a cold one has no live session, so it gets an id when it starts.
    const sessionId = handoff?.sessionId ?? this.agentSessionToSession.get(agentSessionId) ?? crypto.randomUUID()
    const resident = this.activeSessions.get(sessionId)?.runInput
    const input: SessionRunInput | undefined = resident
      ? { ...resident, agentSessionId, forked: false }
      : fallback && activeProvider && activeCwd
        ? {
            provider: activeProvider,
            agentSessionId,
            forked: false,
            workingDirectory: activeCwd,
            projectPath: activeCwd,
            additionalDirs: [],
            gitContext: null,
            worktreeBaseBranch: null,
            sessionChangedFiles: [],
            reasoningEffort: fallback.reasoningEffort,
            fastMode: false,
            permissionMode: 'auto',
            rateLimitBehavior: 'queue',
            ...hostModelInputFor(activeProvider, fallback.model),
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
        solusToolbox.docs,
        solusToolbox.artifact,
        solusToolbox.automations,
        solusToolbox.connections,
        solusToolbox.insights,
        solusToolbox.intelligence,
        solusToolbox.browser,
        solusToolbox.sessions,
        solusToolbox.tasks,
        solusToolbox.config,
      ),
      options: {
        prompt,
        promptSource: 'automation',
        displayPrompt: opts.displayPrompt ?? prompt,
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
    origin?: Pick<PromptOptions, 'via' | 'agentSessionId' | 'agentMessageId'> & {
      /** Replaces the session's stored run mode for this prompt and every later
       *  one. A peer that just planned is still in 'plan' mode: prompting it as
       *  is makes Claude plan again and makes Codex refuse to touch anything, so
       *  approving a plan by prompt has to take it out of plan mode. */
      permissionMode?: SessionRunInput['permissionMode']
      /** The person behind an agent-card prompt; an agent's own follow-up has none. */
      actor?: TurnActor
      /** Where this prompt's reply goes. It is on the run before the run is
       *  accepted, so a reply that comes back at once is never lost. */
      reply?: AgentReplyRoute
    },
  ): Promise<{ disposition: SessionRunLifecycle['disposition']; queueId?: string }> {
    const { permissionMode, actor, reply, ...promptOrigin } = origin ?? {}
    // The id the caller named is the one its card shows; settle updates use it.
    const requestedAgentSessionId = agentSessionId
    const requestedMeta = getIndexedSession(agentSessionId)
    const handoff = resolveSessionLineageById(agentSessionId) ?? (requestedMeta
      ? resolveSessionLineage(requestedMeta.provider, agentSessionId)
      : null)
    agentSessionId = handoff?.active.providerSessionId ?? agentSessionId
    // Tools can name either the stable Solus session or a provider thread.
    // Keep the stable target for dispatch and pass only its thread to the backend.
    const sessionId = handoff?.sessionId ?? this.agentSessionToSession.get(agentSessionId) ?? crypto.randomUUID()
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
        provider: handoff?.active.provider ?? meta.provider,
        agentSessionId,
        forked: false,
        workingDirectory: handoff?.active.cwd ?? meta.cwd,
        projectPath: handoff?.active.cwd ?? meta.cwd,
        additionalDirs: [],
        gitContext: null,
        worktreeBaseBranch: null,
        sessionChangedFiles: [],
        contextWindow: defaultContextWindowFor(handoff?.active.provider ?? meta.provider, meta.model),
        model: meta.model,
        preferredModel: meta.model,
        reasoningEffort: meta.reasoningEffort,
        fastMode: false,
        // A turn settles and its run record — with the mode it started in — is
        // dropped, so every later agent-driven prompt rebuilds the input from
        // scratch. This surface is peers prompting peers and session reports:
        // nobody is at the keyboard of the session being prompted, and 'ask'
        // parked a session an agent created in auto on permission prompts it
        // never asked for. Matches the automation resume path above.
        permissionMode: 'auto',
        rateLimitBehavior: 'queue',
        ...hostInstructionsFor(meta.model),
      }
    }
    if (permissionMode) input.permissionMode = permissionMode
    await this.seatForTurn(actor, input.provider)
    const route = reply ? this._replyRoute(requestedAgentSessionId, reply, sessionId) : undefined
    // The sender's card shows the message before anything can answer it, from
    // every surface that sends one: agent tools, cards, and plan rulings.
    if (route) {
      this._emit(route.callerSessionId, {
        type: 'agent_conversation_update',
        update: {
          phase: 'dispatched',
          agentSessionId: route.targetAgentSessionId,
          messageId: route.messageId,
          origin: 'prompted',
          prompt,
          delivery,
          provider: input.provider,
          title: requestedMeta?.slug || requestedMeta?.firstMessage?.replace(/\s+/g, ' ').trim().slice(0, 80) || requestedAgentSessionId.slice(0, 8),
          cwd: input.workingDirectory,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          dispatchedAt: route.dispatchedAt,
        },
      })
    }

    let lifecycle: SessionRunLifecycle
    try {
      lifecycle = await this.runTurn({
        input,
        target: { kind: 'session', sessionId },
        sessionId,
        actor,
        completionRoutes: route ? [route] : undefined,
        tools: selectAgentTools(
          solusToolbox.works,
          solusToolbox.docs,
          solusToolbox.artifact,
          solusToolbox.automations,
          solusToolbox.connections,
          solusToolbox.insights,
          solusToolbox.intelligence,
          solusToolbox.browser,
          solusToolbox.sessions,
          solusToolbox.tasks,
          solusToolbox.config,
        ),
        options: { prompt, displayPrompt: prompt, delivery, promptSource: 'agent', ...promptOrigin },
      })
    } catch (error) {
      // Never accepted, so no turn will ever settle this message.
      if (route) {
        this._emit(route.callerSessionId, {
          type: 'agent_conversation_update',
          update: { phase: 'settled', agentSessionId: route.targetAgentSessionId, messageId: route.messageId, status: 'failed', replyText: '', settledAt: Date.now() },
        })
      }
      throw error
    }
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
    this.failedSetupPrompts.delete(sessionId)

    // Worktree creation happens before a backend RunHandle exists. Cancel it
    // first or Stop would report failure while setup continued into a new run.
    const setupController = this.pendingSetupControllers.get(sessionId)
    if (setupController) {
      setupController.abort(new Error('Interrupted'))
      this.pendingSetupControllers.delete(sessionId)
      this.sessionEmitter.recordTerminal(sessionId, 'interrupted')
      this._setStatus(sessionId, 'interrupted')
      return true
    }

    const session = this.activeSessions.get(sessionId)
    // 'background' is the way out of a task that never settles: cancelling the
    // query is what ends the work the agent left running.
    if (session?.agentSessionId && (isSessionBusyStatus(session.status) || session.status === 'background')) {
      const cancelled = this._backendFor(session.backendId).cancelSession(session.agentSessionId)
      if (cancelled) {
        this.sessionEmitter.recordTerminal(sessionId, 'interrupted')
        this._setStatus(sessionId, 'interrupted')
      }
      return cancelled
    }

    // Fall back to pre-session_init handles owned by any backend.
    for (const backend of this.backends.values()) {
      const handle = backend.getPendingHandles().find((h) => h.sessionId === sessionId)
      if (!handle) continue
      handle.abortController.abort()
      this.sessionEmitter.recordTerminal(sessionId, 'interrupted')
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
  async createSession(req: CreateSessionRequest, actor?: TurnActor): Promise<{ agentSessionId: string; taskId?: string }> {
    // No seat, no session: refused before anything is spawned (Step 2 plan §3.3).
    await this.seatForTurn(actor, req.provider)
    const model = req.modelId ?? ''
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
      model,
      preferredModel: req.modelId,
      reasoningEffort: req.reasoningEffort,
      fastMode: false,
      permissionMode: 'auto',
      rateLimitBehavior: 'queue',
      ...hostInstructionsFor(model),
    }
    const sessionId = crypto.randomUUID()
    // The child has no thread yet. Its card knows it as `pending:<exchange>`
    // until `attached`; session_init binds the route to the real thread.
    const completionRoutes = req.reply
      ? [this._replyRoute(`pending:${req.reply.messageId}`, req.reply, sessionId)]
      : undefined
    const delegation = req.delegation
      ? {
          // The index keys sessions by provider thread; so does the parent link.
          parentSessionId: req.delegation.parentAgentSessionId,
          messageId: req.reply?.messageId ?? crypto.randomUUID(),
          intent: req.delegation.intent,
          createdAt: req.reply?.dispatchedAt ?? Date.now(),
        }
      : undefined
    const lifecycle = await this.runTurn({
      input,
      target: { kind: 'new-session' },
      sessionId,
      actor,
      completionRoutes,
      delegation,
      tools: selectAgentTools(
        solusToolbox.works,
        solusToolbox.docs,
        solusToolbox.artifact,
        solusToolbox.automations,
        solusToolbox.connections,
        solusToolbox.insights,
        solusToolbox.intelligence,
        solusToolbox.browser,
        solusToolbox.sessions,
        solusToolbox.tasks,
        solusToolbox.config,
      ),
      options: buildCreatedSessionPromptOptions(req),
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
      reasoningEffort: req.reasoningEffort,
      fastMode: false,
      permissionMode: 'auto',
      rateLimitBehavior: 'queue',
      ...hostModelInputFor(req.provider, req.modelId),
    }
    const lifecycle = await this.runTurn({
      input,
      target: { kind: 'new-session' },
      sessionId: crypto.randomUUID(),
      tools: selectAgentTools(
        solusToolbox.works,
        solusToolbox.docs,
        solusToolbox.artifact,
        solusToolbox.connections,
        solusToolbox.insights,
        solusToolbox.intelligence,
        solusToolbox.browser,
        solusToolbox.sessions,
        solusToolbox.tasks,
        solusToolbox.config,
      ),
      options: {
        prompt: req.prompt,
        promptSource: 'automation',
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
    // Every prepared/initialized view of a run shares this one route array. The
    // request is copied while setup resolves, but completion ownership must not be.
    request.completionRoutes ??= []
    const runStartedAt = Date.now()
    const promptSource = request.options.promptSource ?? 'typed'
    // Read before dispatch: Auto routing overwrites the model with the one it
    // picked, and the turn must still say what was asked for. `model`, not
    // `preferredModel`: the preference is the session's stored choice, which
    // outlives a switch of provider, while `model` is the choice resolved
    // against the provider this turn runs on.
    const requestedModel = request.input.model || undefined
    const turnTraceId = this.sessionEmitter.beginTurn({
      sessionId: request.sessionId,
      prompt: request.options.displayPrompt ?? request.options.prompt,
      promptSource,
      startedAt: runStartedAt,
      dispatchedAt: request.servedEnqueuedAt ?? runStartedAt,
      // The backend and project a dispatch step runs for are settled before the
      // dispatch starts; the executed model is not, and arrives with the setup
      // the provider answers into.
      provider: request.input.provider,
      projectRoot: request.input.projectPath || request.input.workingDirectory,
    })
    let startedRun: StartedRun
    try {
      startedRun = await this.sessionEmitter.runDispatch(
        request.sessionId,
        'launch_run',
        { promptSource, fn: '_launchRun', file: 'control-plane.ts' },
        () => this._launchRun(request),
      )
    } catch (error) {
      const interrupted = error instanceof Error && error.message === 'Interrupted'
      this.sessionEmitter.finishTurn(request.sessionId, interrupted ? 'interrupted' : 'failed', Date.now(), turnTraceId)
      throw error
    }
    const { handle, run } = startedRun
    // Its own scope: this runs after `launch_run` resolved, so there is no
    // ambient step left to nest under — but it is still inside the setup
    // window, being awaited before setup is closed below.
    const turnTask = await this.sessionEmitter.runDispatch(
      request.sessionId,
      'task_dimension',
      { taskId: run.options.taskId ?? '', fn: '_turnTask', file: 'control-plane.ts' },
      async (annotate) => {
        const task = await this._turnTask(run)
        annotate({ taskId: task?.id ?? '', title: task?.title ?? '' })
        return task
      },
    )
    this.sessionEmitter.completeSetup(request.sessionId, {
      provider: run.input.provider,
      model: run.input.model,
      contextWindow: run.input.contextWindow,
      requestedModel,
      projectRoot: run.input.projectPath || run.input.workingDirectory,
      origin: promptSource,
      reasoningEffort: run.input.reasoningEffort,
      taskId: turnTask?.id,
      automationId: run.options.automationId,
      automationName: run.options.automationName,
      taskTitle: turnTask?.title,
      branch: run.input.gitContext?.branch ?? undefined,
      isResume: !!run.input.agentSessionId,
    })
    if (request.servedEnqueuedAt !== undefined) {
      this.sessionEmitter.recordQueueWait(request.sessionId, request.servedEnqueuedAt, runStartedAt)
    }
    if (handle.agentSessionId && (!run.input.agentSessionId || run.input.forked) && run.options.taskId) {
      await this._linkPreparedTask(run, request.sessionId)
    }
    const agentSessionId = handle.agentSessionId
      ? Promise.resolve(startedSession(handle.agentSessionId, run.options.taskId))
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
        const fallback = handle.abortController.signal.aborted ? 'interrupted' as const : 'completed' as const
        const status = this.sessionEmitter.finishTurn(settledSessionId, fallback, Date.now(), turnTraceId)
        captureSettledRun(status)
        void this._settleCompletionRoutes(request, status, handle.resultText, {
          durationMs: Date.now() - runStartedAt,
          toolCallCount: handle.toolCallCount,
        })
        return handle.resultText ? { output: handle.resultText } : {}
      },
      (error) => {
        const fallback = handle.abortController.signal.aborted ? 'interrupted' as const : 'failed' as const
        const status = this.sessionEmitter.finishTurn(settledSessionId, fallback, Date.now(), turnTraceId)
        captureSettledRun(status)
        // A provider limit rejects this attempt, but the prompt is still owned
        // by Solus while it waits for a reset or a user decision. Do not tell a
        // caller that its peer failed; the watch is moved to the parked queue
        // entry below, or remains armed until the user chooses what to do.
        const pendingRateLimit = this._currentRateLimitEvent(settledSessionId)
        const isParkedRateLimit = pendingRateLimit
          && (request.input.rateLimitBehavior === 'ask' || request.input.rateLimitBehavior === 'queue')
        if (!isParkedRateLimit) {
          void this._settleCompletionRoutes(request, status, handle.resultText, {
            durationMs: Date.now() - runStartedAt,
            toolCallCount: handle.toolCallCount,
          })
        }
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

  /**
   * Children whose turn the previous process never settled. A parent that
   * delegated to one would otherwise wait for a reply nothing will send, so it
   * gets a report instead. The same boot marks each record interrupted, so a
   * child is reported once.
   */
  reportChildrenInterruptedByRestart(childThreadIds: readonly string[]): void {
    for (const childThreadId of childThreadIds) {
      const delegation = getIndexedSession(childThreadId)?.delegation
      if (delegation?.intent !== 'delegate') continue
      log.info('session_child_interrupted_by_restart', { agentSessionId: childThreadId, parentAgentSessionId: delegation.parentSessionId })
      // No message id: the report resolves whichever message to the child is
      // still open in the parent, which a restart cannot know.
      this._dispatchSessionReport(
        delegation.parentSessionId,
        buildSessionSettledReport(childThreadId, 'interrupted', CHILD_INTERRUPTED_BY_RESTART),
        { agentSessionId: childThreadId, messageId: delegation.messageId },
      )
    }
  }

  private _dispatchSessionReport(callerAgentSessionId: string, prompt: string, agent: { agentSessionId: string; messageId: string }): void {
    // Keep the update drain open until this report has started or queued.
    this.updateWorkCount++
    // promptSession addresses its target the way the agent-tool surface does.
    log.info('session_report_dispatch_started', {
      callerAgentSessionId,
      targetAgentSessionId: agent.agentSessionId,
      messageId: agent.messageId,
    })
    void this.promptSession(callerAgentSessionId, prompt, 'queue', {
      via: 'session-report',
      agentSessionId: agent.agentSessionId,
      agentMessageId: agent.messageId,
    }).then((result) => {
      log.info('session_report_dispatched', {
        callerAgentSessionId,
        targetAgentSessionId: agent.agentSessionId,
        messageId: agent.messageId,
        disposition: result.disposition,
        queueId: result.queueId,
      })
    }).catch((error) => {
      log.warn('session_report_failed', {
        callerAgentSessionId,
        targetAgentSessionId: agent.agentSessionId,
        messageId: agent.messageId,
        error: String(error),
      })
    }).finally(() => { this.updateWorkCount-- })
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
    only?: AgentCompletionRoute,
  ): void {
    const session = this.activeSessions.get(targetSessionId)
    if (!session?.agentSessionId) return
    const routes = only
      ? [only]
      : this.activeRunRequests.get(targetSessionId)?.completionRoutes ?? []
    if (!routes.length) return
    const question = agentConversationQuestionFromPendingInput(session.pendingInputEvents)
    const pendingInput = formatPendingInputReport(session.pendingInputEvents)
    const oldestByCaller = new Map<string, AgentCompletionRoute>()
    for (const route of routes) {
      if (!oldestByCaller.has(route.callerSessionId)) oldestByCaller.set(route.callerSessionId, route)
    }
    for (const route of oldestByCaller.values()) {
      if (question) {
        this._emit(route.callerSessionId, {
          type: 'agent_conversation_update',
          update: { phase: 'awaiting_input', agentSessionId: route.targetAgentSessionId, messageId: route.messageId, ...question },
        })
      }
      if (pendingInput && route.notifyModel && !route.awaitingReported) {
        route.awaitingReported = true
        this._dispatchSessionReport(
          route.callerAgentSessionId,
          buildSessionAwaitingInputReport(route.targetAgentSessionId, status, pendingInput, route.messageId),
          { agentSessionId: route.targetAgentSessionId, messageId: route.messageId },
        )
      }
    }
  }

  /** Someone answered the question or plan a session's turn is parked on — a
   *  caller's agent tool, a card, or a person in the session itself. Every caller
   *  waiting on that turn hears it against the message it sent, the same one
   *  `_fireAwaitingInputWatchers` raised the question on. */
  private _announceAnswered(sessionId: string | undefined, answerText: string): void {
    if (!sessionId) return
    const oldestByCaller = new Map<string, AgentCompletionRoute>()
    for (const route of this.activeRunRequests.get(sessionId)?.completionRoutes ?? []) {
      if (!oldestByCaller.has(route.callerSessionId)) oldestByCaller.set(route.callerSessionId, route)
    }
    for (const route of oldestByCaller.values()) {
      this._emit(route.callerSessionId, {
        type: 'agent_conversation_update',
        update: { phase: 'answered', agentSessionId: route.targetAgentSessionId, messageId: route.messageId, answerText },
      })
    }
  }

  private _settleCompletionRoutes(
    run: SessionRunRequest,
    status: 'completed' | 'interrupted' | 'failed',
    resultText: string | undefined,
    runMeta?: { durationMs?: number; toolCallCount?: number },
  ): Promise<void> {
    // Reading a finished agent's transcript can outlive its provider process.
    // An update must wait until the resulting report has been delivered too.
    this.updateWorkCount++
    return this._deliverCompletionRoutes(run, status, resultText, runMeta)
      .finally(() => { this.updateWorkCount-- })
  }

  private async _deliverCompletionRoutes(
    run: SessionRunRequest,
    status: 'completed' | 'interrupted' | 'failed',
    resultText: string | undefined,
    runMeta?: { durationMs?: number; toolCallCount?: number },
  ): Promise<void> {
    const routes = run.completionRoutes?.splice(0) ?? []
    if (!routes.length) {
      log.debug('agent_conversation_watch_settle_no_callers', {
        targetSessionId: run.sessionId,
        status,
      })
      return
    }

    log.info('agent_conversation_watch_settle_started', {
      targetSessionId: run.sessionId,
      status,
      callerCount: new Set(routes.map((route) => route.callerSessionId)).size,
      watchCount: routes.length,
    })

    const targetAgentSessionId = routes[0].targetAgentSessionId

    log.info('agent_conversation_watch_settle_resolved', {
      targetSessionId: run.sessionId,
      targetAgentSessionId,
      status,
      resolvedCount: routes.length,
      notifyModelCount: routes.filter((route) => route.notifyModel).length,
    })

    let finalText = resultText?.trim()
    if (!finalText) {
      const messages = await this.loadSession(
        run.input.provider,
        targetAgentSessionId,
        projectScopeOf(run.input),
      ).catch(() => [])
      finalText = [...messages].reverse().find(
        (message) => message.role === 'assistant' && !message.parentToolUseId && message.content,
      )?.content?.trim()
    }

    const settledAt = Date.now()
    for (const route of routes) {
      this._emit(route.callerSessionId, {
        type: 'agent_conversation_update',
        update: {
          phase: 'settled',
          agentSessionId: route.targetAgentSessionId,
          messageId: route.messageId,
          status,
          replyText: finalText ?? '',
          durationMs: runMeta?.durationMs,
          toolCallCount: runMeta?.toolCallCount,
          settledAt,
        },
      })
      if (route.notifyModel) {
        this._dispatchSessionReport(
          route.callerAgentSessionId,
          buildSessionSettledReport(route.targetAgentSessionId, status, finalText || '(no final assistant reply available)', route.messageId),
          { agentSessionId: route.targetAgentSessionId, messageId: route.messageId },
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
      if (session.status === 'connecting' || session.status === 'running' || session.status === 'background') return true
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
    const queuedEvent: Extract<NormalizedEvent, { type: 'prompt_queued' }> = {
      type: 'prompt_queued',
      text: prompt,
      queueId,
      enqueuedAt,
      reason: metadata.reason,
      releaseAt: metadata.releaseAt,
      rateLimitType: metadata.rateLimitType,
      images: options.imageAttachments,
      imageRefs: options.imageAttachmentRefs,
      clientPromptId: options.clientPromptId,
    }
    if (options.via) queuedEvent.via = options.via
    // A held prompt names its author like a sent one: the queue is read by
    // everyone in the room, and a drained turn runs under this person's seat.
    const author = turnAuthorOf(run.actor)
    if (author) queuedEvent.author = author
    this._emit(queueKey, queuedEvent)

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
    this.failedSetupPrompts.delete(sessionId)
    if (input.preferredModel === AUTO_MODEL_ID) {
      if (target.kind !== 'new-session' || input.agentSessionId || input.forked
        || resolveSessionLineageById(sessionId)?.active.providerSessionId) {
        throw new Error('Auto can only select a model for a new session.')
      }
      if (this.pendingSetupControllers.has(sessionId)) throw new Error('This session is already selecting a model.')
      const controller = new AbortController()
      this.pendingSetupControllers.set(sessionId, controller)
      this._setStatus(sessionId, 'connecting')
      try {
        // Auto's selection is Solus work the turn waits on before any provider
        // starts, so it is a dispatch step: the insights waterfall shows the
        // time it took and the model it settled on.
        const route = await dispatchStep(
          'model_route',
          { requestedModel: AUTO_MODEL_ID, fn: 'routeModelPrompt', file: 'control-plane.ts' },
          async (annotate) => {
            const metadata = await installedRoutingProviders([...this.backends.values()].map(backend => backend.metadata))
            controller.signal.throwIfAborted()
            const available: typeof metadata = []
            for (const agent of metadata) {
              try { await this.seatForTurn(request.actor, agent.id); available.push(agent) }
              catch (error) { if (!(error instanceof SeatRequiredError)) throw error }
            }
            // A preferred provider with no quota left cannot answer this turn,
            // so the category's other model takes it instead of a run that
            // fails on arrival.
            const route = await routeModelPrompt(options.displayPrompt ?? options.prompt, getHostConfig().config.modelRouting, available, controller.signal, {
              spent: provider => this.usageLimits.isSpent(provider),
            })
            annotate({ provider: route.provider, modelId: route.modelId, category: route.category, usedFallback: route.usedFallback })
            return route
          },
        )
        Object.assign(input, hostModelInputFor(route.provider, route.modelId), {
          provider: route.provider,
          reasoningEffort: 'medium',
          fastMode: false,
        })
        this._emit(sessionId, {
          type: 'model_routed',
          provider: route.provider,
          modelConfig: { modelId: route.modelId, reasoningEffort: input.reasoningEffort, contextWindow: input.contextWindow, fastMode: false },
          usedFallback: route.usedFallback,
        })
        log.info('model_routed', { sessionId, ...route })
      } catch (error) {
        if (!controller.signal.aborted) this._setStatus(sessionId, 'failed')
        throw error
      } finally {
        if (this.pendingSetupControllers.get(sessionId) === controller) this.pendingSetupControllers.delete(sessionId)
      }
    }
    const pendingHandoff = this._pendingHandoffFor(sessionId)
    if (pendingHandoff) {
      const activeMember = resolveSessionLineageById(sessionId)?.active
      if (activeMember?.provider !== input.provider) {
        throw new Error(`Session ${sessionId} has a provisional handoff to ${activeMember?.provider ?? 'another provider'}`)
      }
    }
    const activeLineage = resolveSessionLineageById(sessionId)?.active
    if (input.forked && activeLineage?.providerSessionId
      && (activeLineage.provider !== input.provider || activeLineage.providerSessionId !== input.agentSessionId)) {
      throw new Error('The fork source is no longer the active session thread.')
    }
    const isContinuation = target.kind === 'session' || (!input.forked && !!activeLineage?.providerSessionId)
    const existingSession = isContinuation ? this.activeSessions.get(sessionId) : undefined
    // What `--resume` gets. Never the Solus id: the provider has never heard of it.
    const resumeAgentSessionId = isContinuation
      ? existingSession?.agentSessionId
        ?? (activeLineage?.provider === input.provider ? activeLineage.providerSessionId : null)
        ?? input.agentSessionId
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
    const resolvedProjectPath = projectScopeOf(input)
    let effectiveGitCtx = sessionGitContext ?? incoming ?? null
    annotateDispatch({
      provider,
      projectRoot: resolvedProjectPath ?? '',
      isContinuation,
      isFork: isForkingInput,
      isResume: !!resumeAgentSessionId,
      hasPendingHandoff: !!pendingHandoff,
    })

    if (!effectiveGitCtx?.worktreePath && resolvedProjectPath && resolvedProjectPath !== '~') {
      const statusGitCtx = await dispatchStep(
        'git_state',
        { projectPath: resolvedProjectPath, fn: 'computeGitState', file: 'control-plane.ts' },
        async (annotate) => {
          const checkout = gitCheckoutFromState(await computeGitState(resolvedProjectPath).catch(() => null))
          annotate({ branch: checkout?.branch ?? '', worktreePath: checkout?.worktreePath ?? '' })
          return checkout
        },
      )
      effectiveGitCtx = statusGitCtx
      if (existingSession) existingSession.gitContext = statusGitCtx ?? undefined
    }

    const worktreeBaseBranch = input.worktreeBaseBranch
    // Inline status card mirroring the pre-run worktree setup. The renderer
    // clears it once the session leaves 'connecting'; a failed card is kept
    // until the user retries setup or explicitly chooses the project directory.
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
        const gitContext: GitCheckout = await dispatchStep(
          'worktree_create',
          {
            projectPath: resolvedProjectPath ?? '',
            baseBranch: worktreeBaseBranch ?? '',
            fn: 'createWorktree',
            file: 'control-plane.ts',
          },
          async (annotate) => {
            // `createWorktree` records its own git commands under this step
            // through the ambient context — it takes no telemetry argument.
            const generatedName = await generateWorktreeName(
              this,
              options.prompt,
              resolvedProjectPath,
              setupController.signal,
            )
            const created = await createWorktree(resolvedProjectPath, options.prompt, worktreeBaseBranch, {
              signal: setupController.signal,
              generatedName,
            })
            annotate({ branch: created.branch, targetBranch: created.targetBranch, worktreePath: created.worktreePath })
            return created
          },
        )
        if (existingSession) existingSession.gitContext = gitContext
        effectiveGitCtx = gitContext
        log.info('worktree_created', { sessionId, branch: gitContext.branch, worktreePath: gitContext.worktreePath })
        captureServerEvent('worktree_created', {})
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
        const card = buildWorktreeCard(0, true)
        card.steps[0].detail = e instanceof Error ? e.message : String(e)
        card.recovery = 'worktree'
        this.failedSetupPrompts.set(sessionId, options)
        this._setStatus(sessionId, 'failed')
        this._emit(sessionId, { type: 'status_card', card })
        throw e
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
      handoffPayload = await dispatchStep(
        'handoff_build',
        {
          fromProvider: pendingHandoff.fromProvider,
          fromSessionId: pendingHandoff.fromSessionId,
          fn: 'handoffBuilder',
          file: 'control-plane.ts',
        },
        async (annotate) => {
          const handoff = await this.handoffBuilder(pendingHandoff.fromSessionId, resolvedProjectPath, {
            loadSession: (threadId, loadProjectPath) => this.loadSession(
              pendingHandoff.fromProvider,
              threadId,
              loadProjectPath,
            ),
          })
          const seedSystemAppend = composeHandoffSeed({ fromProvider: pendingHandoff.fromProvider, ...handoff })
          annotate({ seedChars: seedSystemAppend.length })
          return {
            fromProvider: pendingHandoff.fromProvider,
            fromSessionId: pendingHandoff.fromSessionId,
            seedSystemAppend,
          }
        },
      )
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
    }
    if (handoffPayload) effectiveInput.handoff = handoffPayload

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

    // A prompt can bind an existing task before the provider starts. The
    // client binds or mints on the task's own host first and arrives here with
    // `skipTaskCreation`; a first dispatch that names no task and does not opt
    // out — an older client, a session this host starts itself — mints here.
    if (!options.skipTaskCreation && pendingHandoff && !options.taskId) {
      const existingTask = await dispatchStep('task_lookup', {
        fn: 'tasksForSession',
        file: 'control-plane.ts',
      }, async (annotate) => {
        const found = await tasksForSession(LOCAL_ORGANIZATION_ID, sessionId)
        annotate({ taskId: found?.task.id ?? '' })
        return found
      })
      if (existingTask) options.taskId = existingTask.task.id
    }
    const task = options.skipTaskCreation
      ? null
      : await dispatchStep('task_prepare', {
        projectKey: resolvedProjectPath ?? '',
        branch: effectiveGitCtx?.branch ?? '',
        existingTaskId: options.taskId ?? '',
        fn: 'sessionTaskPreparer',
        file: 'control-plane.ts',
      }, async (annotate) => {
        const prepared = await this.sessionTaskPreparer(LOCAL_ORGANIZATION_ID, {
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
          prompt: options.displayPrompt ?? options.prompt,
        })
        annotate({ taskId: prepared?.id ?? '', minted: !!prepared })
        return prepared
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
      const context = await dispatchStep('task_context', {
        taskId: options.taskId,
        fn: '_taskSystemContext',
        file: 'control-plane.ts',
      }, async (annotate) => {
        const composed = await this._taskSystemContext(options.taskId!, options.taskSnapshot ?? null, sessionId)
        annotate({ contextChars: composed?.length ?? 0 })
        return composed
      })
      if (context) {
        options.systemPrompt = [options.systemPrompt, context].filter(Boolean).join('\n\n')
      }
    } else {
      setForeignTaskSnapshot(sessionId, null)
    }

    // Confirm identified prompts to the sender too: its busy state can differ
    // from ours, leaving a pending steer instead of an optimistic message.
    // Clients reconcile by clientPromptId. Keep the legacy exclusion for
    // senders without an id, whose optimistic message cannot be matched.
    this._emit(sessionId, this._userMessageEvent(options, undefined, request.actor), {
      except: request.servedQueueId || options.clientPromptId ? undefined : sourceClientId,
    })

    let handle: RunHandle
    const activeRun: SessionRunRequest = { ...request, input: effectiveInput }
    try {
      this.activeRunRequests.set(sessionId, activeRun)
      if (!dispatchAgentSessionId) {
        await dispatchStep(
          'session_log',
          {
            provider: backend.id,
            cwd: effectiveCwd ?? '',
            fn: '_logNewSessionPrompt',
            file: 'control-plane.ts',
          },
          () => this._logNewSessionPrompt(effectiveInput, options, backend.id),
        )
      }
      const userInstructions = buildSystemPrompt({
        extraInstructions: effectiveInput.extraInstructions,
        modelInstructions: effectiveInput.modelInstructions,
      })
      const systemPrompt = [
        userInstructions,
        options.systemPrompt,
        handoffPayload?.seedSystemAppend,
      ].filter(Boolean).join('\n\n')
      this.sessionEmitter.recordSystemPrompt(request.sessionId, systemPrompt)
      // Image bytes are read here, not carried through the turn: `options` keeps
      // only the refs, so the transcript event and the queue preview never hold
      // base64. Must be awaited before the synchronous launch step below.
      const promptImages = await resolvePromptImages(options)
      // Resolved again here, not only at submit: a queued prompt drains later, and
      // the author's seat may have been removed or expired in between.
      const seat = await this.seatForTurn(request.actor, provider)
      // Spawning the provider is where the run input, the tool list, and the
      // transport are assembled — the last thing the turn does before it stops
      // being Solus's time and starts being the agent's. Timed without an
      // `await`: the call is synchronous, and suspending here would move
      // handle registration into a later microtask, which the dispatch
      // sequence around it depends on not happening.
      const agentRun = dispatchStepSync('agent_launch', {
        provider,
        model: effectiveInput.model ?? '',
        cwd: effectiveCwd ?? '',
        reasoningEffort: effectiveInput.reasoningEffort ?? '',
        permissionMode: effectiveInput.permissionMode ?? '',
        additionalDirs: (effectiveAdditionalDirs ?? []).join(', '),
        systemPromptChars: systemPrompt.length,
        isResume: !!effectiveInput.agentSessionId,
        isFork: !!effectiveInput.forked,
        fastMode: !!effectiveInput.fastMode,
        imageAttachmentCount: promptImages?.length ?? 0,
        fn: 'runAgent',
        file: 'control-plane.ts',
      }, () => this.runAgent({
        provider,
        prompt: options.prompt,
        cwd: effectiveCwd,
        tools: credentialScopedAgentTools([
          ...request.tools,
          provider === 'codex'
            ? createClaudeSubagentAgentTool(this)
            : createCodexSubagentAgentTool(this),
        ], request.actor),
        model: effectiveInput.model,
        reasoningEffort: effectiveInput.reasoningEffort,
        permissionMode: effectiveInput.permissionMode,
        persistence: 'session',
        service: SPAN_SERVICES.sessions,
        conversation: providerConversationFor(effectiveInput),
        additionalDirectories: effectiveAdditionalDirs,
        imageAttachments: promptImages,
        contextWindow: effectiveInput.contextWindow,
        fastMode: effectiveInput.fastMode,
        systemPrompt,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        seat: seat ?? undefined,
      }, {
        changedFiles: effectiveInput.sessionChangedFiles,
      }))
      handle = agentRun.handle
      handle.sessionId = sessionId
    } catch (err) {
      this.activeRunRequests.delete(sessionId)
      this._setStatus(sessionId, 'failed')
      this.activeSessions.delete(sessionId)
      // A drained queue entry has no RPC caller to reject to: the refusal reaches
      // the transcript as an error so the connect card can stand in for the turn.
      if (err instanceof SeatRequiredError && request.servedQueueId) {
        const enriched = backend.getEnrichedError(dispatchAgentSessionId ?? null, null)
        enriched.message = err.message
        this._emitError(sessionId, enriched)
      }
      throw err
    }

    return { handle, run: activeRun }
  }

  /**
   * The task the turn ran under, id and title, for telemetry.
   *
   * Only a first dispatch carries a task in its options; every later turn in
   * the same session resumes a provider conversation and arrives with none. It
   * is still the same task's work, so the session's own binding answers for it
   * — otherwise the great majority of turns record no task at all and "how much
   * did this task cost" cannot be asked.
   *
   * The id survives a title that cannot be read: a task shipped from another
   * host without a snapshot is still the id every span should carry. A missing
   * task never blocks the turn.
   */
  private async _turnTask(
    run: SessionRunRequest,
  ): Promise<{ id: string; title?: string } | null> {
    const { options } = run
    if (options.taskSnapshot) {
      const task = options.taskSnapshot.details.task
      return { id: task.id, title: task.title }
    }
    if (options.taskId) {
      try {
        return { id: options.taskId, title: (await Task.byId(LOCAL_ORGANIZATION_ID, options.taskId)).title }
      } catch {
        return { id: options.taskId }
      }
    }
    const agentSessionId = run.input.agentSessionId
    if (!agentSessionId) return null
    try {
      const task = await Task.forSession(LOCAL_ORGANIZATION_ID, agentSessionId)
      return task ? { id: task.id, title: task.title } : null
    } catch {
      return null
    }
  }

  private async _linkPreparedTask(run: SessionRunRequest, sessionId: string): Promise<void> {
    const taskId = run.options.taskId
    if (!taskId) return
    // A shipped snapshot marks the task as foreign — its row lives on another
    // host, where the dispatching client writes this link itself.
    if (run.options.taskSnapshot) return
    try {
      await (await Task.byId(LOCAL_ORGANIZATION_ID, taskId)).linkSession(sessionId, 'working', {
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
    const lifecyclePolicy = getHostConfig().config.agentTaskLifecyclePolicy
    if (shipped && shipped.details.task.id === taskId) {
      setForeignTaskSnapshot(sessionId, shipped)
      const overlaid = foreignTaskFor(sessionId, taskId) ?? shipped
      return formatTaskContext(overlaid.details, overlaid.parent, overlaid.sessions, lifecyclePolicy)
    }
    setForeignTaskSnapshot(sessionId, null)
    try {
      const snapshot = await taskSnapshot(LOCAL_ORGANIZATION_ID, taskId)
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
    this._cancelAgentConversationRunWatches(sessionId, queueId)
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
  async retry(ctx: IpcContext, options: PromptOptions, clientId?: string, actor?: TurnActor): Promise<void> {
    const sessionId = this._sessionIdForCtx(ctx)
    if (!sessionId) throw new Error('No session to retry')
    options = this.failedSetupPrompts.get(sessionId) ?? options
    const session = this.activeSessions.get(sessionId)
    const sourceClientId = clientId
    options = {
      ...options,
      promptSource: ctx.session.origin === 'dispatch' ? 'dispatch' : 'typed',
    }

    let request: SessionRunRequest
    const input = runInputFromContext(ctx)
    const tools = selectAgentTools(
      solusToolbox.works,
      solusToolbox.docs,
      solusToolbox.artifact,
      solusToolbox.automations,
      solusToolbox.connections,
      solusToolbox.insights,
      solusToolbox.intelligence,
      solusToolbox.browser,
      solusToolbox.sessions,
      solusToolbox.tasks,
      solusToolbox.config,
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
        actor,
      }
    } else {
      const agentSessionId = session?.agentSessionId ?? ctx.session.agentSessionId
      request = !input.forked && agentSessionId
        ? { input, target: { kind: 'session', sessionId }, sessionId, sourceClientId, options, tools, actor }
        : { input, target: { kind: 'new-session' }, sessionId, sourceClientId, options, tools, actor }
    }

    const lifecycle = await this.runTurn(request)
    await lifecycle.agentSessionId
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
        const sessionId = this.questionIdToSession.get(questionId)
          ?? (pendingInfo?.sessionId ? this.agentSessionToSession.get(pendingInfo.sessionId) : undefined)
        if (sessionId) this.sessionEmitter.resolvePermission(sessionId, questionId, optionId)
        // Before a rejection cancels the run and its routes settle.
        if (pendingInfo?.toolName === 'ExitPlanMode') this._announceAnswered(sessionId, planRulingText(optionId, updatedPlan))
        this._clearPendingInputEvent(questionId)
        this.questionIdToSession.delete(questionId)
        const analytics = { decision: optionId, tool_name: pendingInfo?.toolName }
        captureServerEvent('permission_responded', analytics)
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
      const sessionId = this.questionIdToSession.get(questionId)
      const question = sessionId ? this.activeSessions.get(sessionId)?.pendingInputEvents.find(
        (event) => event.type === 'question_request' && event.questionId === questionId,
      ) : undefined
      if (b.permissions.respondToQuestion(questionId, answers)) {
        if (question?.type === 'question_request') {
          this._announceAnswered(sessionId, question.questions
            .map((item) => (answers[questionKey(item)] ? `${item.question} → ${answers[questionKey(item)]}` : null))
            .filter(Boolean)
            .join('\n') || '(handed the decision back)')
        }
        if (sessionId) {
          this.sessionEmitter.resolveQuestion(sessionId, questionId)
          if (question?.type === 'question_request' && (!question.kind || question.kind === 'standard')) {
            this._emit(sessionId, {
              type: 'question_answered',
              answer: { questionId, questions: question.questions, answers },
              timestamp: Date.now(),
            })
          }
        }
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
      this.sessionEmitter.resolveRateLimit(sessionId)
      this._clearRateLimitTimer(sessionId)
      this.rateLimits.clear(sessionId)
      this._setStatus(sessionId, 'idle')
      this._cancelAgentConversationRunWatches(sessionId, 'active')
      this._rejectRateLimitQueue(sessionId, new Error('Rate-limited prompts stopped'))
      this._broadcastRateLimitResolved(sessionId, action)
      this._dropParkedSession(sessionId)
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

  getTransportInfo(): AgentTransportInfo {
    const result: AgentTransportInfo = {}
    for (const [id, backend] of this.backends) {
      result[id] = backend.metadata.capabilities?.transport || (id === 'claude-code' ? 'claude-sdk/stream-json' : 'unknown')
    }
    return result
  }

  private _currentRateLimitEvent(sessionId: string | null | undefined): Extract<NormalizedEvent, { type: 'rate_limit' }> | null {
    if (!sessionId) return null
    const parked = this.rateLimits.peek(sessionId)
    // The card is still asking what to do with the held prompt, so the limit
    // outlives its own window: retiring it here would take the question away
    // and the prompt with it. The user's answer releases it, whenever it comes.
    if (parked && this._hasUndecidedHeldPrompt(sessionId)) return parked
    const event = this.rateLimits.current(sessionId, Date.now() / 1000)
    if (!event && parked) {
      this._releaseRateLimitQueue(sessionId, 'wait')
      return null
    }

    return event
  }

  /** A prompt the limit stopped, whose three ways out the user has not chosen
   *  between: the session is still parked on the limit, the prompt is still its
   *  active run request, and nothing was queued for it. A later run taking the
   *  session over answers the question by making it moot. */
  private _hasUndecidedHeldPrompt(sessionId: string): boolean {
    if (this.activeSessions.get(sessionId)?.status !== 'rate_limited') return false
    if (!this.activeRunRequests.has(sessionId)) return false
    return !(this.requestQueue.get(sessionId) ?? []).some((req) => req.rateLimitSessionId === sessionId)
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
    if (!gitContext || !cwd || cwd === '~') {
      if (!this.sessionGitEnvironments.has(sessionId)
        && !this.gitWatchKeys.has(sessionId)
        && !session?.gitContext) return
      if (session) session.gitContext = undefined
      this.sessionGitEnvironments.delete(sessionId)
      this._syncGitWatcher(sessionId, null)
      return
    }
    const checkoutCwd = gitContext.worktreePath ?? cwd
    const existing = this.sessionGitEnvironments.get(sessionId)
    if (existing?.cwd === checkoutCwd
      && sameGitCheckout(existing.gitContext, gitContext)
      && (!session || sameGitCheckout(session.gitContext, gitContext))) return

    if (session) session.gitContext = gitContext
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
      // Last watcher for this checkout gone — drop its retained status snapshot
      // so closed projects do not hold serialized git status for the app's life.
      let stillWatched = false
      for (const key of this.gitWatchKeys.values()) {
        if (key === prevKey) { stillWatched = true; break }
      }
      if (!stillWatched) this.lastGitStatusByCwd.delete(prevKey)
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
    // No foreground lease means no one is looking: remember the dirt and
    // recompute when a client returns (dispatch-client step 7). Explicitly
    // requested status reads are unaffected — this gates only watch freshness.
    if (!activityLeases.hasForegroundLease()) {
      this.deferredGitWatchCwds.add(watchCwd)
      return
    }
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

  /** A foreground lease returned: recompute everything that changed while
   *  nobody was looking, so the first frame back is honest. */
  flushDeferredGitRefreshes(): void {
    const deferred = [...this.deferredGitWatchCwds]
    this.deferredGitWatchCwds.clear()
    for (const watchCwd of deferred) void this._onGitWatchFire(watchCwd)
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
        const gitContext = checkoutWithLiveIdentity(environment.gitContext, status)
        // Only the four fields written above can differ from the stored context,
        // so compare them directly instead of double-stringifying per session.
        const previous = environment.gitContext
        const gitContextChanged =
          gitContext.branch !== previous.branch ||
          gitContext.detachedHeadSha !== previous.detachedHeadSha ||
          gitContext.targetBranch !== previous.targetBranch ||
          gitContext.repoRoot !== previous.repoRoot
        if (gitContextChanged) {
          this.sessionGitEnvironments.set(sessionId, { cwd, gitContext })
          const session = this.activeSessions.get(sessionId)
          if (session) session.gitContext = gitContext
          if (gitContext.branch) setSessionBranch(sessionId, gitContext.branch)
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
    // A limit with no known reset never becomes ready on its own; only an
    // explicit send releases it.
    if (event.resetsAt === null) return false
    return event.resetsAt * 1000 <= Date.now()
  }

  /** Resolve missing provider data, then apply retry policy once before the
   * session gate, queue and countdown all consume the same release time.
   * The usage store keeps raw provider timestamps. */
  private _prepareRateLimit(agentId: AgentId, event: Extract<NormalizedEvent, { type: 'rate_limit' }>): Extract<NormalizedEvent, { type: 'rate_limit' }> {
    const reset = event.resetsAt ?? this.usageLimits.resetsAtFor(agentId, event.windowDurationMins)
    const resetsAt = reset === null ? null : reset + (agentId === 'codex' ? CODEX_RATE_LIMIT_SEND_BUFFER_SECONDS : 0)
    return resetsAt === event.resetsAt ? event : { ...event, resetsAt }
  }

  private _scheduleRateLimitRelease(sessionId: string, resetsAt: number | null): void {
    this._clearRateLimitTimer(sessionId)
    if (resetsAt === null) return
    const delay = Math.max(resetsAt * 1000 - Date.now(), 0)
    const timer = setTimeout(() => {
      // The timer releases a prompt somebody queued. A window reopening is not
      // itself a decision, so a held prompt the user has not answered for stays
      // held — releasing it here would either run it unasked or discard it.
      if (this._hasUndecidedHeldPrompt(sessionId)) return
      this._releaseRateLimitQueue(sessionId, 'wait')
    }, delay)
    timer.unref?.()
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
    // Removing the last prompt a limit was holding ends the limit, and nothing
    // else will: the session would keep the `rate_limited` status, and the card
    // its countdown, until some unrelated turn moved it.
    if (this.activeSessions.get(sessionId)?.status !== 'rate_limited') return
    this.sessionEmitter.resolveRateLimit(sessionId)
    this._setStatus(sessionId, 'idle')
    this._broadcastRateLimitResolved(sessionId, 'stop')
    this._dropParkedSession(sessionId)
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
        releaseAt: event.resetsAt ?? undefined,
        rateLimitType: event.rateLimitType,
      })
      // Completion routes are fields on the copied request, so they move with
      // the logical prompt into its retry instead of being rebound by queue id.
    } catch (err) {
      log.error('rate_limit_queue_failed', { sessionId, error: String(err) })
      return false
    }
    this.activeRunRequests.delete(sessionId)
    return true
  }

  private _releaseRateLimitQueue(sessionId: string, action: RateLimitDecisionAction): void {
    this.sessionEmitter.resolveRateLimit(sessionId)
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
    if (!hasQueued) this._dropParkedSession(sessionId)
    this._processQueueForSession(sessionId)
  }

  /**
   * Finish the teardown the `exit` handler deferred. A run that ends on a rate
   * limit keeps its session record so the held turn can resume at release, and
   * the run watchdog exempts it while the status says `rate_limited`. Once the
   * limit is resolved with nothing left to dispatch, that exemption is gone and
   * the record describes a session with no provider run behind it — which the
   * watchdog reads as a dead agent and kills a minute later. Callers run this
   * after the status change and the broadcast, both of which read the record.
   */
  private _dropParkedSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId)
    // Every caller settles the status to `idle` first. Anything else means a run
    // took the session over between the limit resolving and this teardown.
    if (session?.status !== 'idle') return
    const agentSessionId = session.agentSessionId
    if (agentSessionId && this._backendFor(session.backendId).isSessionRunning(agentSessionId)) return
    this.activeSessions.delete(sessionId)
    this.activeRunRequests.delete(sessionId)
    this.missingRunCounts.delete(sessionId)
  }

  private _rejectRateLimitQueue(sessionId: string, reason: Error): void {
    const queue = this.requestQueue.get(sessionId)
    if (!queue) return
    for (let i = queue.length - 1; i >= 0; i--) {
      const req = queue[i]
      if (req.rateLimitSessionId !== sessionId) continue
      queue.splice(i, 1)
      this._cancelAgentConversationRunWatches(sessionId, req.queueId)
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

    const run: SessionRunRequest = {
      ...req.run,
      input,
      target: { kind: 'session', sessionId: req.sessionId },
      sessionId: req.sessionId,
      servedQueueId: req.queueId,
      servedEnqueuedAt: req.enqueuedAt,
      options: { ...req.run.options, promptSource: 'queued' },
    }
    // A session in 'background' still has its provider query open. A second
    // run would resume the same thread beside it, so the prompt goes into the
    // open query; a fresh run is only the fallback once that query has closed.
    const lifecycle = dispatchSession?.status === 'background' && dispatchSession.agentSessionId
      ? this._steerActiveTurn(run, dispatchSession.agentSessionId, dispatchSession)
        .then((steered) => steered ?? this._startRunLifecycle(run))
      : this._startRunLifecycle(run)
    lifecycle
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
        imageRefs: r.run.options.imageAttachmentRefs,
        author: turnAuthorOf(r.run.actor) ?? undefined,
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
      if (this.rateLimits.hasActive(sessionId)) {
        // A session parked on a rate limit intentionally has no provider run:
        // it is holding the limit snapshot that gates its next send. The status
        // is not the test — Codex reports a spent account while it finishes the
        // current turn, which parks a session that settled as `completed`.
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

      // The session is about to be declared dead with no exit code and no
      // stderr, so this log is the only account of why. Record what each side
      // believed: a run alive under a different thread id means a re-key the
      // ControlPlane never saw; an id in `finishedRunSessionIds` means the run
      // ended without its `exit` reaching us; neither means it vanished.
      const tracking = backend.runTrackingSnapshot?.()
        ?? { activeRunSessionIds: [], pendingRunSessionIds: [], finishedRunSessionIds: [] }
      const facts = {
        sessionId,
        agentSessionId,
        backendId: session.backendId,
        status: session.status,
        misses,
        watcherCount: this.watches.get(sessionId)?.size ?? 0,
        msSinceActivity: Date.now() - session.lastActivityAt,
        knownFinished: !!agentSessionId && tracking.finishedRunSessionIds.includes(agentSessionId),
        activeRunSessionIds: tracking.activeRunSessionIds,
        pendingRunSessionIds: tracking.pendingRunSessionIds,
        finishedRunSessionIds: tracking.finishedRunSessionIds,
      }
      if (misses < RUN_WATCHDOG_MISSES) {
        log.warn('active_session_run_missing', facts)
        continue
      }

      log.warn('active_session_not_running', facts)
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
    this._flushPendingSession(sessionId)
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
    // Backwards scan without the copy + reverse allocations: this runs on every
    // status transition, several times per turn.
    let pendingEvent: NormalizedEvent | undefined
    if (session) {
      for (let i = session.pendingInputEvents.length - 1; i >= 0; i--) {
        const e = session.pendingInputEvents[i]
        if (e.type === 'permission_request' || e.type === 'question_request') {
          pendingEvent = e
          break
        }
      }
    }
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
      summary: action.kind === 'finished'
        ? finishedSummary(getIndexedSession(agentSessionId), projectKey)
        : this._attentionSummary(action.kind, pendingEvent),
      projectKey,
    })
  }

  private _attentionSummary(kind: Exclude<AttentionKind, 'finished'>, event?: NormalizedEvent): string {
    switch (kind) {
      case 'needs_approval':
        return event?.type === 'permission_request'
          ? `Approval needed: ${event.toolName}`
          : 'Approval needed'
      case 'question': {
        const q = event?.type === 'question_request' ? event.questions[0]?.question : undefined
        return q ? `Question: ${q.length > 120 ? `${q.slice(0, 117)}…` : q}` : 'Waiting on your answer'
      }
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

  private _writeSessionRecordStatus(sessionId: string, agentSessionId: string, status: SessionRecordStatus): void {
    if (this.recordStatusWritten.get(agentSessionId) === status) return
    this.recordStatusWritten.set(agentSessionId, status)
    void setSessionRecordStatus(LOCAL_ORGANIZATION_ID, agentSessionId, status).catch((error) => {
      // Unknown outcome: the next transition writes again.
      this.recordStatusWritten.delete(agentSessionId)
      log.warn('session_record_status_failed', { sessionId, agentSessionId, error: String(error) })
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
      // Leaving 'background' for 'running' is the agent taking a new turn in
      // the open query — a steered prompt, or its reply to a settled task. The
      // 'background' turn already settled, so this one needs its own id.
      if (oldStatus === 'background' && newStatus === 'running') session.activeTurnId = crypto.randomUUID()
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
    // The collaboration plane's record keeps one fact of this: a turn open or
    // not. Most transitions (connecting, awaiting input, rate limited) keep that
    // fact, so write only when it changes.
    if (agentSessionId) this._writeSessionRecordStatus(sessionId, agentSessionId, sessionRecordStatusOf(newStatus))
    this._emit(sessionId, { type: 'status_change', status: newStatus, oldStatus })
    if (
      session &&
      (newStatus === 'completed' || newStatus === 'failed' || newStatus === 'interrupted' || newStatus === 'dead')
    ) {
      this._queueTurnSettlement(sessionId, session, newStatus)
    }
    // The agent's turn is finished even though its background work is not.
    if (session && newStatus === 'background') this._queueTurnSettlement(sessionId, session, 'completed')
    if (goalUpdate) this._emit(sessionId, { type: 'goal_updated', goal: goalUpdate })
  }

  shutdown(): void {
    this.failedSetupPrompts.clear()
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
  }

  /**
   * The whole routing surface. One publish per watching client — two panes on
   * one renderer are one client and get one payload. `except` drops the client
   * whose optimistic bubble is already on screen; `only` narrows to the client
   * that asked (a reattach replay, or a sender's own withheld echo).
   */
  private _emit(sessionId: string, event: NormalizedEvent, to?: { only?: string; except?: string }): void {
    if (!to) {
      for (const chunk of this.responseText.beforeEvent(sessionId, event)) this._emit(sessionId, chunk)
    }
    // A targeted emit is a replay or an echo to one client; logging it would
    // duplicate it for the next joiner. Only the broadcast stream is the turn.
    if (!to) this._recordTurnEvent(sessionId, event)
    this.emit('event', sessionId, event, to)
  }

  /** Accumulate the in-flight turn so a client joining mid-turn can be brought
   *  level with the clients that were already here. Cleared when the turn settles,
   *  after which durable history on disk is the source. */
  private _recordTurnEvent(sessionId: string, event: NormalizedEvent): void {
    const turnEvents = this.turnLog.get(sessionId)
    if (!turnEvents) {
      this.turnLog.set(sessionId, [event])
      return
    }
    turnEvents.push(event)
    if (turnEvents.length > TURN_LOG_MAX_EVENTS) {
      // Drop the oldest rather than the newest: a joiner seeing the turn's tail is
      // closer to level than one seeing its head. Never silently — a turn this long
      // means a mid-turn joiner gets an incomplete picture.
      const dropped = turnEvents.splice(0, turnEvents.length - TURN_LOG_MAX_EVENTS)
      log.warn('turn_log_truncated', { sessionId, dropped: dropped.length, kept: turnEvents.length })
    }
  }

  private _emitError(sessionId: string, error: ReturnType<AgentBackend['getEnrichedError']>): void {
    this.emit('error', sessionId, error)
  }


  private _clearPendingInputEvent(questionId: string): void {
    const match = (event: NormalizedEvent) => eventHasQuestionId(event, questionId)

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
        for (const route of this.activeRunRequests.get(session.sessionId)?.completionRoutes ?? []) {
          route.awaitingReported = false
        }
        this._setStatus(session.sessionId, this._pendingInputStatus(session))
        this._emit(session.sessionId, {
          type: 'pending_input_sync',
          pendingInputEvents: [...session.pendingInputEvents],
        })
      }
    }
  }

  /** Drain a session's complete buffered prose run before its boundary event. */
  private _flushPendingSession(sessionId: string, bufferedOnly = false): void {
    for (const event of this.responseText.flush(sessionId, bufferedOnly)) this._emit(sessionId, event)
  }
}
