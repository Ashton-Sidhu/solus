import { SessionPermissionStore } from '../data/sessions/session-permission-store'
import { RunLedger } from '../data/sessions/run-ledger'
import { EventEmitter } from 'events'
import { join } from 'path'
import { createLogger } from '../logger'
import { CheckoutService } from '../git/checkout-service'
import { AgentRunner, type AgentRun, type AgentRunRequest, type AgentRunSessionState } from './agents/agent-runner'
import type { AgentTool } from './agents/tools/agent-tool'
import { runInputFromContext } from './agents/run-input'
import { buildHandoff } from './agents/session-handoff'
import { isWindowClosed } from './rate-limits'
import { UsageLimitsStore } from '../usage/usage-store'
import { AttentionService } from '../attention/attention-service'
import { prepareSessionTask, rekeyTaskSessionLinks } from '../data/tasks/task-sessions'
import { captureTaskLeadPreferences, taskLeadPreferences, taskLeadPreferencesOfSession, withTaskLeadPreferences } from '../data/tasks/task-lead-preferences'
import { rekeySessionPullRequests } from '../data/sessions/session-pull-requests'
import { recordSessionExecutionPreferences, rekeySessionState } from '../data/sessions/session-states'
import { ResponseTextBuffer } from './sessions/response-text-buffer'
import { inheritedOrganizationOf, parentRecordIdOf, recordSessionSettings } from './sessions/session-settings'
import { ANY_ORGANIZATION, LOCAL_ORGANIZATION_ID } from '../admission/principal'
import { organizationOfSession, recordSessionId } from '../data/sessions/session-records'
import { inheritSessionOrganization, pendingOrganizationFor } from './sessions/turn-organization'
import { getIndexedSession } from '../db/session-indexer'
import { cancelProvisionalSessionHandoff, stableSessionIdForProviderThread } from '../data/sessions/session-lineage'
import { type RunExchanges, type SessionOrchestrator } from './orchestration/session-orchestrator'
import { ClaudeGoalStore } from '../data/sessions/claude-goal-store'
import type { AgentBackend, RunHandle } from './agents/agent-backend'
import type { AgentId, AgentMetadata, BackendSession, NormalizedEvent, IpcContext, PromptOptions, SessionRunInput, AcceptPlanRequest, AcceptPlanResult } from '@solus/contracts/types'
import { isSessionBusyStatus, isSteerableStatus, projectScopeOf } from '@solus/contracts/types'
import { activityLeases } from './activity-leases'
import { SessionEmitter } from './observability/session-emitter'
import type { SeatStore, TurnSeat } from './seats/seat-manager'
import { attributionOf, HOST_ACTOR, seatFor, type Actor } from '../admission/actor'
import type { Activity, ActivityKind, ActivitySubject } from '@solus/contracts/activity'
import { appendActivity, newActivity } from '../data/activity/activity'
import { RunScheduler } from './sessions/run-scheduler'
import { RateLimitPark } from './sessions/rate-limit-park'
import { RestartRecovery } from './sessions/restart-recovery'
import { SessionStatuses } from './sessions/session-statuses'
import { ProviderEvents } from './sessions/provider-events'
import { InputRequests } from './sessions/input-requests'
import { RunLauncher } from './sessions/run-launcher'
import { SessionWatchers } from './sessions/session-watchers'
import { SessionHistory } from './sessions/session-history'
import { ProviderHandoffs } from './sessions/provider-handoffs'
import { SessionCheckouts } from './sessions/session-checkouts'
import { PromptDispatch } from './sessions/prompt-dispatch'

const log = createLogger('SessionRuntime', 'session-runtime.ts')

/** Cap on the in-flight turn's replay log. A turn this long is pathological; the
 *  bound keeps one runaway session from growing the process without limit. */
const TURN_LOG_MAX_EVENTS = 2000

