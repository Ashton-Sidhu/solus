import { SessionPermissionStore } from '../data/sessions/session-permission-store'
import { SessionRestartStore, type RestartRun } from '../data/sessions/session-restart-store'
import { restartAuthority, restartContinuationError, restartContinuationPrompt, restartRecoveryEnabled } from './sessions/restart-continuation'
import { hostUser } from '../host/host-user'
import { HandoffCarryStore } from '../data/sessions/handoff-carry-store'
import { childPermissionMode } from './sessions/child-permissions'
import { SessionRequestQueue, type QueuedRequest } from './sessions/session-request-queue'
import { SessionQueueStore } from '../data/sessions/session-queue-store'
import { sessionQueueMutationSchema, type SessionQueueMutation, type SessionQueueSnapshot } from '@solus/contracts/session-queue'
import { withWorkspaceToolAuthority } from '../admission/workspace-tool-authority'
import { questionReply } from '@solus/contracts/question-history'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import { installedRoutingProviders, routeModelPrompt } from './agents/model-routing'
import { loadHistoryPage, type HistorySegment } from './sessions/history-page'
import { forkedFrom, lineageSwitchDivider } from './sessions/thread-activity'
import { EventEmitter } from 'events'
import { appendFile, mkdir, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { createLogger } from '../logger'
import { captureServerEvent } from '../analytics'
import { CheckoutService } from '../git/checkout-service'
import { computeGitState } from '../git/git-helpers'
import { warmFinder } from '../files/file-finder'
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
import { contextPreferences, instructionsFor, unattendedModelInputFor, providerConversationFor, runInputFromContext } from './agents/run-input'
import { buildHandoff, composeHandoffSeed } from './agents/session-handoff'
import { buildSystemPrompt } from './agents/system-hint'
import { isWindowClosed, RateLimitState } from './rate-limits'
import { UsageLimitsStore } from '../usage/usage-store'
import { AttentionService, attentionActionForStatus } from '../attention/attention-service'
import { finishedSummary } from '../attention/finished-summary'
import type { AttentionKind } from '@solus/contracts/attention-types'
import { prepareSessionTask, rekeyTaskSessionLinks, taskIdForSession, tasksForSession, taskWithAttempts } from '../data/tasks/task-sessions'
import { captureTaskLeadPreferences, taskLeadPreferences, taskLeadPreferencesOfSession, withTaskLeadPreferences } from '../data/tasks/task-lead-preferences'
import { rekeySessionPullRequests } from '../data/sessions/session-pull-requests'
import { recordSessionExecutionPreferences, recordSessionPrompt, rekeySessionState, sessionExecutionPreferences, settledSessionIds } from '../data/sessions/session-states'
import { Task } from '../data/tasks/task'
import { formatTaskContext } from '../data/tasks/task-context'
import { ResponseTextBuffer } from './sessions/response-text-buffer'
import { busyTurnFor, type RunningTurnInTree, type WorkingTreeAsker } from './sessions/working-tree-busy'
import { claimAsyncQuestion, pendingAsyncQuestions, saveAsyncQuestion, saveAsyncAnswer, settleAsyncQuestion } from '../data/sessions/async-questions'
import { DEFAULT_EXECUTION_PREFERENCES, type ExecutionPreferences } from '@solus/contracts/settings'
import { inheritedOrganizationOf, parentRecordIdOf, recordSessionSettings, sessionSettings } from './sessions/session-settings'
import { ANY_ORGANIZATION, LOCAL_ORGANIZATION_ID } from '../admission/principal'
import { organizationOfSession, recordSessionId, sessionRecordStatusOf, setSessionRecordStatus } from '../data/sessions/session-records'
import { applyPendingAssignment, inheritSessionOrganization, pendingOrganizationFor } from './sessions/turn-organization'
import { clearForeignTaskSnapshot, setForeignTaskSnapshot } from '../data/tasks/foreign-tasks'
import type { TaskSessionLink, TaskSessionRole, TaskSnapshot } from '@solus/contracts/task-types'
import { getIndexedSession, persistIndexedSessionStart, setSessionBranch } from '../db/session-indexer'
import {
  beginSessionHandoff,
  cancelProvisionalSessionHandoff,
  completeSessionHandoff,
  registerSessionLineage,
  resolveSessionLineage,
  resolveSessionLineageById,
  replaceSessionLineageThread,
  stableSessionIdForProviderThread,
} from '../data/sessions/session-lineage'
import { ANSWERING_ANOTHER_SESSION, type CreateSessionOrder, type RunExchanges, type SessionOrchestrator } from './orchestration/session-orchestrator'
import type { ResolvedInput } from './orchestration/session-outputs'
import { ClaudeGoalStore } from '../data/sessions/claude-goal-store'
import type { AgentBackend, RunHandle } from './agents/agent-backend'
import type {
  AgentId,
  AgentMetadata,
  AgentUsageLimits,
  BackendSession,
  SessionStatus,
  NormalizedEvent,
  PermissionDecision,
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
  AcceptPlanRequest,
  AcceptPlanResult,
  SessionRecordStatus,
  StatusCardState,
  StatusCardStep,
  ThreadGoal,
  ThreadGoalSetRequest,
  WatchSessionInput,
  WatchSessionResult,
} from '@solus/contracts/types'
import { defaultContextWindowFor, encodePathAsFolder, gitCheckoutFromState, isSessionBusyStatus, isSteerableStatus, projectScopeOf, MODEL_PROFILES } from '@solus/contracts/types'
import { solusDir } from '../platform/paths'
import { indexLivePlan } from '../plans/plan-index'
import { activityLeases } from './activity-leases'
import type { SessionHistoryPageRequest, ProviderHistoryPage, SessionLoadMessage, SessionPreviewResult } from '@solus/contracts/session-history'
import { SessionEmitter, annotateDispatch, dispatchStep, dispatchStepSync } from './observability/session-emitter'
import { SeatRequiredError, type SeatStore, type TurnSeat } from './seats/seat-manager'
import { attributionOf, HOST_ACTOR, insightsAccountOf, seatFor, withActorCredentials, type Actor } from '../admission/actor'
import type { Activity, ActivityKind, ActivitySubject } from '@solus/contracts/activity'
import { appendActivity, newActivity } from '../data/activity/activity'
import { sessionActivityStateOf, type SessionActiveTurn, type SessionActivity } from '@solus/contracts/presence'
import { activeTurnFor } from '../presence/presence-manager'
import { sameUser, userKey } from '@solus/contracts/user'
import { SPAN_SERVICES } from '../data/insights/registries'

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

const log = createLogger('SessionRuntime', 'session-runtime.ts')

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

interface CreateSessionRequest extends Omit<CreateSessionOrder, 'modelId'> {
  /** Null for a headless session a client starts on the provider's default. */
  modelId: string | null
  /** The requester's preferences; a child session takes its parent's when absent. */
  executionPreferences?: ExecutionPreferences
}

/** The hooks the session orchestrator takes run facts through. */
type OrchestrationHooks = Pick<SessionOrchestrator,
  | 'runQueued' | 'runStarted' | 'runRateLimited' | 'runSettled' | 'runCancelled' | 'sessionStarted'
  | 'reportsAccepted' | 'reportsDisposed' | 'inputRequested' | 'inputResolved' | 'runEvent' | 'sessionTurnStarted' | 'targetStopped' | 'isAwaitingReplies' | 'cancelSentBy'>

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
  return options
}

/** What a person's answer to a permission or a plan was, for the senders waiting on it. */
function permissionAnswer(
  pendingEvent: NormalizedEvent | undefined,
  toolName: string | undefined,
  optionId: string,
  updatedPlan: string | undefined,
): ResolvedInput {
  const options = pendingEvent?.type === 'permission_request' || pendingEvent?.type === 'plan' ? pendingEvent.options : []
  const allowed = options.find((option) => option.id === optionId)?.kind === 'allow'
  return toolName === 'ExitPlanMode' || pendingEvent?.type === 'plan'
    ? { kind: 'plan', allowed, edited: !!updatedPlan }
    : { kind: 'permission', toolName, allowed }
}

/**
 * What a person chose on a permission or a plan, as every client reads it on the
 * resolution (plan 004 F4). Read from the option's kind, never its label alone;
 * an option the request did not offer names no decision.
 */
export function permissionDecisionFor(pendingEvent: NormalizedEvent | undefined, optionId: string): PermissionDecision | undefined {
  const options = pendingEvent?.type === 'permission_request' || pendingEvent?.type === 'plan' ? pendingEvent.options : []
  const option = options.find((candidate) => candidate.id === optionId)
  if (option?.kind === 'deny') return 'denied'
  if (option?.kind !== 'allow') return undefined
  return /session|always/i.test(`${option.id} ${option.label}`) ? 'approved_for_session' : 'approved'
}

function eventHasQuestionId(event: NormalizedEvent, questionId: string): boolean {
  return 'questionId' in event && event.questionId === questionId
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
   *  map in SessionRuntime is keyed by, and the only one a run has before the
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
  /** Names this logical prompt across the copies setup, queueing and retries
   *  make of it, so the orchestrator can tell a stale result from a current one. */
  runId?: string
  /** The orchestrator's exchanges this run answers. Opaque here: they arrive
   *  with the prompt, move with a queued retry or a steer, and are reported
   *  once when the run settles. Every copy of a run shares this one array. */
  exchangeIds?: string[]
  /** Stored report receipts accepted by this follow-up. */
  reportExchangeIds?: string[]
  /** The session that created this one, recorded with the new thread's first
   *  index row so the child is never indexed without its parent. */
  delegation?: { parentSessionId: string; messageId: string; intent: 'delegate' | 'fire_and_forget'; createdAt: number }
  /** Who asked and whose provider seat the turn runs on (Step 2 plan §3.3). Unset
   *  for the host's own work: automations, agent follow-ups, and local prompts. */
  actor?: Actor
}

/**
 * A member's turn calls GitHub, Google, and Atlassian as that member
 * (cloud-service-model.md §22): every tool the run is handed executes under
 * their credential scope. The host's own work keeps the host's connections.
 */