/** The hooks the session orchestrator takes run facts through. */
type OrchestrationHooks = Pick<SessionOrchestrator,
  | 'runQueued' | 'runStarted' | 'runRateLimited' | 'runSettled' | 'runCancelled' | 'sessionStarted'
  | 'reportsAccepted' | 'reportsDisposed' | 'inputRequested' | 'inputResolved' | 'runEvent' | 'sessionTurnStarted' | 'targetStopped' | 'isAwaitingReplies' | 'cancelSentBy'>

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

interface SessionRuntimeOptions {
  buildHandoff?: typeof buildHandoff
  prepareSessionTask?: typeof prepareSessionTask
  queueDirectory?: string
}

/**
 * SessionRuntime: the single backend authority for session lifecycle.
 *
 * One id, everywhere. Every map of the session owners is keyed by Solus's `sessionId`, and events
 * are published to the clients watching that session — a watch is just
 * `Map<sessionId, Set<clientId>>`, with no other fields, because with one id
 * space there is nothing else for it to carry. The main process has never heard
 * of a tab: how a client arranges a session on screen is its own business.
 *
 * The provider's own thread id (`agentSessionId`) is a field on BackendSession,
 * not an address. It is legal at exactly two seams — `ProviderEvents.wire`, where
 * backend events arrive tagged with it and are translated once through
 * `agentSessionToSession`, and the disk-backed readers (the session index, the
 * picker, the MCP session tools), whose rows only ever carry a provider id.
 * Anywhere else it is a bug.
 */
export class SessionRuntime extends EventEmitter {
  /** The live session records, keyed by Solus's `sessionId`. */
  activeSessions = new Map<string, BackendSession>()
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
  agentSessionToSession = new Map<string, string>()
  activeRunRequests = new Map<string, SessionRunRequest>()
  /**
   * Every event the in-flight turn has broadcast, in order, per session. Replayed
   * by bindRuntimeSession so a client that opens a running session mid-turn is
   * level with the clients that were already watching — the same tool calls, not
   * just the text. Durable transcripts on disk never contain an unsettled turn, so
   * this is the only place that history exists. Cleared when the turn settles.
   */
  turnLog = new Map<string, NormalizedEvent[]>()
  missingRunCounts = new Map<string, number>()

  /** The session owners. Each one keeps its own state and reads the maps above. */
  readonly scheduler: RunScheduler
  readonly rateLimitPark = new RateLimitPark(this)
  readonly restarts: RestartRecovery
  readonly statuses = new SessionStatuses(this)
  readonly providerEvents = new ProviderEvents(this)
  readonly inputRequests = new InputRequests(this)
  readonly launcher = new RunLauncher(this)
  readonly watchers = new SessionWatchers(this)
  readonly history = new SessionHistory(this)
  readonly handoffs: ProviderHandoffs
  readonly sessionCheckouts: SessionCheckouts
  readonly dispatch = new PromptDispatch(this)

  readonly sessionPermissionModes: SessionPermissionStore
  isShuttingDown = false
  backends: Map<AgentId, AgentBackend>
  private agentRunner: AgentRunner
  private activeAgentRuns = new Set<AgentRun>()
  activeUnattendedAgentRuns = new Set<AgentRun>()
  readonly claudeGoals = new ClaudeGoalStore()
  readonly sessionEmitter = new SessionEmitter()
  readonly responseText = new ResponseTextBuffer()
  /** Cached provider quota windows. Fed by the provider streams
   *  below and by the polled read in the usage handlers. */
  readonly usageLimits = new UsageLimitsStore()
  /** Owns every exchange between sessions; wired once the host boots. */
  orchestration: OrchestrationHooks | null = null
  /** Server-side per-session needs-attention state; outlives connected clients
   *  and persists across restarts. Fed by `setStatus` transitions; read by the
   *  `listAttention` RPC and broadcast on the `attention-changed` topic. */
  readonly attention = new AttentionService()
  readonly checkouts = new CheckoutService(() => activityLeases.hasForegroundLease())
  /** The durable run ledger, when this runtime keeps receipts. */
  readonly runLedger?: RunLedger
  readonly sessionTaskPreparer: typeof prepareSessionTask
  /** Provider seats, once the host has opened its database. */
  private seats: SeatStore | null = null