function credentialScopedAgentTools(tools: AgentTool[], actor: Actor = HOST_ACTOR): AgentTool[] {
  return tools.map((agentTool) => ({
    ...agentTool,
    execute: (input, context) => withActorCredentials(actor, () => withWorkspaceToolAuthority(actor.principal, () => agentTool.execute(input, context))),
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

interface SessionRuntimeOptions {
  buildHandoff?: typeof buildHandoff
  prepareSessionTask?: typeof prepareSessionTask
  queueDirectory?: string
}

/**
 * SessionRuntime: the single backend authority for session lifecycle.
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
export class SessionRuntime extends EventEmitter {
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
  private readonly requestQueue: SessionRequestQueue
  private readonly applyingQueuedSwitch = new Set<string>()
  private readonly sessionPermissionModes: SessionPermissionStore
  private readonly handoffCarry: HandoffCarryStore
  private readonly reservedQueueEntries = new Set<string>()
  private readonly restartRuns: SessionRestartStore | undefined
  private isShuttingDown = false
  private activeRunRequests = new Map<string, SessionRunRequest>()
  private pendingStarts = new Map<RunHandle, PendingStart>()
  /** Worktree setup begins before an agent RunHandle exists, so it needs its
   *  own cancellation path for Stop/Ctrl-C. */
  private pendingSetupControllers = new Map<string, AbortController>()
  /** What was chosen for a permission whose resolution the provider has yet to report, by question id. */
  private permissionAnswers = new Map<string, PermissionDecision>()
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
  /** Owns every exchange between sessions; wired once the host boots. */
  private orchestration: OrchestrationHooks | null = null

  /** Server-side per-session needs-attention state; outlives connected clients
   *  and persists across restarts. Fed by `_setStatus` transitions; read by the
   *  `listAttention` RPC and broadcast on the `attention-changed` topic. */
  readonly attention = new AttentionService()

  readonly checkouts = new CheckoutService(() => activityLeases.hasForegroundLease())
  /** Sessions attach to a checkout path; the Git service owns its identity. */
  private sessionCheckoutPaths = new Map<string, string>()
  private readonly handoffBuilder: typeof buildHandoff
  readonly orchestrationDirectory?: string
  private readonly sessionTaskPreparer: typeof prepareSessionTask
  /** Provider seats, once the host has opened its database. */
  private seats: SeatStore | null = null

  constructor(backends: Map<AgentId, AgentBackend>, opts: SessionRuntimeOptions = {}) {
    super()
    this.orchestrationDirectory = opts.queueDirectory ? join(opts.queueDirectory, 'exchanges') : undefined
    this.sessionPermissionModes = new SessionPermissionStore(opts.queueDirectory ? join(opts.queueDirectory, 'policies', 'permissions.json') : undefined)
    this.handoffCarry = new HandoffCarryStore(opts.queueDirectory ? join(opts.queueDirectory, 'handoff-carry') : undefined)
    this.requestQueue = new SessionRequestQueue(opts.queueDirectory ? new SessionQueueStore(opts.queueDirectory) : undefined)
    this.restartRuns = opts.queueDirectory ? new SessionRestartStore() : undefined
    for (const saved of this.restartRuns?.list() ?? []) {
      if (saved.clientPromptId) this.acceptedClientPromptIds.add(`${saved.sessionId}:${saved.clientPromptId}`)
    }
    this.backends = backends
    this.agentRunner = new AgentRunner(backends)
    this.handoffBuilder = opts.buildHandoff ?? buildHandoff
    this.sessionTaskPreparer = opts.prepareSessionTask ?? prepareSessionTask
    for (const backend of this.backends.values()) {
      this._wireBackend(backend)
    }
    this.checkouts.onChange(({ state }) => {
      for (const [sessionId, cwd] of this.sessionCheckoutPaths) {
        if (cwd !== state.cwd) continue
        const gitContext = this.checkouts.get(cwd)?.checkout ?? undefined
        const session = this.activeSessions.get(sessionId)
        if (session) {
          session.gitContext = gitContext
          if (session.runInput) session.runInput.gitContext = gitContext ?? null
        }
        if (gitContext?.branch) setSessionBranch(sessionId, gitContext.branch)
        if (gitContext) this._emit(sessionId, { type: 'git_context', gitContext })
      }
    })
    this.checkouts.onStatus((cwd, state) => {
      for (const [sessionId, path] of this.sessionCheckoutPaths) {
        if (path === cwd) this._emit(sessionId, { type: 'git_status', cwd, state })
      }
    })
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

  /** The organization the session's spans carry (organization-scope §6.1); undefined for Local work. */
  private async _turnOrganization(sessionId: string): Promise<string | undefined> {
    const organizationId = await organizationOfSession(this._agentSessionIdFor(sessionId) ?? sessionId)
    if (organizationId !== LOCAL_ORGANIZATION_ID) return organizationId
    // A new session has no record yet; the admission already decided its organization.
    return pendingOrganizationFor(sessionId) ?? undefined
  }

  /**
   * Settles the organization a run's work belongs to from the organization its
   * record names — a child or fork inherits its origin's — and records it with
   * the run's captured preferences for the tools the turn calls.
   */
  private async _settleRunOrganization(request: SessionRunRequest): Promise<void> {
    // A fork belongs to the session it branches from until its own record says otherwise.
    const forkSource = request.input.forked && request.input.agentSessionId ? await organizationOfSession(request.input.agentSessionId) : undefined
    const ownOrganization = await this._turnOrganization(request.sessionId) ?? LOCAL_ORGANIZATION_ID
    const recordOrganization = [ownOrganization, forkSource]
      .find((candidate) => candidate !== undefined && candidate !== LOCAL_ORGANIZATION_ID) ?? LOCAL_ORGANIZATION_ID
    const recordId = this._agentSessionIdFor(request.sessionId) ?? (request.input.forked ? null : request.input.agentSessionId)
    // The session a child came from: named by the request that starts it, and by its record's parent link after that.
    const originRecordId = recordOrganization !== LOCAL_ORGANIZATION_ID ? null
      : request.delegation?.parentSessionId ?? await parentRecordIdOf(recordSessionId(recordId ?? request.sessionId))
    const organizationId = await inheritedOrganizationOf(request.sessionId, recordOrganization, originRecordId, (id) => this._sessionIdFor(id))
    // A child or fork records the organization it inherits, so a restart finds it in its record.
    if (organizationId !== LOCAL_ORGANIZATION_ID && ownOrganization === LOCAL_ORGANIZATION_ID) {
      await inheritSessionOrganization(request.sessionId, organizationId, recordId)
    }
    recordSessionSettings(request.sessionId, { organizationId, preferences: request.input.executionPreferences })
  }

  /**
   * A task's runs use the lead preferences the task captured when it was first
   * led (plans/018 §3.1), not the current ones of whoever sent the turn; the
   * first lead dispatch captures them from its sender. A client names the task
   * on every typed turn of a task session, so only a run nobody typed (a lead
   * woken in the background) looks its task up through its link.
   */
  private async _useTaskLeadPreferences(request: SessionRunRequest): Promise<void> {
    const { taskId, taskRole, taskSnapshot, promptSource = 'typed' } = request.options
    // A foreign task's row, and its capture, live on another host.
    if (taskSnapshot || (!taskId && promptSource === 'typed')) return
    const preferences = request.input.executionPreferences
    let captured = taskId ? await taskLeadPreferences(taskId) : await taskLeadPreferencesOfSession(request.sessionId)
    if (!captured && taskId && taskRole === 'lead' && preferences) captured = await captureTaskLeadPreferences(taskId, preferences)
    if (captured) request.input.executionPreferences = withTaskLeadPreferences(preferences, captured)
  }

  /** The Solus session a record (a provider thread id) belongs to while it is live; the id itself otherwise. */
  sessionIdForRecord(recordId: string): string {
    return this.agentSessionToSession.get(recordId) ?? recordId
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
        // the task it names still needs linking.
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
            // A created child's card knew it by its pending message; from here
            // its updates name the real thread.
            const startedRun = this._runExchanges(initializedRun, event.sessionId)
            if (startedRun) this.orchestration?.sessionStarted(startedRun, event.sessionId, initializedRun.input.workingDirectory)
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
        const restartRun = this.restartRuns?.get(initSessionId)
        if (restartRun && !this.isShuttingDown) {
          this.restartRuns?.save({ ...restartRun, input: { ...restartRun.input, agentSessionId: event.sessionId }, state: 'running' })
        }
        // Every column the index row fills is COALESCE-guarded, and status has its
        // own writer, so a later init of the same thread only matters when the
        // model or effort the record shows has changed.
        const indexedStart = runReqInput ? `${runReqInput.model}\u0000${runReqInput.reasoningEffort}` : null
        if (runReqInput && indexedStart && this.indexedThreadStarts.get(event.sessionId) !== indexedStart) {
          this.indexedThreadStarts.set(event.sessionId, indexedStart)
          this.recordStatusWritten.set(event.sessionId, 'running')
          // The record id is known now. The status write below is skipped as
          // already written, so an admitted or inherited organization lands here,
          // before the record is born, not at the turn's end.
          applyPendingAssignment(initSessionId, event.sessionId)
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
          this._reportToActiveRun(session.sessionId, (run) => this.orchestration?.runEvent(run, event))
        } else if (event.type === 'question_request' && event.responseMode === 'message') {
          if (!saveAsyncQuestion(session.sessionId, agentSessionId, event)) return
          this._syncAttention(agentSessionId, session.sessionId, session.status)
          this._reportToActiveRun(session.sessionId, (run) => this.orchestration?.runEvent(run, event))
        } else if (event.type === 'permission_request' || event.type === 'question_request') {
          session.hasPendingInput = true
          session.pendingInputEvents.push(event)
          this.questionIdToSession.set(event.questionId, session.sessionId)
          this._setStatus(session.sessionId, 'awaiting_input')
          this._reportToActiveRun(session.sessionId, (run) => this.orchestration?.inputRequested(run, event))
        } else if (event.type === 'plan') {
          const cwd = session.runInput?.workingDirectory ?? getIndexedSession(agentSessionId)?.cwd ?? '~'
          if (event.planToolUseId && event.planContent.trim()) {
            const planToolUseId = event.planToolUseId
            void indexLivePlan({
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
            void Task.linkSessionOutput(ANY_ORGANIZATION, agentSessionId, {
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
          this._reportToActiveRun(session.sessionId, (run) => {
            this.orchestration?.runEvent(run, event)
            if (status === 'awaiting_input' || status === 'awaiting_plan') this.orchestration?.inputRequested(run, event)
          })
        } else if (event.type === 'permission_resolved') {
          this._nameDecision(event)
          session.pendingInputEvents = session.pendingInputEvents.filter(
            (pendingEvent) => !eventHasQuestionId(pendingEvent, event.questionId),
          )
          this.questionIdToSession.delete(event.questionId)
          session.hasPendingInput = session.pendingInputEvents.length > 0
          this._setStatus(session.sessionId, this._pendingInputStatus(session))
        }

        // A work the turn made is part of what it answers its senders with.
        if (event.type === 'work_created' || event.type === 'artifact_created') {
          this._reportToActiveRun(session.sessionId, (run) => this.orchestration?.runEvent(run, event))
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
          if (this.orchestration?.isAwaitingReplies(session.sessionId)) {
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
          // The run keeps the behaviour its sender chose (plans/018 §3.1): it is
          // carried with the run and its queue entry, so another client's later
          // edit does not change it.
          if (run?.input.rateLimitBehavior === 'queue') {
            this._queueActiveRateLimitedRequest(session.sessionId)
          }
          // Publish the queue before the status so clients cannot briefly show
          // a decision card for a retry the host already chose to queue.
          this._setStatus(session.sessionId, 'rate_limited')
          // The run keeps its exchanges whether it waits in the queue for the
          // reset or on a person's decision; its senders hear it is parked.
          const parked = run ? this._runExchanges(run, agentSessionId) : null
          // The event counts seconds; the orchestrator's readers count milliseconds.
          if (parked) this.orchestration?.runRateLimited(parked, { resetsAt: event.resetsAt === null ? undefined : event.resetsAt * 1000, limitType: event.rateLimitType })
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
      this._stampTurnAuthor(sessionId, event)

      // ─── Delivery ───
      //
      // No early return when nobody is watching: a session with an empty watch
      // set is an ordinary count, and the buffering and turn accumulation below
      // still have to happen so a client that joins later sees the turn.

      if (event.type === 'text_chunk') {
        // The delivery the run was dispatched with, so a second client's setting cannot change it mid-stream.
        const streamingMode = this.activeRunRequests.get(sessionId)?.input.executionPreferences?.responseStreamingMode
          ?? DEFAULT_EXECUTION_PREFERENCES.responseStreamingMode
        for (const delivered of this.responseText.append(sessionId, event, streamingMode, Date.now())) {
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
      if (agentSessionId) this._expirePendingInput(backend, agentSessionId)

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
      // start_session, card not yet opened) still needs its exit lifecycle —
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
          && this.orchestration?.isAwaitingReplies(sessionId)
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
        if (agentSessionId) {
          try { this.handoffCarry.settle(agentSessionId, newStatus, this.turnLog.get(sessionId) ?? [], Date.now()) }
          catch (error) { log.error('handoff_carry_save_failed', { sessionId, error: String(error) }) }
        }
        this.turnLog.delete(sessionId)
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

    backend.on('background-command-completed', (agentSessionId: string, prompt: string) => {
      void this.promptSession(agentSessionId, prompt, 'queue', { via: 'background-command' }).catch((error) => {
        log.warn('background_command_wake_failed', { agentSessionId, error: error instanceof Error ? error.message : String(error) })
      })
    })

    backend.on('error', (agentSessionId: string | null, err: Error) => {
      if (agentSessionId) this._expirePendingInput(backend, agentSessionId)

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
    const pendingQuestions = pendingAsyncQuestions(sessionId).map(({ questionId, questions, responseMode }) => ({ questionId, questions, responseMode }))
    const pending = pendingQuestions.length ? { pendingQuestions } : {}
    if (!input.attachRuntime || !input.agentSessionId) return { sessionId, ...pending }
    // Same order a separate bind would follow: drained, joined, then replayed.
    return { sessionId, runtime: this._attachRuntime(sessionId, input.agentSessionId, clientId), ...pending }
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
      taskId: await taskIdForSession(ANY_ORGANIZATION, sessionId),
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
    const restoredQueue = this._queuedPromptsForSession(ctx.session.sessionId)
    if (restoredQueue.length && !this.activeSessions.has(ctx.session.sessionId)) {
      return { modelConfig: null, permissionMode: null, status: 'idle', queuedPrompts: restoredQueue, rateLimitInfo: null }
    }
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
    return this._attachRuntime(sessionId, agentSessionId, clientId, contextPreferences(ctx).rateLimitBehavior ?? DEFAULT_EXECUTION_PREFERENCES.rateLimitBehavior)
  }

  /** Join a watching client to a session's live runtime: replay the turn so far
   *  to that client alone and read the run config back. Null when nothing is
   *  running for the session any more. */
  private _attachRuntime(sessionId: string, agentSessionId: string, clientId: string, rateLimitBehavior?: SessionRunInput['rateLimitBehavior']): RuntimeSessionInfo | null {
    const session = this.activeSessions.get(sessionId)
    if (!session) return null

    if (rateLimitBehavior) this.queueHeldRateLimitedPrompts(rateLimitBehavior, sessionId)

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
    // The host's list then replaces the client's: a card this client kept from
    // before it reconnected, answered or closed meanwhile, leaves.
    this._emit(sessionId, { type: 'pending_input_sync', pendingInputEvents: [...session.pendingInputEvents] }, { only: clientId })

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
      if (!restoredHandoff) {
        await rekeyTaskSessionLinks(ANY_ORGANIZATION, sessionId, pendingHandoff.fromSessionId)
        await rekeySessionPullRequests(sessionId, pendingHandoff.fromSessionId)
        await rekeySessionState(sessionId, pendingHandoff.fromSessionId)
      }
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

  /**
   * Accept a plan in its own session (plans/012 §5): stop the planning run, hand
   * the session to another agent or start a fresh agent session as asked, and
   * record `plan_decided`. The planning run ends because the work moves on, not
   * because someone stopped it, so the stop records no `stopped` of its own.
   * The client sends the implementation prompt next.
   */
  async acceptPlan(ctx: IpcContext, request: AcceptPlanRequest, actor: Actor): Promise<AcceptPlanResult> {
    const sessionId = this._sessionIdForCtx(ctx) ?? ctx.session.sessionId
    if (this.isSessionBusy(sessionId)) this.stopSession(sessionId, HOST_ACTOR)
    const result: AcceptPlanResult = {}
    const decided: Extract<ActivityKind, { kind: 'plan_decided' }> = { kind: 'plan_decided', planId: request.planId, decision: 'accepted' }
    if (request.provider) {
      result.handoff = await this.switchSessionProvider(sessionId, request.provider, ctx.session.agentSessionId, actor)
    } else if (request.startNewSession) {
      await this.resetSession(ctx)
      decided.newSessionId = sessionId
    }
    await this.recordActivity({ kind: 'session', id: sessionId }, actor, decided)
    return result
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
        divider: previous ? lineageSwitchDivider(lineage.sessionId, previous, member) : undefined,
      }
    }) : [{ provider, sessionId, projectPath }]
    return loadHistoryPage(
      JSON.stringify(lineage ? [lineage.sessionId] : [provider, sessionId]), segments,
      request.turnLimit, request.before,
      async (segment, turnLimit, before) => {
        const backend = this._backendFor(segment.provider)
        if (!backend.loadSessionPage) throw new Error('This provider does not support history pages.')
        return backend.loadSessionPage(segment.sessionId!, segment.projectPath, turnLimit, before)
      },
    )
  }

  async loadSession(agentId: AgentId, sessionId: string, projectPath?: string, limit?: number): Promise<SessionLoadMessage[]> {
    let handoff = resolveSessionLineage(agentId, sessionId) ?? resolveSessionLineageById(sessionId)
    if (!handoff) return this.handoffCarry.merge(sessionId, await this._backendFor(agentId).loadSession(sessionId, projectPath, limit))

    for (let attempt = 0; attempt < 2; attempt++) {
      const loaded: SessionLoadMessage[][] = []
      for (const member of handoff.members) {
        if (!member.providerSessionId) {
          loaded.push([])
          continue
        }
        try {
          loaded.push(this.handoffCarry.merge(member.providerSessionId, await this._backendFor(member.provider).loadSession(
            member.providerSessionId,
            member.cwd || projectPath,
            limit,
          )))
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
        if (index > 0) composite.push(lineageSwitchDivider(handoff.sessionId, handoff.members[index - 1], member))
        composite.push(...loaded[index].map((message) => ({ ...message, sourceProvider: member.provider, sourceSessionId: member.providerSessionId ?? undefined })))
      }
      return limit && composite.length > limit ? composite.slice(-limit) : composite
    }
    return []
  }

  /** `knownAgentSessionId` is the client's view of the provider thread. A
   *  session only has a record here while a runtime is attached, so an idle
   *  conversation — one whose process exited, or one restored after a restart —
   *  has none, and the caller is the only holder of the thread to hand off.
   *  The switch is recorded as `agent_switched` activity (plans/012 §5), at the
   *  lineage member's start so the lineage read shows it once. */
  async switchSessionProvider(sessionId: string, newProvider: AgentId, knownAgentSessionId: string | null | undefined, actor: Actor): Promise<SessionProviderSwitchResult> {
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
      await this.recordActivity({ kind: 'session', id: sessionId }, actor, { kind: 'agent_switched', provider: newProvider, fromProvider })
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
    if (!this.applyingQueuedSwitch.has(sessionId) && (hasNonRateLimitedQueue || (!isRateLimited && queuedRequests.length > 0))) {
      throw new Error(`Session ${oldAgentSessionId} has queued prompts and cannot switch providers`)
    }

    if (isRateLimited) {
      // Switching providers abandons only the prompt parked by the exhausted
      // provider. Clear that provider's reset state before detaching the session
      // so the renderer sees the card and queued prompt disappear.
      this._clearRateLimitTimer(sessionId)
      this.rateLimits.clear(sessionId)
      if (!this.applyingQueuedSwitch.has(sessionId)) this._rejectRateLimitQueue(sessionId, new Error('Provider switched'))
      else {
        for (const entry of this.requestQueue.get(sessionId) ?? []) {
          if (entry.reason !== 'rate_limit') continue
          entry.reason = 'busy'
          entry.rateLimitSessionId = undefined
          entry.releaseAt = undefined
          entry.rateLimitType = undefined
          entry.revision = (entry.revision ?? 0) + 1
        }
        this.requestQueue.save(sessionId)
      }
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
    const switched: Extract<ActivityKind, { kind: 'agent_switched' }> = { kind: 'agent_switched', provider: newProvider, fromProvider }
    const fromModel = indexedSession?.model ?? session?.runInput?.preferredModel
    if (fromModel) switched.fromModel = fromModel
    await this.recordActivity({ kind: 'session', id: sessionId }, actor, switched, handoff.active.startedAt)

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
    const sessionId = this._sessionIdFor(agentSessionId)
    if (!sessionId) return []
    return [...(this.activeSessions.get(sessionId)?.pendingInputEvents ?? []), ...pendingAsyncQuestions(sessionId)]
  }

  /** Hands every exchange between sessions to the orchestrator. */
  useOrchestration(orchestration: OrchestrationHooks): void {
    this.orchestration = orchestration
  }

  /** What a run tells the orchestrator: which exchanges it answers. Null when
   *  it answers none, so an ordinary turn never reaches the orchestrator. */
  private _runExchanges(run: SessionRunRequest, agentSessionId?: string | null): RunExchanges | null {
    if (!run.exchangeIds?.length || !run.runId) return null
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      agentSessionId: agentSessionId ?? this.activeSessions.get(run.sessionId)?.agentSessionId ?? run.input.agentSessionId,
      exchangeIds: run.exchangeIds,
    }
  }

  /** Something happened in a session's live turn that its senders hear about. */
  private _reportToActiveRun(sessionId: string, report: (run: RunExchanges) => void): void {
    const active = this.activeRunRequests.get(sessionId)
    const run = active ? this._runExchanges(active) : null
    if (run) report(run)
  }

  /** A run that will never reach a turn: its exchanges end without a reply. */
  private _cancelRunExchanges(run: SessionRunRequest | undefined, outcome: 'interrupted' | 'failed' = 'interrupted'): void {
    const exchanges = run ? this._runExchanges(run) : null
    if (run?.reportExchangeIds?.length) this.orchestration?.reportsDisposed(run.reportExchangeIds)
    if (!exchanges) return
    const cancelled = { ...exchanges, exchangeIds: run!.exchangeIds!.splice(0) }
    this.orchestration?.runCancelled(cancelled, outcome)
  }

  /** The run's turn ended. Reported once: the ids leave the run as they go. */
  private _settleRunExchanges(
    run: SessionRunRequest,
    outcome: 'completed' | 'interrupted' | 'failed',
    handle: RunHandle,
    runMeta: { durationMs?: number; toolCallCount?: number },
  ): void {
    const exchanges = this._runExchanges(run, handle.agentSessionId)
    if (!exchanges || !this.orchestration) return
    const session = this.activeSessions.get(run.sessionId)
    this.orchestration.runSettled({
      ...exchanges,
      exchangeIds: run.exchangeIds!.splice(0),
      outcome,
      resultText: handle.resultText,
      durationMs: runMeta.durationMs,
      toolCallCount: runMeta.toolCallCount,
      provider: run.input.provider,
      projectScope: projectScopeOf(run.input),
      gitContext: session?.gitContext ?? run.input.gitContext,
    })
  }

  /** Solus's id for a session named by either id, while this process knows it. */
  sessionIdFor(id: string): string | undefined {
    return this._sessionIdFor(id)
  }

  activeExchangeIdsFor(sessionId: string): string[] {
    return this.activeRunRequests.get(sessionId)?.exchangeIds ?? []
  }

  queuedExchanges(): Array<{ sessionId: string; queueId: string; exchangeIds: string[]; reportExchangeIds: string[]; started: boolean }> {
    return [...this.requestQueue.values()].flatMap((entries) => entries.map((entry) => ({
      sessionId: entry.sessionId, queueId: entry.queueId, exchangeIds: entry.run.exchangeIds ?? [],
      reportExchangeIds: entry.run.reportExchangeIds ?? [], started: !!entry.started,
    })))
  }

  agentSessionIdFor(sessionId: string): string | undefined {
    return this._agentSessionIdFor(sessionId) ?? undefined
  }

  /** Publish an event to every client watching a session. */
  publish(sessionId: string, event: NormalizedEvent): void {
    this._emit(sessionId, event)
  }

  /** Holds a host update until orchestration work outside any run settles. */
  trackUpdateWork<T>(work: Promise<T>): Promise<T> {
    this.updateWorkCount++
    return work.finally(() => { this.updateWorkCount-- })
  }

  hasQueuedPrompt(sessionId: string, queueId: string): boolean {
    return this.requestQueue.get(sessionId)?.some((request) => request.queueId === queueId) ?? false
  }

  /** Rewrite a queued prompt this host sent itself, such as a report that later
   *  reports merge into. Same effect as a person editing it in the queue. */
  replaceQueuedPrompt(sessionId: string, queueId: string, text: string, reportExchangeIds?: string[], exchangeIds?: string[]): boolean {
    return this._editQueuedPrompt(sessionId, queueId, text, undefined, { reportExchangeIds, exchangeIds })
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
  async seatForTurn(actor: Actor | undefined, provider: AgentId): Promise<TurnSeat | null> {
    // Plan 012 §3 refuses a turn with no actor (SEAT_REQUIRED). Automations and
    // agent-started turns have no actor until plan 004 item 1 / P7 names whose
    // turn they are, so they still fall back to the host login here.
    if (!this.seats || !actor) return null
    return this.seats.resolveForTurn(seatFor(actor), provider)
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
    if (this.isShuttingDown) throw new Error('The host is shutting down')
    // Existing automation runs, watch wakes, and agent follow-ups drain with
    // their parent work. User submissions, new automation triggers, and new
    // watch probes are gated separately.
    if (request.options.promptSource !== 'automation' && request.options.promptSource !== 'watch' && !(request.options.promptSource === 'agent' && this.hasWorkForUpdate())) this.assertNewWorkAllowed()
    this.sessionPermissionModes.set(request.sessionId, request.input.permissionMode)
    await recordSessionExecutionPreferences(request.sessionId, request.input.executionPreferences)
    // New work wins over any continuation not yet delivered.
    const previousRestart = this.restartRuns?.get(request.sessionId)
    this.restartRuns?.remove(request.sessionId)
    let removedRecovery = false
    for (const entry of [...(this.requestQueue.get(request.sessionId) ?? [])]) {
      if (entry.run.options.clientPromptId?.startsWith('restart:')) {
        this.requestQueue.remove(request.sessionId, entry.queueId)
        removedRecovery = true
      }
    }
    if (removedRecovery) this._publishQueue(request.sessionId)
    request.runId ??= crypto.randomUUID()
    // Count before the first await: a concurrent update must see setup and
    // accepted queued work, not just an already-running provider process.
    this.updateWorkCount++
    try {
      const lifecycle = await this._acceptTurn(request, deviceId)
      void lifecycle.done.finally(() => { this.updateWorkCount-- }).catch(() => {})
      return lifecycle
    } catch (error) {
      this.updateWorkCount--
      if (previousRestart && !this.isShuttingDown && previousRestart.input.agentSessionId
        && this._backendFor(previousRestart.input.provider).isSessionRunning(previousRestart.input.agentSessionId)
        && !this.restartRuns?.get(request.sessionId)) {
        this.restartRuns?.save(previousRestart)
      }
      throw error
    }
  }

  private async _acceptTurn(request: SessionRunRequest, deviceId?: string): Promise<SessionRunLifecycle> {
    if (this.applyingQueuedSwitch.has(request.sessionId)) {
      return this._enqueueRequest(request, { sessionId: request.sessionId, reason: 'busy', deviceId })
    }
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

    if ((this.requestQueue.get(request.sessionId)?.length ?? 0) > 0) {
      return this._enqueueRequest(request, { sessionId: request.sessionId, reason: 'busy', deviceId })
    }
    return this._startRunLifecycle(request)
  }

  /** The transcript echo for a prompt whose sender is waiting on us to render
   *  it — every other client gets the same event from the run itself. */
  private _userMessageEvent(
    options: PromptOptions,
    delivery?: PromptDelivery,
    actor?: Actor,
  ): NormalizedEvent {
    const event: Extract<NormalizedEvent, { type: 'user_message' }> = {
      type: 'user_message',
      text: options.displayPrompt ?? options.prompt,
    }
    if (delivery) event.delivery = delivery
    // Every client labels the bubble with its author; the host's own work
    // (automations, follow-ups) carries no name, and neither does a history reload.
    if (actor?.user) event.author = actor.user
    if (options.clientPromptId) event.clientPromptId = options.clientPromptId
    // Refs win: they name bytes the host already holds, so the echo every client
    // receives stays small. Inline images are only what an older client sent.
    if (options.imageAttachmentRefs?.length) event.imageAttachmentRefs = options.imageAttachmentRefs
    if (options.imageAttachments?.length) event.imageAttachments = options.imageAttachments
    if (options.via) {
      event.via = options.via
      event.automationId = options.automationId
      event.automationName = options.automationName
      event.watchId = options.watchId
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
    // A steer is answered by the turn that accepted it. Its exchanges join that
    // turn now, in the same microtask the acceptance resolved in, before any
    // event of that turn's end can be handled, so they settle with it and hear
    // its questions.
    if (request.reportExchangeIds?.length) this.orchestration?.reportsAccepted(request.reportExchangeIds)
    const steeredIds = request.exchangeIds?.splice(0) ?? []
    if (steeredIds.length) {
      const activeRun = this.activeRunRequests.get(request.sessionId)
      if (activeRun?.runId) {
        (activeRun.exchangeIds ??= []).push(...steeredIds)
        this.orchestration?.runStarted({ runId: activeRun.runId, sessionId: request.sessionId, agentSessionId, exchangeIds: steeredIds })
      } else {
        // A backgrounded turn has already released its run record.
        request.exchangeIds = steeredIds
        const steered = this._runExchanges(request, agentSessionId)
        if (steered) this.orchestration?.runStarted(steered)
        void handle.runPromise.then(
          () => this._settleRunExchanges(request, handle.abortController.signal.aborted ? 'interrupted' : 'completed', handle, {}),
          () => this._settleRunExchanges(request, handle.abortController.signal.aborted ? 'interrupted' : 'failed', handle, {}),
        )
      }
    }

    session.promptCount = (session.promptCount ?? 0) + 1
    session.lastActivityAt = Date.now()
    const userMessage = this._userMessageEvent(request.options, 'steer', request.actor)
    const organizationId = await this._turnOrganization(request.sessionId)
    if (backend.isSessionRunning(agentSessionId)) {
      this._saveRestartRun({ ...request, input: { ...(session.runInput ?? request.input), agentSessionId } }, organizationId)
    }
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
    origin?: { clientId?: string; deviceId?: string; actor?: Actor },
  ): Promise<PromptDispatchResult> {
    this.assertNewWorkAllowed()
    const proposedSessionId = ctx.session.sessionId
    if (!proposedSessionId) {
      throw new Error('No sessionId provided — rejecting to prevent misrouting')
    }
    // No seat, no turn: refused here, before the prompt is echoed or queued, so the
    // client can show the connect card instead of a bubble that never answers.
    const provider = ctx.session.provider ?? resolveSessionLineageById(proposedSessionId)?.active.provider
    if (provider && ctx.session.preferredModel !== AUTO_MODEL_ID) {
      try {
        await this.seatForTurn(origin?.actor, provider)
      } catch (error) {
        // The room learns who waits on a seat; the refused client also has the card.
        if (error instanceof SeatRequiredError && origin?.actor?.user) {
          void this.recordActivity({ kind: 'session', id: proposedSessionId }, origin.actor, { kind: 'seat_needed', provider })
        }
        throw error
      }
    }
    if (options.clientPromptId) {
      const dedupeKey = `${proposedSessionId}:${options.clientPromptId}`
      if (this.acceptedClientPromptIds.has(dedupeKey) || this.requestQueue.hasPrompt(proposedSessionId, options.clientPromptId)) {
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
    let lifecycle: SessionRunLifecycle
    try {
      lifecycle = await this.runTurn({
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
          solusToolbox.watches,
          solusToolbox.connections,
          solusToolbox.insights,
          solusToolbox.intelligence,
          solusToolbox.browser,
          solusToolbox.devices,
          solusToolbox.sessions,
          solusToolbox.tasks,
          solusToolbox.config,
        ),
      }, origin?.deviceId)
      await lifecycle.agentSessionId
    } catch (error) {
      if (options.clientPromptId && !this.requestQueue.hasPrompt(sessionId, options.clientPromptId)) {
        this.acceptedClientPromptIds.delete(`${proposedSessionId}:${options.clientPromptId}`)
      }
      throw error
    }
    const dispatch: PromptDispatchResult = {
      disposition: lifecycle.disposition,
    }
    if (lifecycle.queueId) dispatch.queueId = lifecycle.queueId
    return dispatch
  }

  /**
   * Wake a session for one of its watches (docs/plans/watches.md): queue the
   * wake prompt behind any active turn, resuming the session from disk when it
   * is not resident. No source client is named, so the wake reaches every client
   * watching the session. Resolves once the turn is accepted; `done` settles
   * when that turn ends, which is when the watch waits again or ends.
   */
  async dispatchWake(wake: { sessionId: string; watchId: string; prompt: string; displayPrompt: string }): Promise<{ done: Promise<unknown> }> {
    const { sessionId, input } = await this._unattendedRunInput(wake.sessionId)
    const lifecycle = await this.runTurn({
      input,
      target: { kind: 'session', sessionId },
      sessionId,
      tools: selectAgentTools(
        solusToolbox.works,
        solusToolbox.docs,
        solusToolbox.artifact,
        solusToolbox.automations,
        solusToolbox.watches,
        solusToolbox.connections,
        solusToolbox.insights,
        solusToolbox.intelligence,
        solusToolbox.browser,
        solusToolbox.devices,
        solusToolbox.sessions,
        solusToolbox.tasks,
        solusToolbox.config,
      ),
      options: {
        prompt: wake.prompt,
        promptSource: 'watch',
        displayPrompt: wake.displayPrompt,
        delivery: 'queue',
        via: 'watch',
        watchId: wake.watchId,
      },
    })
    return { done: lifecycle.done }
  }

  /**
   * The run input for a prompt nobody at the session's keyboard sent: the
   * resident run's input, or one rebuilt from the session's stored start
   * configuration. `id` is the stable Solus session or a provider thread.
   */
  private async _unattendedRunInput(id: string): Promise<{ sessionId: string; input: SessionRunInput }> {
    const requestedMeta = getIndexedSession(id)
    const handoff = resolveSessionLineageById(id) ?? (requestedMeta
      ? resolveSessionLineage(requestedMeta.provider, id)
      : null)
    const agentSessionId = handoff?.active.providerSessionId ?? id
    // Keep the stable target for dispatch and pass only its thread to the backend.
    const sessionId = handoff?.sessionId ?? this._sessionIdFor(agentSessionId) ?? crypto.randomUUID()
    const resident = this.activeSessions.get(sessionId)
    if (resident?.runInput) return { sessionId, input: { ...resident.runInput, agentSessionId, forked: false } }
    // The preferences the session's last run carried, kept across idle release and host restart.
    const preferences = sessionSettings(sessionId)?.preferences ?? await sessionExecutionPreferences(sessionId)
    const meta = await this.getSessionInfo(agentSessionId)
    if (!meta) throw new Error(`Session ${agentSessionId} not found`)
    if (!meta.model || !meta.reasoningEffort) {
      throw new Error(`Session ${agentSessionId} has no persisted starting model configuration`)
    }
    const provider = handoff?.active.provider ?? meta.provider
    const cwd = handoff?.active.cwd ?? meta.cwd
    return {
      sessionId,
      input: {
        provider,
        agentSessionId,
        forked: false,
        workingDirectory: cwd,
        projectPath: cwd,
        additionalDirs: [],
        gitContext: null,
        worktreeBaseBranch: null,
        sessionChangedFiles: [],
        contextWindow: defaultContextWindowFor(provider, meta.model),
        model: meta.model,
        preferredModel: meta.model,
        reasoningEffort: meta.reasoningEffort,
        fastMode: false,
        // An unattended follow-up keeps the stored policy across idle release
        // and host restart. Legacy sessions use the supervised policy.
        permissionMode: this.sessionPermissionModes.get(sessionId) ?? 'supervised',
        rateLimitBehavior: 'queue',
        ...instructionsFor(preferences, meta.model),
        executionPreferences: preferences,
      },
    }
  }

  private _saveRestartRun(request: SessionRunRequest, organizationId: string | undefined): void {
    if (!this.restartRuns || this.isShuttingDown || !restartRecoveryEnabled()
      || (organizationId !== undefined && organizationId !== LOCAL_ORGANIZATION_ID)
      || request.delegation || request.options.automationId || request.options.watchId) return
    const authority = restartAuthority(request.actor)
    if (request.input.agentSessionId && getIndexedSession(request.input.agentSessionId)?.delegation) return
    if (!authority) return
    const clientPromptId = request.options.clientPromptId?.startsWith('restart:')
      ? this.restartRuns.get(request.sessionId)?.clientPromptId : request.options.clientPromptId
    this.restartRuns.save({
      sessionId: request.sessionId, runId: request.runId!, input: request.input, state: 'starting',
      author: request.actor?.user ?? null, authority,
      prompt: request.options.displayPrompt ?? request.options.prompt,
      taskId: request.options.taskId, queueId: request.servedQueueId, backgroundTools: [],
      clientPromptId,
    })
  }

  /** Called once after host admission, seats and tools are wired. Client
   * reconnects never call this. Restored user queues stay held. */
  async recoverSessionsAfterRestart(): Promise<void> {
    if (!this.restartRuns || this.isShuttingDown) return
    for (const saved of this.restartRuns.list()) {
      if (!restartRecoveryEnabled()) {
        this.restartRuns.remove(saved.sessionId, saved.runId)
        continue
      }
      const clientPromptId = `restart:${saved.runId}`
      if (this.requestQueue.hasPrompt(saved.sessionId, clientPromptId)) {
        if (saved.queueId) this.requestQueue.remove(saved.sessionId, saved.queueId)
        continue
      }
      const settled = await settledSessionIds([saved.sessionId])
      if (settled.has(saved.sessionId) || this.isShuttingDown) {
        this.restartRuns.remove(saved.sessionId, saved.runId)
        continue
      }
      const sourceThread = saved.input.agentSessionId
      if (await organizationOfSession(sourceThread ?? saved.sessionId) !== LOCAL_ORGANIZATION_ID) {
        this.restartRuns.remove(saved.sessionId, saved.runId)
        continue
      }
      const lineage = resolveSessionLineageById(saved.sessionId)?.active
      const error = restartContinuationError(saved, hostUser(), lineage)
      if (this.restartRuns.get(saved.sessionId)?.runId !== saved.runId) continue
      if (saved.state !== 'delivering' && !this.restartRuns.claim(saved)) continue
      this._queueRestartContinuation(saved, error)
    }
  }

  private _queueRestartContinuation(saved: RestartRun, error?: string): void {
    // A delivering receipt without a queue entry is uncertain, never resent
    // automatically. The queue itself has its own durable start receipt.
    const prompt = restartContinuationPrompt(saved)
    const actor: Actor = saved.author === null ? HOST_ACTOR : {
      principal: { kind: 'local-owner', deviceId: null, deviceLabel: 'Host restart recovery' }, user: saved.author,
    }
    const input: SessionRunInput = { ...saved.input, forked: false,
      agentSessionId: saved.input.agentSessionId, permissionMode: this.sessionPermissionModes.get(saved.sessionId) ?? saved.input.permissionMode }
    const entry: QueuedRequest = {
      queueId: crypto.randomUUID(), sessionId: saved.sessionId, prompt, enqueuedAt: Date.now(), reason: 'busy',
      held: !!error, error, author: saved.author ?? undefined, revision: 0,
      run: { sessionId: saved.sessionId, target: { kind: 'session', sessionId: saved.sessionId }, input,
        runId: crypto.randomUUID(), tools: [], actor,
        options: { prompt, displayPrompt: prompt, clientPromptId: `restart:${saved.runId}`, promptSource: 'agent', taskId: saved.taskId } },
      resolve() {}, reject() {},
    }
    try {
      this.requestQueue.enqueue(entry, 'first')
      if (saved.queueId) this.requestQueue.remove(saved.sessionId, saved.queueId)
      this._publishQueue(saved.sessionId)
      log.info('restart_continuation_queued', { sessionId: saved.sessionId, sourceRunId: saved.runId, held: !!error })
      if (!error) this._processQueueForSession(saved.sessionId)
    } catch (saveError) {
      log.error('restart_continuation_save_failed', { sessionId: saved.sessionId, error: String(saveError) })
      throw saveError
    }
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
      /** The person behind a shared prompt; an agent's own follow-up has none. */
      actor?: Actor
      /** The orchestrator's exchanges this prompt answers. On the run before the
       *  run is accepted, so a reply that comes back at once is never lost. */
      exchangeIds?: string[]
      reportExchangeIds?: string[]
    },
  ): Promise<{ disposition: SessionRunLifecycle['disposition']; queueId?: string }> {
    const { permissionMode, actor, exchangeIds, reportExchangeIds, ...promptOrigin } = origin ?? {}
    const { sessionId, input } = await this._unattendedRunInput(agentSessionId)
    if (permissionMode) input.permissionMode = permissionMode
    await this.seatForTurn(actor, input.provider)
    const lifecycle = await this.runTurn({
      input,
      target: { kind: 'session', sessionId },
      sessionId,
      actor,
      exchangeIds,
      reportExchangeIds,
      tools: selectAgentTools(
        solusToolbox.works,
        solusToolbox.docs,
        solusToolbox.artifact,
        solusToolbox.automations,
        solusToolbox.watches,
        solusToolbox.connections,
        solusToolbox.insights,
        solusToolbox.intelligence,
        solusToolbox.browser,
        solusToolbox.devices,
        solusToolbox.sessions,
        solusToolbox.tasks,
        solusToolbox.config,
      ),
      options: { prompt, displayPrompt: prompt, delivery, promptSource: 'agent', ...promptOrigin },
    })
    return { disposition: lifecycle.disposition, queueId: lifecycle.queueId }
  }

  /**
   * Stop the background tasks a session's agent left running, and nothing else:
   * the agent's turn is already settled, so this is not an interrupt. Each task
   * settles through the provider's own events, and the session leaves
   * 'background' through the usual turn that follows.
   */
  async stopBackgroundTasks(id: string): Promise<boolean> {
    const sessionId = this._sessionIdFor(id)
    const session = sessionId ? this.activeSessions.get(sessionId) : undefined
    const agentSessionId = session?.agentSessionId
    const taskIds = [...(session?.backgroundTaskIds ?? [])]
    if (!session || !agentSessionId || taskIds.length === 0) return false
    const backend = this._backendFor(session.backendId)
    const stopBackgroundTask = backend.stopBackgroundTask?.bind(backend)
    if (!stopBackgroundTask) return false
    log.info('background_tasks_stop_requested', { sessionId, taskIds })
    this.restartRuns?.remove(sessionId!)
    const stopped = await Promise.all(taskIds.map((taskId) => stopBackgroundTask(agentSessionId, taskId)))
    return stopped.some(Boolean)
  }

  /**
   * Interrupt a session, whichever id the caller holds: the renderer's Stop
   * passes Solus's, an MCP `stop_session` passes the provider thread it read off
   * disk. Covers every phase — a queue waiting its turn, a worktree still being
   * prepared, a live provider turn, and a run that has not reached session_init.
   * A person's stop is recorded as a `stopped` activity, inside the turn it ended.
   */
  stopSession(id: string, actor: Actor): boolean {
    const sessionId = this._sessionIdFor(id)
    if (!sessionId) return false
    this.restartRuns?.remove(sessionId)
    for (const entry of [...(this.requestQueue.get(sessionId) ?? [])]) {
      if (entry.run.options.clientPromptId?.startsWith('restart:')) this.requestQueue.remove(sessionId, entry.queueId)
    }
    this._publishQueue(sessionId)
    const stopped = (): void => {
      // Recorded before the status settles the turn, so it carries that turn's id.
      if (actor.user) void this.recordActivity({ kind: 'session', id: sessionId }, actor, { kind: 'stopped' })
      this._setStatus(sessionId, 'interrupted')
    }

    // Stop ends the running turn only (plan 004 D12). Queued prompts, other
    // people's included, stay, and the next one starts when this turn exits.
    const queuedRunIds = new Set((this.requestQueue.get(sessionId) ?? []).flatMap((req) => req.run.runId ? [req.run.runId] : []))
    this.orchestration?.targetStopped(sessionId, queuedRunIds)
    this.failedSetupPrompts.delete(sessionId)

    // Worktree creation happens before a backend RunHandle exists. Cancel it
    // first or Stop would report failure while setup continued into a new run.
    const setupController = this.pendingSetupControllers.get(sessionId)
    if (setupController) {
      // The prompts queued behind it were written for the worktree that now
      // never exists; run in the project folder they would do something else.
      this._drainQueue(sessionId)
      setupController.abort(new Error('Interrupted'))
      this.pendingSetupControllers.delete(sessionId)
      this.sessionEmitter.recordTerminal(sessionId, 'interrupted')
      stopped()
      return true
    }

    const session = this.activeSessions.get(sessionId)
    // 'background' is the way out of a task that never settles: cancelling the
    // query is what ends the work the agent left running.
    if (session?.agentSessionId && (isSessionBusyStatus(session.status) || session.status === 'background')) {
      const cancelled = this._backendFor(session.backendId).cancelSession(session.agentSessionId)
      if (cancelled) {
        this.sessionEmitter.recordTerminal(sessionId, 'interrupted')
        stopped()
        return true
      }
    }

    // Fall back to pre-session_init handles owned by any backend.
    for (const backend of this.backends.values()) {
      const handle = backend.getPendingHandles().find((h) => h.sessionId === sessionId)
      if (!handle) continue
      handle.abortController.abort()
      this.sessionEmitter.recordTerminal(sessionId, 'interrupted')
      stopped()
      return true
    }

    // Nothing of its own is running: a session held open only by waiting on
    // the sessions it sent work to stops waiting.
    if (this.orchestration?.cancelSentBy(sessionId)) {
      stopped()
      return true
    }

    return false
  }

  /**
   * Start a fresh background session running `prompt` on the given agent/model —
   * the entry for the `start_session` MCP tool. Builds a plain run input with no
   * client watching it and routes through `runTurn`, resolving once the new
   * session has initialized and returning its id. The caller renders a card,
   * which watches the session when a user opens it.
   */
  async createSession(req: CreateSessionRequest, actor?: Actor): Promise<{ agentSessionId: string; taskId?: string }> {
    // No seat, no session: refused before anything is spawned (Step 2 plan §3.3).
    await this.seatForTurn(actor, req.provider)
    const parentId = req.delegation ? this._sessionIdFor(req.delegation.parentAgentSessionId) : undefined
    const parentMode = parentId ? this.activeSessions.get(parentId)?.runInput?.permissionMode ?? this.sessionPermissionModes.get(parentId) : undefined
    if (req.delegation && !parentMode) throw new Error('The parent permission policy is unavailable. Start the child from an active parent turn.')
    // A child works for the person its parent works for, with that person's preferences.
    const preferences = req.executionPreferences ?? sessionSettings(parentId)?.preferences ?? (parentId ? await sessionExecutionPreferences(parentId) : undefined)
    const permissionMode = parentMode
      ? childPermissionMode(parentMode, req.permissionMode)
      : req.permissionMode ?? preferences?.defaultPermissionMode ?? DEFAULT_EXECUTION_PREFERENCES.defaultPermissionMode
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
      permissionMode,
      rateLimitBehavior: 'queue',
      ...instructionsFor(preferences, model),
      executionPreferences: preferences,
    }
    const sessionId = req.sessionId ?? crypto.randomUUID()
    const delegation = req.delegation
      ? {
          // The index keys sessions by provider thread; so does the parent link.
          parentSessionId: req.delegation.parentAgentSessionId,
          messageId: req.delegation.messageId,
          intent: req.delegation.intent,
          createdAt: req.delegation.createdAt,
        }
      : undefined
    const lifecycle = await this.runTurn({
      input,
      target: { kind: 'new-session' },
      sessionId,
      actor,
      exchangeIds: req.exchangeIds,
      delegation,
      tools: selectAgentTools(
        solusToolbox.works,
        solusToolbox.docs,
        solusToolbox.artifact,
        solusToolbox.automations,
        solusToolbox.watches,
        solusToolbox.connections,
        solusToolbox.insights,
        solusToolbox.intelligence,
        solusToolbox.browser,
        solusToolbox.devices,
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
    /** The automation's captured preferences (plans/018 §6); absent means the built-in defaults. */
    executionPreferences?: ExecutionPreferences
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
      // The automation default.
      permissionMode: 'full-access',
      rateLimitBehavior: 'queue',
      ...unattendedModelInputFor(req.provider, req.modelId, req.executionPreferences),
      executionPreferences: req.executionPreferences,
    }
    const lifecycle = await this.runTurn({
      input,
      target: { kind: 'new-session' },
      sessionId: crypto.randomUUID(),
      tools: selectAgentTools(
        solusToolbox.works,
        solusToolbox.docs,
        solusToolbox.artifact,
        solusToolbox.watches,
        solusToolbox.connections,
        solusToolbox.insights,
        solusToolbox.intelligence,
        solusToolbox.browser,
        solusToolbox.devices,
        solusToolbox.sessions,
        solusToolbox.tasks,
        solusToolbox.config,
      ),
      options: {
        prompt: req.prompt,
        promptSource: 'automation',
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
    await this._useTaskLeadPreferences(request)
    await this._settleRunOrganization(request)
    // Every prepared/initialized view of a run shares this one exchange array.
    // The request is copied while setup resolves, but ownership must not be.
    request.exchangeIds ??= []
    request.runId ??= crypto.randomUUID()
    if (request.reportExchangeIds?.length) this.orchestration?.reportsAccepted(request.reportExchangeIds)
    // Before launch: the provider can report this turn's own plan before the
    // launch step returns, and that plan must survive.
    this.orchestration?.sessionTurnStarted(request.sessionId)
    const runStartedAt = Date.now()
    const promptSource = request.options.promptSource ?? 'typed'
    // Read before dispatch: Auto routing overwrites the model with the one it
    // picked, and the turn must still say what was asked for. `model`, not
    // `preferredModel`: the preference is the session's stored choice, which
    // outlives a switch of provider, while `model` is the choice resolved
    // against the provider this turn runs on.
    const requestedModel = request.input.model || undefined
    // The session's organization and the acting account ride every span of the
    // turn (organization-scope §6.1); the organization is the record's, read
    // once here, never a window's later choice.
    const organizationId = await this._turnOrganization(request.sessionId)
    this._saveRestartRun(request, organizationId)
    const account = insightsAccountOf(request.actor)
    let actor: { userId: string; email?: string } | undefined
    if (account) {
      actor = { userId: userKey(account.id) }
      if (account.email) actor.email = account.email
    }
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
      actor,
      organizationId,
    })
    let startedRun: StartedRun
    try {
      startedRun = await this.sessionEmitter.runDispatch(
        request.sessionId,
        'launch_run',
        { promptSource, fn: '_launchRun', file: 'session-runtime.ts' },
        () => this._launchRun(request, turnTraceId),
      )
    } catch (error) {
      if (!this.isShuttingDown) this.restartRuns?.remove(request.sessionId, request.runId)
      const interrupted = error instanceof Error && error.message === 'Interrupted'
      this.sessionEmitter.finishTurn(request.sessionId, interrupted ? 'interrupted' : 'failed', Date.now(), turnTraceId)
      this._cancelRunExchanges(request, interrupted ? 'interrupted' : 'failed')
      throw error
    }
    const { handle, run } = startedRun
    const startedExchanges = this._runExchanges(request, handle.agentSessionId)
    // The provider can refuse the turn on a limit before its launch finishes
    // reporting; a parked run has not started, and its release starts it again.
    const parkedBeforeStart = this.activeSessions.get(request.sessionId)?.status === 'rate_limited'
    if (startedExchanges && !parkedBeforeStart) this.orchestration?.runStarted(startedExchanges)
    // Its own scope: this runs after `launch_run` resolved, so there is no
    // ambient step left to nest under — but it is still inside the setup
    // window, being awaited before setup is closed below.
    const turnTask = await this.sessionEmitter.runDispatch(
      request.sessionId,
      'task_dimension',
      { taskId: run.options.taskId ?? '', fn: '_turnTask', file: 'session-runtime.ts' },
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
      organizationId: await this._turnOrganization(request.sessionId),
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
    // A provider limit ends this attempt, but the prompt is still owned by Solus
    // while it waits for a reset or a user decision. Its senders are not told it
    // ended: the exchanges move with the parked queue entry, which shares their
    // ids, or stay open until the user chooses what to do. Codex ends such a
    // turn normally and Claude with an error, so both endings ask. A limit that
    // defers to the next send leaves this turn to finish, like the exit handler.
    const isParkedRateLimit = (): boolean => {
      const limit = this._currentRateLimitEvent(settledSessionId)
      return !!limit && limit.deferCurrentRun !== true
        && (request.input.rateLimitBehavior === 'ask' || request.input.rateLimitBehavior === 'queue')
    }
    const done = handle.runPromise.then(
      () => {
        const fallback = handle.abortController.signal.aborted ? 'interrupted' as const : 'completed' as const
        const status = this.sessionEmitter.finishTurn(settledSessionId, fallback, Date.now(), turnTraceId)
        captureSettledRun(status)
        if (!isParkedRateLimit()) {
          this._settleRunExchanges(request, status, handle, {
            durationMs: Date.now() - runStartedAt,
            toolCallCount: handle.toolCallCount,
          })
        }
        return handle.resultText ? { output: handle.resultText } : {}
      },
      (error) => {
        const fallback = handle.abortController.signal.aborted ? 'interrupted' as const : 'failed' as const
        const status = this.sessionEmitter.finishTurn(settledSessionId, fallback, Date.now(), turnTraceId)
        captureSettledRun(status)
        if (!isParkedRateLimit()) {
          this._settleRunExchanges(request, status, handle, {
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
        if (handle.agentSessionId && this.stopSession(handle.agentSessionId, HOST_ACTOR)) return
        handle.abortController.abort()
      },
      disposition: 'started',
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

  /**
   * True while a pause of the machine would lose work (plan 004 item 3): work runs,
   * or a permission, question or plan waits for a person. Wider than hasActiveWork:
   * a paused Sprite that loses its memory also loses the waiting request. A
   * rate-limit wait is not held; it can last hours and a wake-up request resumes it.
   */
  hasWorkToKeepAwake(): boolean {
    if (this.hasActiveWork() || this.hasWorkForUpdate()) return true
    for (const session of this.activeSessions.values()) {
      if (session.status === 'awaiting_input' || session.status === 'awaiting_plan') return true
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
    const requestedInput = { ...run.input }
    const target = this.requestQueue.lastSwitchInput(metadata.sessionId)
    if (target) {
      run.input = { ...run.input, provider: target.provider, agentSessionId: null, model: target.model,
        preferredModel: target.preferredModel, reasoningEffort: target.reasoningEffort,
        contextWindow: target.contextWindow, fastMode: target.fastMode }
    }
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
    if (run.actor?.user) queuedEvent.author = run.actor.user

    let resolveDone!: () => void
    let rejectDone!: (reason: Error) => void
    const queuedDone = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    this.requestQueue.enqueue({
      queueId,
      prompt,
      sessionId: queueKey,
      deviceId: metadata.deviceId,
      run,
      requestedInput,
      reason: metadata.reason,
      sourceSessionId: metadata.sourceSessionId,
      rateLimitSessionId: metadata.rateLimitSessionId,
      releaseAt: metadata.releaseAt,
      rateLimitType: metadata.rateLimitType,
      resolve: resolveDone,
      reject: rejectDone,
      enqueuedAt,
    })

    this._emit(queueKey, queuedEvent)
    this._publishQueue(queueKey)
    const queuedExchanges = this._runExchanges(run)
    if (queuedExchanges) this.orchestration?.runQueued(queuedExchanges)

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

  private async _launchRun(request: SessionRunRequest, turnTraceId: string): Promise<StartedRun> {
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
          { requestedModel: AUTO_MODEL_ID, fn: 'routeModelPrompt', file: 'session-runtime.ts' },
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
            const routing = input.executionPreferences?.modelRouting ?? DEFAULT_EXECUTION_PREFERENCES.modelRouting
            const route = await routeModelPrompt(options.displayPrompt ?? options.prompt, routing, available, controller.signal, {
              spent: provider => this.usageLimits.isSpent(provider),
            })
            annotate({ provider: route.provider, modelId: route.modelId, category: route.category, usedFallback: route.usedFallback })
            return route
          },
        )
        // The sender's instructions stay; only the routed model's own ones change.
        Object.assign(input, unattendedModelInputFor(route.provider, route.modelId, input.executionPreferences ?? { extraInstructions: input.extraInstructions }), {
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
    // A fork is a new session branching from another's thread. A move into a
    // worktree forks the session's own active thread and stays the same
    // session; its handler records the move (plans/012 §5).
    if (isForkingInput && input.agentSessionId && !activeLineage?.providerSessionId) {
      await this.recordActivity({ kind: 'session', id: sessionId }, request.actor ?? HOST_ACTOR, forkedFrom(input.agentSessionId, input.forkExcludeLatestTurn))
    }
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
        { projectPath: resolvedProjectPath, fn: 'computeGitState', file: 'session-runtime.ts' },
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
            file: 'session-runtime.ts',
          },
          async (annotate) => {
            // `createWorktree` records its own git commands under this step
            // through the ambient context — it takes no telemetry argument.
            // It starts on a temporary branch; `nameWorktreeBranch` names it
            // while the agent works, so the prompt never waits on a model.
            const created = await this.checkouts.create(resolvedProjectPath, worktreeBaseBranch, {
              signal: setupController.signal,
              naming: input.executionPreferences?.worktreeBranchNaming,
            })
            annotate({ branch: created.branch ?? '', targetBranch: created.targetBranch, worktreePath: created.worktreePath ?? '' })
            return created
          },
        )
        if (existingSession) existingSession.gitContext = gitContext
        effectiveGitCtx = gitContext
        log.info('worktree_created', { sessionId, branch: gitContext.branch, worktreePath: gitContext.worktreePath })
        captureServerEvent('worktree_created', {})
        this._emit(sessionId, { type: 'git_context', gitContext })
        void this.nameWorktreeBranch(sessionId, gitContext, options.prompt, request.actor, input.executionPreferences)
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

    if (effectiveGitCtx?.worktreePath) {
      const current = await this.checkouts.refresh(effectiveGitCtx.worktreePath)
      if (!current.checkout) throw new Error('The session worktree is no longer available')
      effectiveGitCtx = current.checkout
    }
    const useWorktree = !!effectiveGitCtx?.worktreePath
    const effectiveCwd = useWorktree ? effectiveGitCtx!.worktreePath! : resolvedProjectPath

    // Start mirroring this repo's HEAD/refs/index now that the session's git
    // context is settled, so external branch/commit/stage changes flow back
    // live. The checkout service installs filesystem watchers when a client
    // holds a foreground lease; headless runs still share current identity.
    this.setSessionGitEnvironment(sessionId, effectiveCwd, effectiveGitCtx)
    effectiveGitCtx = this.getGitContext(sessionId) ?? effectiveGitCtx

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
          file: 'session-runtime.ts',
        },
        async (annotate) => {
          const handoff = await this.handoffBuilder(pendingHandoff.fromSessionId, resolvedProjectPath, {
            fromProvider: pendingHandoff.fromProvider, targetProvider: input.provider, targetModel: input.model,
            contextWindow: input.contextWindow, nextPrompt: options.prompt + input.extraInstructions,
            historyTokens: input.executionPreferences?.handoffHistoryTokens ?? DEFAULT_EXECUTION_PREFERENCES.handoffHistoryTokens,
            sourceStatus: this.handoffCarry.get(pendingHandoff.fromSessionId)?.status ?? this.activeSessions.get(sessionId)?.status,
            loadSession: async (threadId, loadProjectPath) => this.handoffCarry.merge(threadId, await this.loadSession(
              pendingHandoff.fromProvider, threadId, loadProjectPath)),
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
    // A session that ran outside Solus first has no Solus id until it is
    // resumed here. What PR sync wrote under its provider thread moves to the
    // session.
    if (dispatchAgentSessionId) {
      await rekeySessionPullRequests(dispatchAgentSessionId, sessionId)
      await rekeySessionState(dispatchAgentSessionId, sessionId)
    }
    // A prompt is work: a settled or snoozed session is active again.
    await recordSessionPrompt(sessionId)

    // A session never makes a task of its own: a prompt that names no task
    // runs with none (docs/plans/task-conversation.md, decision 8). A provider
    // handoff is a new backend conversation of the same Solus session, so it
    // stays under the task the session has.
    if (pendingHandoff && !options.taskId) {
      const existingTask = await dispatchStep('task_lookup', {
        fn: 'tasksForSession',
        file: 'session-runtime.ts',
      }, async (annotate) => {
        const found = await tasksForSession(ANY_ORGANIZATION, sessionId)
        annotate({ taskId: found?.task.id ?? '' })
        return found
      })
      if (existingTask) options.taskId = existingTask.task.id
    }
    // Bind the task the prompt names, when this host holds it. A shipped
    // snapshot marks the task as foreign: its row lives on another host, where
    // the dispatching client bound it.
    const boundTaskId = options.taskSnapshot ? undefined : options.taskId
    if (boundTaskId) {
      await dispatchStep('task_prepare', {
        projectKey: resolvedProjectPath ?? '',
        branch: effectiveGitCtx?.branch ?? '',
        taskId: boundTaskId,
        fn: 'sessionTaskPreparer',
        file: 'session-runtime.ts',
      }, async (annotate) => {
        const prepared = await this.sessionTaskPreparer(ANY_ORGANIZATION, {
          // A session with a provider conversation is past its first dispatch.
          // A provider handoff is a new backend conversation, not a new Solus
          // session, so the prior provider id counts. A fork carries its
          // source's id purely to branch from, and the provider starts a fresh
          // conversation for it — so it is a first dispatch.
          existingAgentSessionId: isForkingSession
            ? null
            : effectiveInput.agentSessionId ?? pendingHandoff?.fromSessionId ?? null,
          taskId: boundTaskId,
          projectKey: resolvedProjectPath,
        })
        annotate({ bound: !!prepared })
        return prepared
      })
    }
    // The task packet is scaffolding the agent works from, not something the
    // user typed, so it rides the system prompt rather than the transcript. As
    // a prompt prefix it was read back as the user's own turn on reload, and a
    // session's whole history folds behind one row when its first turn has no
    // user message to lead it. The packet holds no live task state, so it stays
    // the same from turn to turn; the agent reads that state with read_task.
    if (options.taskId) {
      const context = await dispatchStep('task_context', {
        taskId: options.taskId,
        fn: '_taskSystemContext',
        file: 'session-runtime.ts',
      }, async (annotate) => {
        const composed = await this._taskSystemContext(options.taskId!, options.taskSnapshot ?? null, sessionId, options.taskRole, effectiveInput.executionPreferences)
        annotate({ contextChars: composed.length })
        return composed
      })
      options.systemPrompt = [options.systemPrompt, context].filter(Boolean).join('\n\n')
    } else {
      setForeignTaskSnapshot(sessionId, null)
    }
    // A turn that answers another session's message ends with what that session
    // needs to act on, since its last message is what comes back.
    if (request.exchangeIds?.length) {
      options.systemPrompt = [options.systemPrompt, ANSWERING_ANOTHER_SESSION].filter(Boolean).join('\n\n')
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
            file: 'session-runtime.ts',
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
      if (this.isShuttingDown) throw new Error('Interrupted')
      const savedRestart = this.restartRuns?.get(sessionId)
      if (savedRestart && savedRestart.runId === request.runId) {
        this.restartRuns?.save({ ...savedRestart, input: effectiveInput, state: 'running' })
      }
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
        file: 'session-runtime.ts',
      }, () => this.runAgent({
        provider,
        prompt: options.prompt,
        cwd: effectiveCwd,
        tools: credentialScopedAgentTools([
          ...request.tools,
          // The other backend's subagent runs on the turn author's own login.
          (provider === 'codex' ? createClaudeSubagentAgentTool : createCodexSubagentAgentTool)(
            this,
            (subagentProvider) => this.seatForTurn(request.actor, subagentProvider),
          ),
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
        // Empty when tracing is off; the snapshot then records no trace.
        turnTraceId: turnTraceId || undefined,
      }))
      handle = agentRun.handle
      handle.sessionId = sessionId
      const launchedRestart = this.restartRuns?.get(sessionId)
      if (launchedRestart && launchedRestart.runId === request.runId && handle.agentSessionId) {
        this.restartRuns?.save({ ...launchedRestart, input: { ...launchedRestart.input, agentSessionId: handle.agentSessionId }, state: 'running' })
      }
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
        return { id: options.taskId, title: (await Task.byId(ANY_ORGANIZATION, options.taskId)).title }
      } catch {
        return { id: options.taskId }
      }
    }
    const agentSessionId = run.input.agentSessionId
    if (!agentSessionId) return null
    try {
      const task = await Task.forSession(ANY_ORGANIZATION, agentSessionId)
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
      await (await Task.byId(ANY_ORGANIZATION, taskId)).linkSession(sessionId, run.options.taskRole ?? 'working', {
        originSessionId: sessionId,
      })
    } catch (err) {
      log.error('task_session_link_failed', { taskId, sessionId, error: String(err) })
    }
  }

  /**
   * The packet appended to the run's system prompt: the task's id and title and
   * the work contract. The agent reads the task itself with `read_task`. When
   * the task is foreign, the snapshot the dispatching client shipped is held
   * for the session so `read_task` (and op overlays) answer from it.
   *
   * The session's role decides whether the lead contract is appended. On the
   * first prompt the link is not written yet, so the role rides the prompt;
   * on every later turn the session's own link answers.
   */
  private async _taskSystemContext(
    taskId: string,
    shipped: TaskSnapshot | null,
    sessionId: string,
    promptRole: 'lead' | undefined,
    preferences: ExecutionPreferences | undefined,
  ): Promise<string> {
    // The person's lead and lifecycle preferences.
    const lifecyclePolicy = preferences?.agentTaskLifecyclePolicy ?? DEFAULT_EXECUTION_PREFERENCES.agentTaskLifecyclePolicy
    const lead = {
      leadInstructions: preferences?.leadInstructions ?? DEFAULT_EXECUTION_PREFERENCES.leadInstructions,
      workerModel: preferences?.workerModel ?? DEFAULT_EXECUTION_PREFERENCES.workerModel,
    }
    const roleOf = (sessions: readonly TaskSessionLink[]): TaskSessionRole =>
      promptRole ?? sessions.find((link) => link.sessionId === sessionId)?.role ?? 'working'
    if (shipped && shipped.details.task.id === taskId) {
      setForeignTaskSnapshot(sessionId, shipped)
      return formatTaskContext(shipped.details.task, lifecyclePolicy, roleOf(shipped.sessions), lead)
    }
    setForeignTaskSnapshot(sessionId, null)
    try {
      const local = await taskWithAttempts(ANY_ORGANIZATION, taskId)
      if (!local) throw new Error('task not found')
      return formatTaskContext(local.task, lifecyclePolicy, roleOf(local.attempts), lead)
    } catch (err) {
      // On a dispatch this once failed silently — the task's row lives on
      // another host. A taskId this host cannot read now always names a defect:
      // either the snapshot was not shipped or the local row is gone. The id
      // and the contract still reach the agent; read_task will say what failed.
      log.warn('task_context_injection_failed', { taskId, sessionId, shippedSnapshot: !!shipped, error: String(err) })
      return formatTaskContext({ id: taskId }, lifecyclePolicy, promptRole ?? 'working', lead)
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
      this.requestQueue.remove(sessionId, req.queueId)
      // A queued prompt never reaches the normal settlement path when Stop
      // drains it, so its sender would otherwise stay held forever.
      this._cancelRunExchanges(req.run)
      req.reject(reason)
      this._emit(req.sessionId, { type: 'prompt_dequeued', queueId: req.queueId })
      if (req.rateLimitSessionId) this._cleanupRateLimitTimerIfUnused(req.rateLimitSessionId)
      log.info('queued_request_drained', { queueId: req.queueId, sessionId })
    }
    this.requestQueue.save(sessionId)
  }

  agentQueue(providerSessionId: string): SessionQueueSnapshot {
    const sessionId = this._sessionIdFor(providerSessionId)
    if (!sessionId) throw new Error('The calling session is unavailable.')
    return { held: !!this.requestQueue.get(sessionId)?.some((entry) => entry.held), entries: this._queuedPromptsForSession(sessionId) }
  }

  async changeAgentQueue(providerSessionId: string, mutation: SessionQueueMutation): Promise<SessionQueueSnapshot> {
    if (mutation.kind === 'resume') throw new Error('Only the user can resume a held queue.')
    const { sessionId, input } = await this._unattendedRunInput(providerSessionId)
    const actor = this.activeRunRequests.get(sessionId)?.actor ?? HOST_ACTOR
    return this._changeSessionQueue(sessionId, input, sessionQueueMutationSchema.parse(mutation), actor)
  }

  sessionQueue(ctx: IpcContext): SessionQueueSnapshot {
    const sessionId = this._sessionIdForCtx(ctx)
    if (!sessionId) throw new Error('A session is required to read its queue.')
    return { held: !!this.requestQueue.get(sessionId)?.some((entry) => entry.held), entries: this._queuedPromptsForSession(sessionId) }
  }

  private _publishQueue(sessionId: string): void {
    this._emit(sessionId, { type: 'session_queue', held: !!this.requestQueue.get(sessionId)?.some((entry) => entry.held), entries: this._queuedPromptsForSession(sessionId) })
  }

  async sessionQueueChange(ctx: IpcContext, input: SessionQueueMutation, actor: Actor): Promise<SessionQueueSnapshot> {
    const sessionId = this._sessionIdForCtx(ctx)
    if (!sessionId) throw new Error('A session is required to change its queue.')
    return this._changeSessionQueue(sessionId, runInputFromContext(ctx), sessionQueueMutationSchema.parse(input), actor)
  }

  private async _changeSessionQueue(sessionId: string, sourceInput: SessionRunInput, mutation: SessionQueueMutation, actor: Actor): Promise<SessionQueueSnapshot> {
    if (mutation.kind === 'switch') {
      await this._queueProviderSwitch(sessionId, sourceInput, mutation, actor)
    } else if (mutation.kind === 'resume') {
      const entries = this.requestQueue.get(sessionId) ?? []
      if (entries.some((entry) => this.reservedQueueEntries.has(entry.queueId))) throw new Error('A queue change is still being applied. Try Resume after it finishes.')
      const resumable = entries.filter((entry) => {
        if (!entry.held) return false
        const author = entry.run.actor?.user ?? entry.author
        return author ? !!actor.user && sameUser(author.id, actor.user.id) : ['local-owner', 'remote-owner', 'system'].includes(actor.principal.kind)
      })
      if (!resumable.length && entries.some((entry) => entry.held)) throw new Error('Each author must resume their own queued work.')
      for (const entry of resumable) {
        entry.held = false
        entry.error = undefined
        entry.run.actor = actor
        entry.revision = (entry.revision ?? 0) + 1
      }
      this.requestQueue.save(sessionId)
      this._processQueueForSession(sessionId)
    } else {
      const entry = this.requestQueue.get(sessionId)?.find((item) => item.queueId === mutation.queueId)
      if (!entry || (entry.revision ?? 0) !== mutation.revision) {
        throw new Error('This queue entry changed or started. Refresh the queue before editing it.')
      }
      if (this.reservedQueueEntries.has(entry.queueId)) throw new Error('This queue entry is being delivered. Wait for the provider to answer.')
      await this._changeQueueEntry(entry, mutation, actor)
    }
    this._publishQueue(sessionId)
    return { held: !!this.requestQueue.get(sessionId)?.some((entry) => entry.held), entries: this._queuedPromptsForSession(sessionId) }
  }

  private async _changeQueueEntry(entry: QueuedRequest,
    mutation: Exclude<SessionQueueMutation, { kind: 'switch' | 'resume' }>, actor: Actor): Promise<void> {
    if (mutation.kind === 'remove') {
      this._cancelQueuedPrompt(entry.sessionId, entry.queueId, actor)
      this._processQueueForSession(entry.sessionId)
    } else if (mutation.kind === 'move') {
      this.requestQueue.move(entry.sessionId, entry.queueId, mutation.beforeQueueId)
      this._rebindQueue(entry.sessionId)
    } else if (mutation.kind === 'edit') {
      this.requestQueue.edit(entry, mutation)
      this._recordHeldPromptChange(entry, actor, 'edited')
    } else {
      if (entry.kind === 'provider_switch' || entry.held) throw new Error('Resume the queue before steering a prompt.')
      const active = this.activeSessions.get(entry.sessionId)
      if (!active?.agentSessionId || !isSteerableStatus(active.status)) throw new Error('There is no active turn to steer.')
      if (entry.run.input.provider !== active.backendId) throw new Error('A prompt cannot steer across a queued provider switch.')
      const author = entry.run.actor?.user ?? entry.author
      if (author && (!actor.user || !sameUser(author.id, actor.user.id))) throw new Error('Only its author can promote a prompt to steering.')
      // Reserve the entry while the provider answers. A concurrent edit cannot
      // change the text after it was sent, and a completed turn cannot drain it.
      entry.held = true
      entry.revision = (entry.revision ?? 0) + 1
      this.requestQueue.save(entry.sessionId)
      this._publishQueue(entry.sessionId)
      this.reservedQueueEntries.add(entry.queueId)
      let accepted: SessionRunLifecycle | null
      try {
        accepted = await this._steerActiveTurn({ ...entry.run, actor, options: { ...entry.run.options, delivery: 'steer' } }, active.agentSessionId, active)
        if (!accepted) throw new Error('The turn ended before steering was accepted. The prompt remains queued.')
      } catch (error) {
        entry.held = false
        this.requestQueue.save(entry.sessionId)
        this._publishQueue(entry.sessionId)
        throw error
      } finally { this.reservedQueueEntries.delete(entry.queueId) }
      this.requestQueue.remove(entry.sessionId, entry.queueId)
      this._emit(entry.sessionId, { type: 'prompt_dequeued', queueId: entry.queueId })
      void accepted.done.then(() => entry.resolve(), (error) => entry.reject(error))
    }
  }

  private async _queueProviderSwitch(sessionId: string, sourceInput: SessionRunInput, mutation: Extract<SessionQueueMutation, { kind: 'switch' }>, actor: Actor): Promise<void> {
    this.assertNewWorkAllowed()
    const backend = this._backendFor(mutation.provider)
    if (backend.metadata.available === false) throw new Error(backend.metadata.unavailableReason ?? 'This provider is unavailable on the host.')
    if (mutation.modelConfig.modelId === AUTO_MODEL_ID) throw new Error('Choose a specific model for a provider switch.')
    const modelId = mutation.modelConfig.modelId ?? backend.metadata.defaultModel
    const profile = MODEL_PROFILES[mutation.provider]?.[modelId]
    if (modelId && !profile && !backend.metadata.models.some((model) => model.id === modelId)) throw new Error('This model is unavailable for the selected provider.')
    if (profile && (!profile.reasoningLevels.includes(mutation.modelConfig.reasoningEffort)
      || mutation.modelConfig.fastMode && !profile.supportsFastMode
      || mutation.modelConfig.contextWindow !== null && !profile.contextWindows.includes(mutation.modelConfig.contextWindow))) {
      throw new Error('These options are unavailable for the selected model.')
    }
    let depth = 0
    for (const queue of this.requestQueue.values()) depth += queue.length
    if (depth >= MAX_QUEUE_DEPTH) throw new Error('Request queue full — back-pressure')
    const config = mutation.modelConfig
    const input = { ...sourceInput }
    input.provider = mutation.provider
    input.model = modelId
    input.preferredModel = modelId || null
    input.reasoningEffort = config.reasoningEffort
    input.contextWindow = config.contextWindow
    input.fastMode = config.fastMode
    const text = `Switch to ${mutation.provider}${config.modelId ? ` · ${config.modelId}` : ''}`
    const entry: QueuedRequest = {
      queueId: crypto.randomUUID(), sessionId, kind: 'provider_switch', prompt: text,
      enqueuedAt: Date.now(), reason: 'busy', held: true, resolve: () => {}, reject: () => {},
      run: { sessionId, target: { kind: 'session', sessionId }, input, tools: [], actor,
        options: { prompt: '', displayPrompt: text } },
    }
    // Reserve delivery order before the asynchronous seat check.
    this.requestQueue.enqueue(entry)
    this.reservedQueueEntries.add(entry.queueId)
    try { await this.seatForTurn(actor, mutation.provider) } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error)
      this.requestQueue.save(sessionId)
      this._publishQueue(sessionId)
      throw error
    } finally { this.reservedQueueEntries.delete(entry.queueId) }
    entry.held = false
    this.requestQueue.save(sessionId)
    this._publishQueue(sessionId)
    this._processQueueForSession(sessionId)
  }

  private _rebindQueue(sessionId: string): void {
    const active = this.activeSessions.get(sessionId)
    const first = this.requestQueue.get(sessionId)?.[0]
    const lineage = resolveSessionLineageById(sessionId)?.active
    const provider = active?.backendId ?? lineage?.provider
    const current = active?.runInput ?? (first && first.run.input.provider === provider ? first.run.input : first?.requestedInput ?? first?.run.input)
    if (current) this.requestQueue.rebind(sessionId, { ...current, provider: provider ?? current.provider,
      agentSessionId: active?.agentSessionId ?? lineage?.providerSessionId ?? current.agentSessionId })
  }

  private async _applyQueuedProviderSwitch(entry: QueuedRequest): Promise<void> {
    const sessionId = entry.sessionId
    this.applyingQueuedSwitch.add(sessionId)
    try {
      const target = entry.run.input
      const session = this.activeSessions.get(sessionId)
      const current = resolveSessionLineageById(sessionId)?.active
      const threadId = session?.agentSessionId ?? current?.providerSessionId ?? target.agentSessionId
      const sourceProvider = session?.backendId ?? current?.provider ?? getIndexedSession(threadId ?? '')?.provider
      if (sourceProvider && threadId && sourceProvider !== target.provider) {
        // Check the incoming budget before committing a provider change.
        await this.handoffBuilder(threadId, target.projectPath, {
          loadSession: async (id, path) => this.handoffCarry.merge(id, await this.loadSession(sourceProvider, id, path)),
          fromProvider: sourceProvider, targetProvider: target.provider, targetModel: target.model,
          contextWindow: target.contextWindow, nextPrompt: (this.requestQueue.get(sessionId)?.[0]?.run.options.prompt ?? '') + target.extraInstructions,
          historyTokens: target.executionPreferences?.handoffHistoryTokens ?? DEFAULT_EXECUTION_PREFERENCES.handoffHistoryTokens,
          sourceStatus: this.handoffCarry.get(threadId)?.status ?? session?.status,
        })
      }
      const result = sourceProvider === target.provider
        ? null : await this.switchSessionProvider(sessionId, target.provider, threadId, entry.run.actor ?? HOST_ACTOR)
      if (session) session.runInput = { ...target, agentSessionId: result ? result.restoredSessionId ?? null : threadId ?? null }
      this.requestQueue.settle(entry)
      this.requestQueue.rebind(sessionId, { ...target, agentSessionId: result ? result.restoredSessionId ?? null : threadId ?? null })
      this._emit(sessionId, { type: 'provider_switch_applied', provider: target.provider,
        modelConfig: { modelId: target.preferredModel, reasoningEffort: target.reasoningEffort, contextWindow: target.contextWindow, fastMode: target.fastMode }, result })
    } catch (error) {
      try { this.requestQueue.settle(entry, error instanceof Error ? error.message : String(error)) } catch (saveError) {
        this.requestQueue.holdUncertain(entry, `The host could not save the result. Check its history before resuming: ${String(saveError)}`)
        log.error('queue_settlement_save_failed', { sessionId, queueId: entry.queueId, error: String(saveError) })
      }
    } finally {
      this.applyingQueuedSwitch.delete(sessionId)
      this._publishQueue(sessionId)
      this._processQueueForSession(sessionId)
    }
  }

  cancelQueuedPrompt(ctx: IpcContext, queueId: string, actor: Actor): boolean {
    const sessionId = this._sessionIdForCtx(ctx)
    if (!sessionId) return false
    return this._cancelQueuedPrompt(sessionId, queueId, actor)
  }

  /** Callers outside the renderer name the session by its provider thread. */
  cancelQueuedPromptForSession(agentSessionId: string, queueId: string): boolean {
    const sessionId = this.agentSessionToSession.get(agentSessionId)
    if (!sessionId) return false
    return this._cancelQueuedPrompt(sessionId, queueId)
  }

  private _cancelQueuedPrompt(sessionId: string, queueId: string, actor?: Actor): boolean {
    const queue = this.requestQueue.get(sessionId)
    if (!queue) return false
    const idx = queue.findIndex((r) => r.queueId === queueId)
    if (idx === -1) return false
    this._cancelRunExchanges(queue[idx]!.run)
    const req = this.requestQueue.remove(sessionId, queueId)!
    this._rebindQueue(sessionId)
    req.reject(new Error('Cancelled by user'))
    this._emit(req.sessionId, { type: 'prompt_dequeued', queueId: req.queueId })
    this._recordHeldPromptChange(req, actor, 'removed')
    if (req.rateLimitSessionId) this._cleanupRateLimitTimerIfUnused(req.rateLimitSessionId)
    this.requestQueue.save(sessionId)
    this._publishQueue(sessionId)
    log.info('queued_request_cancelled', { queueId, sessionId })
    return true
  }

  /** Rewrite a prompt that is still waiting its turn. Both fields matter: the
   *  queue displays `displayPrompt ?? prompt`, the run sends `prompt`. */
  editQueuedPrompt(ctx: IpcContext, queueId: string, text: string, actor: Actor): boolean {
    const sessionId = this._sessionIdForCtx(ctx)
    return sessionId ? this._editQueuedPrompt(sessionId, queueId, text, actor) : false
  }

  private _editQueuedPrompt(sessionId: string, queueId: string, text: string, actor?: Actor, reports?: { reportExchangeIds?: string[]; exchangeIds?: string[] }): boolean {
    const trimmed = text.trim()
    if (!trimmed) return false
    const req = this.requestQueue.get(sessionId)?.find((r) => r.queueId === queueId)
    if (!req) return false

    if (this.reservedQueueEntries.has(req.queueId)) return false
    this.requestQueue.edit(req, { kind: 'edit', queueId, revision: req.revision ?? 0, text: trimmed }, reports)
    this._emit(req.sessionId, { type: 'prompt_queue_updated', queueId, text: trimmed })
    this._recordHeldPromptChange(req, actor, 'edited')
    this._publishQueue(sessionId)
    log.info('queued_request_edited', { queueId, sessionId })
    return true
  }

  /**
   * Someone removed or edited a prompt another person held (plan 004 D2): the
   * prompt's author and everyone else read who did it. A person changing their
   * own held prompt, and the host draining the queue, record nothing.
   */
  private _recordHeldPromptChange(req: QueuedRequest, actor: Actor | undefined, change: 'removed' | 'edited'): void {
    const by = actor?.user
    const author = req.run.actor?.user ?? undefined
    if (!actor || !by || (author && sameUser(by.id, author.id))) return
    const kind: ActivityKind = author
      ? { kind: 'queued_prompt_changed', queueId: req.queueId, change, author }
      : { kind: 'queued_prompt_changed', queueId: req.queueId, change }
    void this.recordActivity({ kind: 'session', id: req.sessionId }, actor, kind)
  }

  /** Re-submit the same prompt. If the session is dead, drop its provider
   *  thread so a fresh one starts. */
  async retry(ctx: IpcContext, options: PromptOptions, clientId: string | undefined, actor: Actor): Promise<void> {
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
      solusToolbox.watches,
      solusToolbox.connections,
      solusToolbox.insights,
      solusToolbox.intelligence,
      solusToolbox.browser,
      solusToolbox.devices,
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

  /**
   * Names whose turn raised a request or reached a limit (plan 004 F2): the
   * running turn's actor. The pending copy is the same object, so a client that
   * joins later reads the name on the replay too. Live only; the host's own work
   * names no one.
   */
  private _stampTurnAuthor(sessionId: string, event: NormalizedEvent): void {
    if (event.type !== 'permission_request' && event.type !== 'question_request' && event.type !== 'rate_limit') return
    const author = this.activeRunRequests.get(sessionId)?.actor?.user
    if (author) event.turnAuthor = author
  }

  /** Says what was chosen on the provider's report of the answer. Who chose it is an activity of its own. */
  private _nameDecision(event: Extract<NormalizedEvent, { type: 'permission_resolved' }>): void {
    const decision = this.permissionAnswers.get(event.questionId)
    this.permissionAnswers.delete(event.questionId)
    event.decision ??= decision
  }

  /** Answers a permission `askingSessionId` is waiting on. The answer goes to
   *  that session only: a question id that session is not waiting on — another
   *  session's, one already answered, or one from a turn that ended — is refused. */
  respondToPermission(askingSessionId: string, questionId: string, optionId: string, updatedPlan: string | undefined, actor: Actor): boolean {
    const pending = this._pendingQuestion(askingSessionId, questionId)
    if (!pending) return false
    const { sessionId, backend: b, event: pendingEvent } = pending
    const pendingInfo = b.permissions.getPendingInfo(questionId)
    if (!b.permissions.respondToPermission(questionId, optionId, updatedPlan)) return false
    // Codex reports the resolution later (`serverRequest/resolved`); it carries
    // what was chosen. Claude reports none, so the host says it now. Who decided
    // is recorded once, as activity every client reads (plan 004 F4, plans/012 §5).
    const decision = permissionDecisionFor(pendingEvent, optionId)
    if (b.id === 'codex') { if (decision) this.permissionAnswers.set(questionId, decision) }
    else this._emit(sessionId, { type: 'permission_resolved', questionId, decision })
    if (decision && actor.user) {
      const tool = pendingInfo?.toolName ?? (pendingEvent.type === 'permission_request' ? pendingEvent.toolName : 'a permission request')
      void this.recordActivity({ kind: 'session', id: sessionId }, actor, { kind: 'permission_decided', questionId, tool, decision })
    }
    this.sessionEmitter.resolvePermission(sessionId, questionId, optionId)
    // Before a rejection cancels the run and its exchanges settle.
    const resolved = permissionAnswer(pendingEvent, pendingInfo?.toolName, optionId, updatedPlan)
    this._reportToActiveRun(sessionId, (run) => this.orchestration?.inputResolved(run, resolved))
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
      if (agentSessionId) b.cancelSession(agentSessionId)
      // A rejected plan is not a stop, so the status names no stopper.
      this._setStatus(sessionId, 'interrupted')
    }
    return true
  }

  /** Answers a question `askingSessionId` is waiting on; refused like a permission. */
  async respondToQuestion(askingSessionId: string, questionId: string, answers: Record<string, string>, actor: Actor): Promise<boolean> {
    const sessionId = this._sessionIdFor(askingSessionId) ?? askingSessionId
    const asyncQuestion = claimAsyncQuestion(sessionId, questionId)
    if (asyncQuestion) {
      const answer = { questionId, questions: asyncQuestion.questions, answers }
      const reply = questionReply(answer)
      if (!reply) {
        settleAsyncQuestion(questionId, 'dismissed')
        this._emit(sessionId, { type: 'permission_resolved', questionId })
        const agentSessionId = asyncQuestion.agentSessionId
        this._syncAttention(agentSessionId, sessionId, this.activeSessions.get(sessionId)?.status ?? 'completed')
        return true
      }
      try {
        saveAsyncAnswer(questionId, answers)
        await this.promptSession(asyncQuestion.agentSessionId, reply, 'steer', { actor, via: 'question-answer' })
      } catch (error) {
        settleAsyncQuestion(questionId, 'pending')
        throw error
      }
      settleAsyncQuestion(questionId, 'answered')
      this._syncAttention(asyncQuestion.agentSessionId, sessionId, this.activeSessions.get(sessionId)?.status ?? 'completed')
      this._emit(sessionId, {
        type: 'question_answered',
        answer,
        timestamp: Date.now(),
      })
      if (actor.user) void this.recordActivity({ kind: 'session', id: sessionId }, actor, { kind: 'question_answered', questionId })
      return true
    }
    const pending = this._pendingQuestion(askingSessionId, questionId)
    if (!pending || pending.event.type !== 'question_request') return false
    const { sessionId: pendingSessionId, backend: b, event: question } = pending
    if (!b.permissions.respondToQuestion(questionId, answers)) return false
    this._reportToActiveRun(pendingSessionId, (run) => this.orchestration?.inputResolved(run, { kind: 'question', questions: question.questions, answers }))
    this.sessionEmitter.resolveQuestion(pendingSessionId, questionId)
    if (!question.kind || question.kind === 'standard') {
      this._emit(pendingSessionId, {
        type: 'question_answered',
        answer: { questionId, questions: question.questions, answers },
        timestamp: Date.now(),
      })
      if (actor.user) void this.recordActivity({ kind: 'session', id: pendingSessionId }, actor, { kind: 'question_answered', questionId })
    }
    this._clearPendingInputEvent(questionId)
    this.questionIdToSession.delete(questionId)
    return true
  }

  /** The request `askingSessionId` is waiting on under `questionId`, with the
   *  backend that answers it. Null unless that live session holds it now. */
  private _pendingQuestion(
    askingSessionId: string,
    questionId: string,
  ): { sessionId: string; backend: AgentBackend; event: NormalizedEvent } | null {
    const sessionId = this._sessionIdFor(askingSessionId)
    const owner = this.questionIdToSession.get(questionId)
    if (!sessionId || owner !== sessionId) {
      log.warn('answer_refused', { askingSessionId, questionId, ownerSessionId: owner ?? null, reason: owner ? 'other_session' : 'not_pending' })
      return null
    }
    const session = this.activeSessions.get(sessionId)
    const event = session?.pendingInputEvents.find((pendingEvent) => eventHasQuestionId(pendingEvent, questionId))
    const backend = session ? this.backends.get(session.backendId) : undefined
    if (!event || !backend) {
      log.warn('answer_refused', { askingSessionId, questionId, ownerSessionId: owner, reason: 'not_pending' })
      return null
    }
    return { sessionId, backend, event }
  }

  /** Apply Queue to prompts already held when a client whose person chose Queue
   * rejoins. Unattended runs keep the policy supplied by their owner. */
  queueHeldRateLimitedPrompts(behavior: SessionRunInput['rateLimitBehavior'], onlySessionId?: string): void {
    if (behavior !== 'queue') return
    for (const [sessionId, run] of this.activeRunRequests) {
      if (onlySessionId && sessionId !== onlySessionId) continue
      if (run.exchangeIds?.length || run.options.promptSource === 'agent' || run.options.promptSource === 'automation' || run.options.promptSource === 'watch') continue
      if (!this._hasUndecidedHeldPrompt(sessionId)) continue
      const event = this.rateLimits.peek(sessionId)
      if (!event) continue
      run.input.rateLimitBehavior = 'queue'
      if (this._queueActiveRateLimitedRequest(sessionId)) {
        this._scheduleRateLimitRelease(sessionId, event.resetsAt)
      }
    }
  }

  resolveRateLimit(ctx: IpcContext, action: RateLimitDecisionAction, actor: Actor): boolean {
    const sessionId = this._sessionIdForCtx(ctx)
    if (!sessionId) return false
    const decided = (): void => {
      if (actor.user) void this.recordActivity({ kind: 'session', id: sessionId }, actor, { kind: 'rate_limit_decided', action })
    }

    if (action === 'wait') {
      const event = this._currentRateLimitEvent(sessionId)
      if (event?.type !== 'rate_limit') return false
      this._queueActiveRateLimitedRequest(sessionId)
      this._scheduleRateLimitRelease(sessionId, event.resetsAt)
      decided()
      return true
    }

    if (action === 'stop') {
      this.sessionEmitter.resolveRateLimit(sessionId)
      this._clearRateLimitTimer(sessionId)
      this.rateLimits.clear(sessionId)
      this._setStatus(sessionId, 'idle')
      this._cancelRunExchanges(this.activeRunRequests.get(sessionId))
      this._rejectRateLimitQueue(sessionId, new Error('Rate-limited prompts stopped'))
      this._broadcastRateLimitResolved(sessionId, action)
      decided()
      this._dropParkedSession(sessionId)
      return true
    }

    this._queueActiveRateLimitedRequest(sessionId)
    this._releaseRateLimitQueue(sessionId, action)
    decided()
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

  /**
   * Replace a new worktree's temporary branch with a name generated from the
   * prompt. It runs beside the agent's first turn and only logs a failure:
   * the temporary branch is a correct branch, only a less readable one.
   */
  async nameWorktreeBranch(sessionId: string, checkout: GitCheckout, prompt: string, actor: Actor | undefined, preferences?: ExecutionPreferences): Promise<void> {
    if (!checkout.worktreePath) return
    this.setSessionGitEnvironment(sessionId, checkout.worktreePath, checkout)
    await this.checkouts.name(checkout.worktreePath, prompt, this, (provider) => this.seatForTurn(actor, provider), preferences)
  }

  setSessionGitCheckout(sessionId: string, gitContext: GitCheckout | undefined): void {
    const cwd = gitContext?.worktreePath ?? this.sessionCheckoutPaths.get(sessionId) ?? gitContext?.repoRoot ?? '~'
    this.setSessionGitEnvironment(sessionId, cwd, gitContext ?? null)
  }

  setSessionGitEnvironment(sessionId: string, cwd: string, gitContext: GitCheckout | null): void {
    if (!sessionId) return
    const session = this.activeSessions.get(sessionId)
    if (!gitContext || !cwd || cwd === '~') {
      this.sessionCheckoutPaths.delete(sessionId)
      if (session) session.gitContext = undefined
      return
    }
    const checkoutCwd = gitContext.worktreePath ?? cwd
    this.sessionCheckoutPaths.set(sessionId, checkoutCwd)
    const checkout = this.checkouts.attach(checkoutCwd, gitContext)
    if (session) {
      session.gitContext = checkout
      if (session.runInput) session.runInput.gitContext = checkout
    }
  }

  flushDeferredGitRefreshes(): void {
    this.checkouts.flushDeferred()
  }

  listGitContexts(): GitCheckout[] {
    const contexts: GitCheckout[] = []
    for (const cwd of new Set(this.sessionCheckoutPaths.values())) {
      const checkout = this.checkouts.get(cwd)?.checkout
      if (checkout?.worktreePath) contexts.push({ ...checkout })
    }
    return contexts
  }

  /**
   * A turn that another session runs in `tree`, for a git action or a new
   * session there (plan 004 item 7), or null. The people in that session are
   * not warned (`busyTurnFor`). Nothing is locked.
   */
  busyWorkingTree(tree: string, asker: WorkingTreeAsker): RunningTurnInTree | null {
    const running = [...this.activeRunRequests].map(([sessionId, run]): RunningTurnInTree => ({
      sessionId,
      tree: this.sessionCheckoutPaths.get(sessionId) ?? run.input.gitContext?.worktreePath ?? run.input.workingDirectory,
      authorUserId: run.actor?.user ? userKey(run.actor.user.id) : null,
      authorName: run.actor?.user?.displayName ?? null,
      watchedBy: this.watches.get(sessionId),
    }))
    return busyTurnFor(tree, asker, running)
  }

  getGitContext(sessionId: string): GitCheckout | undefined {
    const cwd = this.sessionCheckoutPaths.get(sessionId)
    return cwd ? this.checkouts.get(cwd)?.checkout ?? undefined : undefined
  }

  /** Whether the next drain would actually dispatch — the same question
   *  `_processQueueForSession` asks, for callers that must decide before it is
   *  safe to run the drain itself. */
  private _hasReadyQueuedRequest(sessionId: string): boolean {
    const next = this.requestQueue.get(sessionId)?.[0]
    return !!next && this._isQueuedRequestReady(next)
  }

  private _isQueuedRequestReady(req: QueuedRequest): boolean {
    if (req.held || this.applyingQueuedSwitch.has(req.sessionId)) return false
    if (req.kind === 'provider_switch') {
      const session = this.activeSessions.get(req.sessionId)
      if (session && (isSessionBusyStatus(session.status) || (!!session.agentSessionId && this._backendFor(session.backendId).isSessionRunning(session.agentSessionId)))) return false
    }
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
      // Releasing a limit does not start work. Dispatch sets the next turn's
      // status; a restored or failed entry can still be held for Resume.
      this._setStatus(sessionId, 'idle')
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
      this.requestQueue.remove(sessionId, req.queueId)
      this._cancelRunExchanges(req.run)
      req.reject(reason)
      this._emit(req.sessionId, { type: 'prompt_dequeued', queueId: req.queueId })
    }
    this.requestQueue.save(sessionId)
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
    if (this.isShuttingDown) return false
    const queue = sessionId ? this.requestQueue.get(sessionId) : undefined
    if (!queue?.length) return false
    const resident = this.activeSessions.get(sessionId)
    if (resident && isSessionBusyStatus(resident.status) && resident.status !== 'background') return false

    // Only process the oldest (first) request. If it isn't ready yet, don't
    // skip ahead — the queue is FIFO and later entries may depend on this one.
    const req = queue[0]
    if (!this._isQueuedRequestReady(req)) return false

    try { this.requestQueue.claim(sessionId) } catch (error) {
      req.held = true
      req.error = `The host could not save the delivery receipt: ${error instanceof Error ? error.message : String(error)}`
      req.revision = (req.revision ?? 0) + 1
      this._publishQueue(sessionId)
      log.error('queue_receipt_save_failed', { sessionId, queueId: req.queueId, error: String(error) })
      return false
    }
    log.info('queued_request_processing', { queueId: req.queueId })

    this._emit(req.sessionId, { type: 'prompt_dequeued', queueId: req.queueId })
    if (req.kind === 'provider_switch') {
      void this._applyQueuedProviderSwitch(req)
      return true
    }

    const reqInput = req.run.input
    const dispatchSession = this.activeSessions.get(req.sessionId)
    const freshProvider = reqInput.provider
    const input: SessionRunInput = {
      ...reqInput,
      provider: freshProvider,
      agentSessionId: dispatchSession?.backendId === freshProvider ? dispatchSession.agentSessionId : reqInput.agentSessionId,
    }

    const run: SessionRunRequest = {
      ...req.run,
      input,
      target: { kind: 'session', sessionId: req.sessionId },
      sessionId: req.sessionId,
      servedQueueId: req.queueId,
      servedEnqueuedAt: req.enqueuedAt,
      // SAFETY: the shared executor validates each tool's declared Zod fields
      // before invoking it. Restore the full catalog, never persisted closures.
      tools: req.run.tools.length ? req.run.tools : Object.values(solusToolbox).flatMap((group) => Object.values(group)) as AgentTool[],
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
      .then(() => { this.requestQueue.settle(req); req.resolve(); this._publishQueue(sessionId) })
      .catch((error) => {
        try { this.requestQueue.settle(req, error instanceof Error ? error.message : String(error)) } catch (saveError) {
          this.requestQueue.holdUncertain(req, `The host could not save the result. Check its history before resuming: ${String(saveError)}`)
          log.error('queue_settlement_save_failed', { sessionId, queueId: req.queueId, error: String(saveError) })
        }
        req.reject(error)
        this._publishQueue(sessionId)
      })
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
      .filter((entry) => entry.run.options.via !== 'session-report' && entry.run.options.via !== 'question-answer')
      .map((r) => ({
        queueId: r.queueId,
        kind: r.kind ?? 'prompt', revision: r.revision ?? 0, held: r.held, error: r.error,
        provider: r.run.input.provider,
        modelConfig: { modelId: r.run.input.preferredModel, reasoningEffort: r.run.input.reasoningEffort, contextWindow: r.run.input.contextWindow, fastMode: r.run.input.fastMode },
        attachments: r.run.options.queueAttachments,
        clientPromptId: r.run.options.clientPromptId,
        text: r.prompt,
        enqueuedAt: r.enqueuedAt,
        reason: r.reason,
        releaseAt: r.releaseAt,
        rateLimitType: r.rateLimitType,
        images: r.run.options.imageAttachments,
        imageRefs: r.run.options.imageAttachmentRefs,
        author: r.run.actor?.user ?? r.author,
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
      // SessionRuntime never saw; an id in `finishedRunSessionIds` means the run
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
    if (session && agentSessionId) this._expirePendingInput(this._backendFor(session.backendId), agentSessionId)
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

    // A message-mode question is an open decision, even after its turn has
    // completed. It does not change the provider's running/completed status.
    if (!pending && (newStatus === 'running' || newStatus === 'completed' || newStatus === 'background' || newStatus === 'idle')) {
      const asyncQuestion = pendingAsyncQuestions(sessionId).at(-1)
      if (asyncQuestion) {
        const projectKey = session?.gitContext?.repoRoot
          ?? session?.runInput?.projectPath
          ?? session?.runInput?.workingDirectory
        this.attention.set({
          sessionId: agentSessionId,
          kind: 'question',
          summary: this._attentionSummary('question', asyncQuestion),
          projectKey,
        })
        return
      }
    }

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
    // A session admitted for an organization before its record existed is assigned now that its record id is known.
    applyPendingAssignment(sessionId, agentSessionId)
    this.recordStatusWritten.set(agentSessionId, status)
    void setSessionRecordStatus(ANY_ORGANIZATION, agentSessionId, status).catch((error) => {
      // Unknown outcome: the next transition writes again.
      this.recordStatusWritten.delete(agentSessionId)
      log.warn('session_record_status_failed', { sessionId, agentSessionId, error: String(error) })
    })
  }

  private _applyStatus(sessionId: string, newStatus: SessionStatus): void {
    if (!this.isShuttingDown && (newStatus === 'completed' || newStatus === 'failed' || newStatus === 'interrupted' || newStatus === 'dead' || newStatus === 'rate_limited')) {
      this.restartRuns?.remove(sessionId)
    } else if (newStatus === 'background') {
      const restartRun = this.restartRuns?.get(sessionId)
      if (restartRun) this.restartRuns?.save({ ...restartRun, state: 'background' })
    }
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
      // the open query — a steered prompt, or its reply to a settled task. It
      // settles on its own id; the 'background' span before it never settles,
      // so a turn left waiting on background work does not notify as finished.
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
    if (goalUpdate) this._emit(sessionId, { type: 'goal_updated', goal: goalUpdate })
  }

  shutdown(): void {
    this.isShuttingDown = true
    for (const session of this.activeSessions.values()) {
      if (!session.agentSessionId || !this.restartRuns?.get(session.sessionId)) continue
      try {
        this.handoffCarry.settle(session.agentSessionId, 'interrupted', this.turnLog.get(session.sessionId) ?? [], Date.now())
      } catch (error) {
        log.error('restart_carry_save_failed', { sessionId: session.sessionId, error: String(error) })
      }
    }
    this.checkouts.dispose()
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
   * Record one thing a person did to a session (plans/012 §5): append it to the
   * activity record, then send it to everyone watching, so it reads the same
   * live, for a teammate, and after a reload. Called for sessions only: tasks
   * and works append their activity with the change and publish through their
   * own invalidation events. An activity made while a turn is open carries that
   * turn's id, so the history read places it inside the turn. `at` names the
   * moment when another record holds it too (a handoff's lineage member).
   */
  async recordActivity(subject: ActivitySubject & { kind: 'session' }, actor: Actor, kind: ActivityKind, at?: number): Promise<Activity> {
    const sessionId = this._sessionIdFor(subject.id) ?? subject.id
    const activity = newActivity({ kind: 'session', id: sessionId }, attributionOf(actor), kind, at)
    const session = this.activeSessions.get(sessionId)
    if (session?.activeTurnId && session.settledTurnId !== session.activeTurnId) activity.turnId = session.activeTurnId
    try {
      await appendActivity(await this._turnOrganization(sessionId) ?? LOCAL_ORGANIZATION_ID, activity)
    } catch (error) {
      // Live readers still get it; only a reload would miss it.
      log.warn('activity_append_failed', { sessionId, kind: kind.kind, error: String(error) })
    }
    this._emit(sessionId, { type: 'activity', activity })
    return activity
  }

  /** A session's activity for its history read, keyed by either id space. */
  sessionActivitySubject(id: string): ActivitySubject {
    return { kind: 'session', id: this._sessionIdFor(id) ?? id }
  }

  /**
   * The whole routing surface. One publish per watching client — two panes on
   * one renderer are one client and get one payload. `except` drops the client
   * whose optimistic bubble is already on screen; `only` narrows to the client
   * that asked (a reattach replay, or a sender's own withheld echo).
   */
  private _emit(sessionId: string, event: NormalizedEvent, to?: { only?: string; except?: string }): void {
    if (!to) this._recordRestartToolEvent(sessionId, event)
    if (!to) {
      for (const chunk of this.responseText.beforeEvent(sessionId, event)) this._emit(sessionId, chunk)
    }
    // A targeted emit is a replay or an echo to one client; logging it would
    // duplicate it for the next joiner. Only the broadcast stream is the turn.
    if (!to) this._recordTurnEvent(sessionId, event)
    this.emit('event', sessionId, event, to)
  }

  private _recordRestartToolEvent(sessionId: string, event: NormalizedEvent): void {
    switch (event.type) {
      case 'tool_call_complete':
        if (!event.outcome && !event.completedAtMs) return
        break
      case 'tool_call':
      case 'tool_result':
      case 'subagent_report':
        break
      default:
        return
    }
    if (!this.restartRuns || this.isShuttingDown || !restartRecoveryEnabled()) return
    const restartRun = this.restartRuns.get(sessionId)
    if (!restartRun) return
    const toolId = 'toolUseId' in event ? event.toolUseId : event.toolId
    if (event.type === 'tool_call') {
      if (restartRun.backgroundTools.length >= 32 || restartRun.backgroundTools.some((tool) => tool.toolId === toolId)) return
      restartRun.backgroundTools.push({ toolId: event.toolId, name: event.isSubagent ? `Child agent (${event.subagentType ?? event.toolName})` : event.toolName })
    } else {
      if (event.type === 'tool_result' && event.isAsyncLaunch) return
      const index = restartRun.backgroundTools.findIndex((tool) => tool.toolId === toolId)
      if (index === -1) return
      restartRun.backgroundTools.splice(index, 1)
    }
    this.restartRuns.save(restartRun)
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


  /**
   * Closes every blocking request a run holds without an answer, when the run
   * exits, stops, or dies. The provider is told no, and every client learns
   * that the card can no longer be answered. Async questions are kept in SQLite,
   * not here, so they stay open after the provider exits.
   */
  private _expirePendingInput(backend: AgentBackend, agentSessionId: string): void {
    backend.permissions.clearPendingForSession(agentSessionId)
    const sessionId = this.agentSessionToSession.get(agentSessionId)
    const session = sessionId ? this.activeSessions.get(sessionId) : undefined
    if (!sessionId || !session) return
    const expired = session.pendingInputEvents.filter((event) => event.type === 'permission_request' || event.type === 'question_request')
    if (!expired.length) return
    session.pendingInputEvents = session.pendingInputEvents.filter((event) => event.type !== 'permission_request' && event.type !== 'question_request')
    session.hasPendingInput = session.pendingInputEvents.length > 0
    for (const event of expired) {
      this.questionIdToSession.delete(event.questionId)
      this._emit(sessionId, { type: 'permission_resolved', questionId: event.questionId, expired: 'run_ended' })
    }
    log.info('pending_input_expired', { sessionId, agentSessionId, count: expired.length })
  }

  private _clearPendingInputEvent(questionId: string): void {
    const match = (event: NormalizedEvent) => eventHasQuestionId(event, questionId)

    for (const session of this.activeSessions.values()) {
      if (!session.pendingInputEvents.length) continue
      const before = session.pendingInputEvents.length
      session.pendingInputEvents = session.pendingInputEvents.filter((e) => !match(e))
      session.hasPendingInput = session.pendingInputEvents.length > 0

      if (session.pendingInputEvents.length !== before) {
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