  constructor(backends: Map<AgentId, AgentBackend>, opts: SessionRuntimeOptions = {}) {
    super()
    this.runLedger = opts.queueDirectory ? new RunLedger(opts.queueDirectory) : undefined
    this.sessionPermissionModes = new SessionPermissionStore(opts.queueDirectory ? join(opts.queueDirectory, 'policies', 'permissions.json') : undefined)
    this.handoffs = new ProviderHandoffs(this, opts.buildHandoff ?? buildHandoff,
      opts.queueDirectory ? join(opts.queueDirectory, 'handoff-carry') : undefined)
    this.scheduler = new RunScheduler(this, this.runLedger)
    this.restarts = new RestartRecovery(this, this.runLedger)
    for (const saved of this.restarts.restartRuns?.list() ?? []) {
      if (saved.clientPromptId) this.dispatch.acceptedClientPromptIds.add(`${saved.sessionId}:${saved.clientPromptId}`)
    }
    this.backends = backends
    this.agentRunner = new AgentRunner(backends)
    this.sessionTaskPreparer = opts.prepareSessionTask ?? prepareSessionTask
    for (const backend of this.backends.values()) {
      this.providerEvents.wire(backend)
    }
    this.sessionCheckouts = new SessionCheckouts(this)
  }

  /** The stable id a share list is keyed on, for a session named by either id space. */
  canonicalSessionId(id: string): string {
    return this.sessionIdFor(id) ?? id
  }

  /**
   * Whether this host has any record of a session, by either id: something live on
   * its behalf, a lineage, or an index row. The share manager treats an unknown id
   * as a session being started, which its starter may do.
   */
  isKnownSession(id: string): boolean {
    return this.sessionIdFor(id) !== undefined || getIndexedSession(id) !== null
  }

  /** Solus's id for a session named by either id space. The provider-id arm is
   *  seam (b): rows read off disk (the picker, MCP session tools, the session
   *  index) only ever hold a provider thread id. */
  sessionIdFor(id: string | null | undefined): string | undefined {
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
    if (this.activeSessions.has(id) || this.watchers.watches.has(id) || this.launcher.pendingSetupControllers.has(id) || this.launcher.failedSetupPrompts.has(id)) return id
    return undefined
  }

  /** The provider thread behind a session, for the calls that cross into a
   *  backend. Undefined before session_init. */
  agentSessionIdFor(sessionId: string): string | undefined {
    return this.activeSessions.get(sessionId)?.agentSessionId ?? undefined
  }

  /** The organization the session's spans carry (organization-scope §6.1); undefined for Local work. */
  async turnOrganization(sessionId: string): Promise<string | undefined> {
    const organizationId = await organizationOfSession(this.agentSessionIdFor(sessionId) ?? sessionId)
    if (organizationId !== LOCAL_ORGANIZATION_ID) return organizationId
    // A new session has no record yet; the admission already decided its organization.
    return pendingOrganizationFor(sessionId) ?? undefined
  }

  /**
   * Settles the organization a run's work belongs to from the organization its
   * record names — a child or fork inherits its origin's — and records it with
   * the run's captured preferences for the tools the turn calls.
   */
  async settleRunOrganization(request: SessionRunRequest): Promise<void> {
    // A fork belongs to the session it branches from until its own record says otherwise.
    const forkSource = request.input.forked && request.input.agentSessionId ? await organizationOfSession(request.input.agentSessionId) : undefined
    const ownOrganization = await this.turnOrganization(request.sessionId) ?? LOCAL_ORGANIZATION_ID
    const recordOrganization = [ownOrganization, forkSource]
      .find((candidate) => candidate !== undefined && candidate !== LOCAL_ORGANIZATION_ID) ?? LOCAL_ORGANIZATION_ID
    const recordId = this.agentSessionIdFor(request.sessionId) ?? (request.input.forked ? null : request.input.agentSessionId)
    // The session a child came from: named by the request that starts it, and by its record's parent link after that.
    const originRecordId = recordOrganization !== LOCAL_ORGANIZATION_ID ? null
      : request.delegation?.parentSessionId ?? await parentRecordIdOf(recordSessionId(recordId ?? request.sessionId))
    const organizationId = await inheritedOrganizationOf(request.sessionId, recordOrganization, originRecordId, (id) => this.sessionIdFor(id))
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
  async useTaskLeadPreferences(request: SessionRunRequest): Promise<void> {
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

  runAgent(request: AgentRunRequest, sessionState?: AgentRunSessionState): AgentRun {
    // Helpers called by an accepted turn must be able to finish its workflow.
    if (!sessionState && this.updateWorkCount === 0) this.assertNewWorkAllowed()
    const run = this.agentRunner.run(request, sessionState)
    this.activeAgentRuns.add(run)
    if (request.unattended) {
      this.activeUnattendedAgentRuns.add(run)
      this.statuses.notifyActiveWork()
    }
    void run.done.finally(() => {
      this.activeAgentRuns.delete(run)
      if (this.activeUnattendedAgentRuns.delete(run)) this.statuses.notifyActiveWork()
    }).catch(() => {})
    return run
  }

  /** Clear the stored provider thread so the next dispatch won't inject a stale --resume. */
  async resetSession(ctx: IpcContext): Promise<void> {
    const sessionId = this.sessionIdForCtx(ctx)
    if (!sessionId) return
    const session = this.activeSessions.get(sessionId)
    log.info('session_reset', { sessionId, agentSessionId: session?.agentSessionId ?? null })
    this.rateLimitPark.rateLimits.clear(sessionId)
    const pendingHandoff = this.handoffs.pendingHandoffFor(sessionId)
    if (pendingHandoff) {
      const restoredHandoff = cancelProvisionalSessionHandoff(sessionId)
      if (!restoredHandoff) {
        await rekeyTaskSessionLinks(ANY_ORGANIZATION, sessionId, pendingHandoff.fromSessionId)
        await rekeySessionPullRequests(sessionId, pendingHandoff.fromSessionId)
        await rekeySessionState(sessionId, pendingHandoff.fromSessionId)
      }
    }
    this.handoffs.pendingHandoffs.delete(sessionId)

    if (session) {
      session.agentSessionId = null
      delete session.handoffFrom
      session.runInput = { ...runInputFromContext(ctx), agentSessionId: null }
      session.gitContext = ctx.session.gitContext ?? undefined
    }
    this.statuses.setStatus(sessionId, 'idle')
    this.sessionCheckouts.setSessionGitEnvironment(sessionId, ctx.session.workingDirectory, ctx.session.gitContext)
  }

  /**
   * Accept a plan in its own session (plans/012 §5): stop the planning run, hand
   * the session to another agent or start a fresh agent session as asked, and
   * record `plan_decided`. The planning run ends because the work moves on, not
   * because someone stopped it, so the stop records no `stopped` of its own.
   * The client sends the implementation prompt next.
   */
  async acceptPlan(ctx: IpcContext, request: AcceptPlanRequest, actor: Actor): Promise<AcceptPlanResult> {
    const sessionId = this.sessionIdForCtx(ctx) ?? ctx.session.sessionId
    if (this.statuses.isSessionBusy(sessionId)) this.stopSession(sessionId, HOST_ACTOR)
    const result: AcceptPlanResult = {}
    const decided: Extract<ActivityKind, { kind: 'plan_decided' }> = { kind: 'plan_decided', planId: request.planId, decision: 'accepted' }
    if (request.provider) {
      result.handoff = await this.handoffs.switchSessionProvider(sessionId, request.provider, ctx.session.agentSessionId, actor)
    } else if (request.startNewSession) {
      await this.resetSession(ctx)
      decided.newSessionId = sessionId
    }
    await this.recordActivity({ kind: 'session', id: sessionId }, actor, decided)
    return result
  }

  /** Hands every exchange between sessions to the orchestrator. */
  useOrchestration(orchestration: OrchestrationHooks): void {
    this.orchestration = orchestration
  }

  /** What a run tells the orchestrator: which exchanges it answers. Null when
   *  it answers none, so an ordinary turn never reaches the orchestrator. */
  runExchanges(run: SessionRunRequest, agentSessionId?: string | null): RunExchanges | null {
    if (!run.exchangeIds?.length || !run.runId) return null
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      agentSessionId: agentSessionId ?? this.activeSessions.get(run.sessionId)?.agentSessionId ?? run.input.agentSessionId,
      exchangeIds: run.exchangeIds,
    }
  }

  /** Something happened in a session's live turn that its senders hear about. */
  reportToActiveRun(sessionId: string, report: (run: RunExchanges) => void): void {
    const active = this.activeRunRequests.get(sessionId)
    const run = active ? this.runExchanges(active) : null
    if (run) report(run)
  }

  /** A run that will never reach a turn: its exchanges end with `reason` as their reply. */
  cancelRunExchanges(run: SessionRunRequest | undefined, outcome: 'interrupted' | 'failed' = 'interrupted', reason?: string): void {
    const exchanges = run ? this.runExchanges(run) : null
    if (run?.reportExchangeIds?.length) this.orchestration?.reportsDisposed(run.reportExchangeIds)
    if (!exchanges) return
    const cancelled = { ...exchanges, exchangeIds: run!.exchangeIds!.splice(0) }
    this.orchestration?.runCancelled(cancelled, outcome, reason)
  }

  /** The run's turn ended. Reported once: the ids leave the run as they go. */
  settleRunExchanges(
    run: SessionRunRequest,
    outcome: 'completed' | 'interrupted' | 'failed',
    handle: RunHandle,
    runMeta: { durationMs?: number; toolCallCount?: number; error?: string },
  ): void {
    const exchanges = this.runExchanges(run, handle.agentSessionId)
    if (!exchanges || !this.orchestration) return
    const session = this.activeSessions.get(run.sessionId)
    this.orchestration.runSettled({
      ...exchanges,
      exchangeIds: run.exchangeIds!.splice(0),
      outcome,
      resultText: handle.resultText,
      error: runMeta.error,
      durationMs: runMeta.durationMs,
      toolCallCount: runMeta.toolCallCount,
      provider: run.input.provider,
      projectScope: projectScopeOf(run.input),
      gitContext: session?.gitContext ?? run.input.gitContext,
    })
  }

  activeExchangeIdsFor(sessionId: string): string[] {
    return this.activeRunRequests.get(sessionId)?.exchangeIds ?? []
  }

  /** Holds a host update until orchestration work outside any run settles. */
  trackUpdateWork<T>(work: Promise<T>): Promise<T> {
    this.updateWorkCount++
    return work.finally(() => { this.updateWorkCount-- })
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

  /** The only execution entry point. Every caller supplies an explicit target
   * and receives the same lifecycle whether the input starts, steers, or queues. */
  private updatePending = false
  private updateWorkCount = 0

  setUpdatePending(pending: boolean): void { this.updatePending = pending }

  hasWorkForUpdate(): boolean { return this.updateWorkCount > 0 || this.activeAgentRuns.size > 0 || this.launcher.pendingSetupControllers.size > 0 || this.scheduler.requestQueue.size > 0 }

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
    const previousRestart = this.restarts.restartRuns?.get(request.sessionId)
    this.restarts.restartRuns?.remove(request.sessionId)
    let removedRecovery = false
    for (const entry of [...(this.scheduler.requestQueue.get(request.sessionId) ?? [])]) {
      if (entry.run.options.clientPromptId?.startsWith('restart:')) {
        this.scheduler.requestQueue.remove(request.sessionId, entry.queueId)
        removedRecovery = true
      }
    }
    if (removedRecovery) this.scheduler.publishQueue(request.sessionId)
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
        && this.backendFor(previousRestart.input.provider).isSessionRunning(previousRestart.input.agentSessionId)
        && !this.restarts.restartRuns?.get(request.sessionId)) {
        this.restarts.restartRuns?.save(previousRestart)
      }
      throw error
    }
  }

  private async _acceptTurn(request: SessionRunRequest, deviceId?: string): Promise<SessionRunLifecycle> {
    if (this.scheduler.applyingQueuedSwitch.has(request.sessionId)) {
      return this.scheduler.enqueueRequest(request, { sessionId: request.sessionId, reason: 'busy', deviceId })
    }
    if (request.target.kind === 'session') {
      const sessionId = request.target.sessionId
      const session = this.activeSessions.get(sessionId)
      if (session) {
        const pendingRateLimit = this.rateLimitPark.currentRateLimitEvent(sessionId)
        if (
          pendingRateLimit?.type === 'rate_limit' &&
          // A limit kept past its window is only holding the card's question
          // open. Nothing would drain a prompt queued behind it, so a prompt
          // typed after the window reopened runs.
          isWindowClosed(pendingRateLimit) &&
          (request.input.rateLimitBehavior === 'ask' || request.input.rateLimitBehavior === 'queue')
        ) {
          return this.scheduler.enqueueRequest(request, {
            sessionId,
            reason: 'rate_limit',
            deviceId,
            rateLimitSessionId: sessionId,
            releaseAt: pendingRateLimit.resetsAt ?? undefined,
            rateLimitType: pendingRateLimit.rateLimitType,
          })
        }

        const hasQueuedForSession = (this.scheduler.requestQueue.get(sessionId)?.length ?? 0) > 0
        const wasRunningAtDispatch = session.status === 'running'
        if (isSessionBusyStatus(session.status)) {
          if (request.options.delivery !== 'queue') {
            const steered = session.agentSessionId && isSteerableStatus(session.status)
              ? await this.launcher.steerActiveTurn(request, session.agentSessionId, session)
              : null
            if (steered) return steered
            // `turn/steer` is preconditioned on an active turn. If that turn
            // completed while the request was in flight, its exit handler may
            // already have checked an empty queue. Start directly instead of
            // enqueuing work that would have no later event to drain it.
            const currentSession = this.activeSessions.get(sessionId)
            const hasQueuedAfterSteer = (this.scheduler.requestQueue.get(sessionId)?.length ?? 0) > 0
            if ((!currentSession || !isSessionBusyStatus(currentSession.status)) && !hasQueuedAfterSteer) {
              // Legacy senders withheld their bubble for a steer verdict but
              // cannot match the normal confirmation without a prompt id.
              if (request.sourceClientId && wasRunningAtDispatch && !request.options.clientPromptId) {
                this.publish(sessionId, this.launcher.userMessageEvent(request.options, undefined, request.actor), { only: request.sourceClientId })
              }
              return this.launcher.startRunLifecycle(request)
            }
          }
          return this.scheduler.enqueueRequest(request, {
            sessionId,
            reason: 'busy',
            deviceId,
          })
        }
        if (hasQueuedForSession) {
          return this.scheduler.enqueueRequest(request, {
            sessionId,
            reason: 'busy',
            deviceId,
          })
        }
        // The turn is over, so a queued delivery has nothing to wait behind:
        // any prompt goes into the query that the background work keeps open.
        if (session.status === 'background' && session.agentSessionId) {
          const steered = await this.launcher.steerActiveTurn(request, session.agentSessionId, session)
          if (steered) return steered
        }
      }
    }

    if ((this.scheduler.requestQueue.get(request.sessionId)?.length ?? 0) > 0) {
      return this.scheduler.enqueueRequest(request, { sessionId: request.sessionId, reason: 'busy', deviceId })
    }
    return this.launcher.startRunLifecycle(request)
  }

  /**
   * Stop the background tasks a session's agent left running, and nothing else:
   * the agent's turn is already settled, so this is not an interrupt. Each task
   * settles through the provider's own events, and the session leaves
   * 'background' through the usual turn that follows.
   */
  async stopBackgroundTasks(id: string): Promise<boolean> {
    const sessionId = this.sessionIdFor(id)
    const session = sessionId ? this.activeSessions.get(sessionId) : undefined
    const agentSessionId = session?.agentSessionId
    const taskIds = [...(session?.backgroundTaskIds ?? [])]
    if (!session || !agentSessionId || taskIds.length === 0) return false
    const backend = this.backendFor(session.backendId)
    const stopBackgroundTask = backend.stopBackgroundTask?.bind(backend)
    if (!stopBackgroundTask) return false
    log.info('background_tasks_stop_requested', { sessionId, taskIds })
    this.restarts.restartRuns?.remove(sessionId!)
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
    const sessionId = this.sessionIdFor(id)
    if (!sessionId) return false
    this.restarts.restartRuns?.remove(sessionId)
    for (const entry of [...(this.scheduler.requestQueue.get(sessionId) ?? [])]) {
      if (entry.run.options.clientPromptId?.startsWith('restart:')) this.scheduler.requestQueue.remove(sessionId, entry.queueId)
    }
    this.scheduler.publishQueue(sessionId)
    const stopped = (): void => {
      // Recorded before the status settles the turn, so it carries that turn's id.
      if (actor.user) void this.recordActivity({ kind: 'session', id: sessionId }, actor, { kind: 'stopped' })
      this.statuses.setStatus(sessionId, 'interrupted')
    }

    // Stop ends the running turn only (plan 004 D12). Queued prompts, other
    // people's included, stay, and the next one starts when this turn exits.
    const queuedRunIds = new Set((this.scheduler.requestQueue.get(sessionId) ?? []).flatMap((req) => req.run.runId ? [req.run.runId] : []))
    this.orchestration?.targetStopped(sessionId, queuedRunIds)
    this.launcher.failedSetupPrompts.delete(sessionId)
    const moveController = this.sessionCheckouts.worktreeMoves.get(sessionId)
    moveController?.abort(new Error('Interrupted'))
    this.sessionCheckouts.worktreeMoves.delete(sessionId)

    // Worktree creation happens before a backend RunHandle exists. Cancel it
    // first or Stop would report failure while setup continued into a new run.
    const setupController = this.launcher.pendingSetupControllers.get(sessionId)
    if (setupController) {
      // The prompts queued behind it were written for the worktree that now
      // never exists; run in the project folder they would do something else.
      this.scheduler.drainQueue(sessionId)
      setupController.abort(new Error('Interrupted'))
      this.launcher.pendingSetupControllers.delete(sessionId)
      this.sessionEmitter.recordTerminal(sessionId, 'interrupted')
      stopped()
      return true
    }

    const session = this.activeSessions.get(sessionId)
    // 'background' is the way out of a task that never settles: cancelling the
    // query is what ends the work the agent left running.
    if (session?.agentSessionId && (isSessionBusyStatus(session.status) || session.status === 'background')) {
      const cancelled = this.backendFor(session.backendId).cancelSession(session.agentSessionId)
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

    return !!moveController
  }

  /** The session an IPC context is acting on. A client that only knows the
   *  provider thread (a resume it has not bound yet) resolves through seam (b). */
  sessionIdForCtx(ctx: IpcContext): string | undefined {
    return ctx.session.sessionId || this.sessionIdFor(ctx.session.agentSessionId)
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

  backendFor(id: AgentId): AgentBackend {
    const backend = this.backends.get(id)
    if (!backend) throw new Error(`Unknown agent provider: ${id}`)
    return backend
  }

  shutdown(): void {
    this.isShuttingDown = true
    for (const session of this.activeSessions.values()) {
      if (!session.agentSessionId || !this.restarts.restartRuns?.get(session.sessionId)) continue
      try {
        this.handoffs.handoffCarry.settle(session.agentSessionId, 'interrupted', this.turnLog.get(session.sessionId) ?? [], Date.now())
      } catch (error) {
        log.error('restart_carry_save_failed', { sessionId: session.sessionId, error: String(error) })
      }
    }
    this.checkouts.dispose()
    this.launcher.failedSetupPrompts.clear()
    log.info('control_plane_shutdown')
    if (this.statuses.runWatchdogTimer) {
      clearInterval(this.statuses.runWatchdogTimer)
      this.statuses.runWatchdogTimer = null
    }
    for (const timer of this.rateLimitPark.rateLimitTimers.values()) clearTimeout(timer)
    this.rateLimitPark.rateLimitTimers.clear()
    this.rateLimitPark.rateLimits.clearAll()
    for (const run of this.activeAgentRuns) run.cancel()
    this.activeAgentRuns.clear()
    this.activeUnattendedAgentRuns.clear()

    for (const session of this.activeSessions.values()) {
      if (!session.agentSessionId) continue
      this.backendFor(session.backendId).cancelSession(session.agentSessionId)
    }
    this.activeSessions.clear()
    this.agentSessionToSession.clear()

    for (const backend of this.backends.values()) {
      for (const handle of backend.getPendingHandles()) {
        handle.abortController.abort()
      }
    }

    this.watchers.watches.clear()
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
    const sessionId = this.sessionIdFor(subject.id) ?? subject.id
    const activity = newActivity({ kind: 'session', id: sessionId }, attributionOf(actor), kind, at)
    const session = this.activeSessions.get(sessionId)
    if (session?.activeTurnId && session.settledTurnId !== session.activeTurnId) activity.turnId = session.activeTurnId
    try {
      await appendActivity(await this.turnOrganization(sessionId) ?? LOCAL_ORGANIZATION_ID, activity)
    } catch (error) {
      // Live readers still get it; only a reload would miss it.
      log.warn('activity_append_failed', { sessionId, kind: kind.kind, error: String(error) })
    }
    this.publish(sessionId, { type: 'activity', activity })
    return activity
  }

  /** A session's activity for its history read, keyed by either id space. */
  sessionActivitySubject(id: string): ActivitySubject {
    return { kind: 'session', id: this.sessionIdFor(id) ?? id }
  }

  /**
   * The whole routing surface. One publish per watching client — two panes on
   * one renderer are one client and get one payload. `except` drops the client
   * whose optimistic bubble is already on screen; `only` narrows to the client
   * that asked (a reattach replay, or a sender's own withheld echo).
   */
  publish(sessionId: string, event: NormalizedEvent, to?: { only?: string; except?: string }): void {
    if (!to) this.restarts.recordRestartToolEvent(sessionId, event)
    if (!to) {
      for (const chunk of this.responseText.beforeEvent(sessionId, event)) this.publish(sessionId, chunk)
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

  emitError(sessionId: string, error: ReturnType<AgentBackend['getEnrichedError']>): void {
    this.emit('error', sessionId, error)
  }

  /** Drain a session's complete buffered prose run before its boundary event. */
  flushPendingSession(sessionId: string, bufferedOnly = false): void {
    for (const event of this.responseText.flush(sessionId, bufferedOnly)) this.publish(sessionId, event)
  }
}
