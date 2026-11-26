import { cutText } from '@solus/contracts/text-cut'
import { createLogger } from '../../logger'
import { attentionActionForStatus } from '../../attention/attention-service'
import { finishedSummary } from '../../attention/finished-summary'
import type { AttentionKind } from '@solus/contracts/attention-types'
import { hasPendingAsyncQuestion, pendingAsyncQuestions } from '../../data/sessions/async-questions'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { setSessionRecordStatus } from '../../data/sessions/session-records'
import { clearForeignTaskSnapshot } from '../../data/tasks/foreign-tasks'
import { getIndexedSession } from '../../db/session-indexer'
import type { SessionStatus, NormalizedEvent, SessionRecordStatus, ThreadGoal } from '@solus/contracts/types'
import { isSessionBusyStatus, sessionRecordStatusOf } from '@solus/contracts/types'
import type { HostEventMap } from '@solus/contracts/host-events'
import type { SessionRuntime } from '../session-runtime'
import { backgroundWorkHolds } from './background-work'
import { deriveSessionStatus, type SessionFacts, type TurnOutcome } from './derived-status'
import type { Turn } from './turns'

const log = createLogger('SessionRuntime', 'session-statuses.ts')

/** The `session.statusChanged` field for a waiting message-mode question; absent when there is none. */
function pendingQuestionFact(sessionId: string): { hasPendingQuestion?: true } {
  return hasPendingAsyncQuestion(sessionId) ? { hasPendingQuestion: true } : {}
}

/** What the status feed says waits for the person. */
type WaitFacts = Pick<HostEventMap['session.statusChanged'], 'hasPendingQuestion' | 'awaitingApproval' | 'delegatedRequest'>

/** The newest permission or question that waits. A backwards scan without
 *  the copy and reverse allocations: this runs on every status transition,
 *  several times per turn. */
function newestPendingRequest(events: NormalizedEvent[]): Extract<NormalizedEvent, { type: 'permission_request' | 'question_request' }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'permission_request' || e.type === 'question_request') return e
  }
  return undefined
}

const RUN_WATCHDOG_INTERVAL_MS = 30_000

/** Consecutive watchdog ticks a session may be missing a run before it is
 *  declared dead. The timer is a fixed interval, so at one miss a session
 *  created just before a tick was killed milliseconds after it started —
 *  measured at 248ms. Two misses guarantee a session at least one full
 *  interval to produce its run. */
const RUN_WATCHDOG_MISSES = 2

/**
 * Session status: each transition and what follows it — attention, the
 * session record, turn settlement — and the watchdog that finds runs that died.
 */
export class SessionStatuses {
  /** Provider thread id → the session record status this process last wrote for it. */
  recordStatusWritten = new Map<string, SessionRecordStatus>()
  private hadActiveWork = false
  /** Sessions in `awaiting_input` whose newest waiting input is a permission request. */
  private readonly approvalWaits = new Set<string>()
  runWatchdogTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly rt: SessionRuntime) {
    this.runWatchdogTimer = setInterval(() => this.checkActiveRuns(), RUN_WATCHDOG_INTERVAL_MS)
    this.runWatchdogTimer.unref?.()
  }

  /** True while the session is mid-turn or parked on input it still owes an answer to. */
  isSessionBusy(sessionId: string): boolean {
    const status = this.rt.activeSessions.get(sessionId)?.status
    return status !== undefined && isSessionBusyStatus(status)
  }

  /** Stop settles the visible turn before the provider confirms that it ended. */
  isStoppingProviderRun(sessionId: string): boolean {
    const session = this.rt.activeSessions.get(sessionId)
    return session?.status === 'interrupted' && !!session.agentSessionId
      && this.rt.backendFor(session.backendId).isSessionRunning(session.agentSessionId)
  }

  /** True while work outside the provider holds the session in 'background':
   *  the sessions it sent work to, until they report, and its live MCP tasks
   *  (docs/plans/mcp-first-class.md §12.5), until they end. */
  holdsOutsideRun(sessionId: string): boolean {
    return !!this.rt.orchestration?.isAwaitingReplies(sessionId) || !!this.rt.mcpTaskHolds?.(sessionId)
  }

  /** True while the session's turn has ended and it waits in 'background' only
   *  for work outside the provider (`holdsOutsideRun`). It has no run by design. */
  waitsOutsideRun(sessionId: string): boolean {
    return this.rt.activeSessions.get(sessionId)?.status === 'background' && this.holdsOutsideRun(sessionId)
  }

  liveSessionStatus(sessionId: string): SessionStatus | null {
    if (this.rt.rateLimitPark.currentRateLimitEvent(sessionId)) return 'rate_limited'
    return this.rt.activeSessions.get(sessionId)?.status ?? null
  }

  liveActivityStatus(sessionId: string): SessionStatus | null {
    const status = this.liveSessionStatus(sessionId)
    return status === 'awaiting_input' && this.approvalWaits.has(sessionId) ? 'awaiting_plan' : status
  }

  /**
   * True while any session or detached utility agent is actually executing.
   * Narrower than isSessionBusyStatus on purpose: sessions parked on user input or a
   * rate-limit reset consume no compute, so they must not hold the process
   * power-save blocker (see syncPowerSaveBlocker in main/index.ts).
   */
  hasActiveWork(): boolean {
    if (this.rt.activeUnattendedAgentRuns.size > 0) return true
    for (const session of this.rt.activeSessions.values()) {
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
    if (this.hasActiveWork() || this.rt.hasWorkForUpdate()) return true
    for (const session of this.rt.activeSessions.values()) {
      if (session.status === 'awaiting_input' || session.status === 'awaiting_plan') return true
    }
    return false
  }

  notifyActiveWork(): void {
    const active = this.hasActiveWork()
    if (active === this.hadActiveWork) return
    this.hadActiveWork = active
    this.rt.emit('active-work-changed', active)
  }

  checkActiveRuns(): void {
    // One loop, over sessions. Whether anybody is watching only decides whether
    // the death is announced, not whether it is noticed.
    for (const [sessionId, session] of this.rt.activeSessions) {
      const backend = this.rt.backendFor(session.backendId)
      const agentSessionId = session.agentSessionId
      const alive = !!agentSessionId && backend.isSessionRunning(agentSessionId)
      const hasPendingRun = !alive && backend.getPendingHandles().some((handle) => handle.sessionId === sessionId)
      // A completed provider turn can leave commands or children running.
      // Their lifecycle events own completion; no active turn is required.
      const hasBackgroundWork = !!agentSessionId && !!backend.hasBackgroundTasks?.(agentSessionId)
      if (alive || hasPendingRun || this.waitsOutsideRun(sessionId) || (hasBackgroundWork && !isSessionBusyStatus(session.status))) {
        this.rt.missingRunCounts.delete(sessionId)
        continue
      }
      if (this.rt.rateLimitPark.rateLimits.hasActive(sessionId)) {
        // A session parked on a rate limit intentionally has no provider run:
        // it is holding the limit snapshot that gates its next send. The status
        // is not the test — Codex reports a spent account while it finishes the
        // current turn, which parks a session that settled as `completed`.
        this.rt.missingRunCounts.delete(sessionId)
        continue
      }
      if (!isSessionBusyStatus(session.status) && !this.rt.watchers.watches.get(sessionId)?.size) {
        // An idle unwatched session is not a stuck run; leave it resident.
        this.rt.missingRunCounts.delete(sessionId)
        continue
      }

      const misses = (this.rt.missingRunCounts.get(sessionId) ?? 0) + 1
      this.rt.missingRunCounts.set(sessionId, misses)

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
        watcherCount: this.rt.watchers.watches.get(sessionId)?.size ?? 0,
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
      this.markSessionDead(sessionId)
    }

    // Self-heal for any active-work transition that bypassed refresh
    // (e.g. the last watch dropping while running); at worst the power blocker lingers one tick.
    this.notifyActiveWork()
  }

  private markSessionDead(sessionId: string): void {
    const session = this.rt.activeSessions.get(sessionId)
    const agentSessionId = session?.agentSessionId
    if (session && agentSessionId) this.rt.inputRequests.expirePendingInput(this.rt.backendFor(session.backendId), agentSessionId)
    this.rt.flushPendingSession(sessionId)
    this.rt.rateLimitPark.currentRateLimitEvent(sessionId)
    if (session) {
      session.hasPendingInput = false
      session.pendingInputEvents = []
    }

    this.rt.publish(sessionId, {
      type: 'session_dead',
      exitCode: null,
      signal: null,
      stderrTail: [],
    })
    this.endTurn(sessionId, 'dead')
    this.rt.activeSessions.delete(sessionId)
    this.rt.missingRunCounts.delete(sessionId)
    clearForeignTaskSnapshot(sessionId)
    if (agentSessionId) this.rt.attention.resolve(agentSessionId)
    this.rt.scheduler.processQueueForSession(sessionId)
  }

  pendingInputStatus(session: { hasPendingInput?: boolean; pendingInputEvents: NormalizedEvent[] }): SessionStatus {
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
  syncAttention(agentSessionId: string, sessionId: string, newStatus: SessionStatus): void {
    const session = this.rt.activeSessions.get(sessionId)
    const pendingEvent = session ? newestPendingRequest(session.pendingInputEvents) : undefined
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
        this.rt.attention.set({
          sessionId: agentSessionId,
          kind: 'question',
          summary: this.attentionSummary('question', asyncQuestion),
          projectKey,
        })
        return
      }
    }

    const action = attentionActionForStatus(newStatus, pending)
    if (action.type === 'ignore') return
    if (action.type === 'resolve') {
      this.rt.attention.resolve(agentSessionId)
      return
    }

    // projectKey/summary are best-effort: on the process-exit path the session
    // is already gone, so finished/failed entries may carry neither.
    const projectKey = session?.gitContext?.repoRoot
      ?? session?.runInput?.projectPath
      ?? session?.runInput?.workingDirectory
    // A finish waits out its confirm window: a continuation that starts in it
    // (running) cancels the entry, so a gap between two runs never notifies.
    if (action.kind === 'finished') {
      this.rt.attention.confirmFinished({
        sessionId: agentSessionId,
        summary: finishedSummary(getIndexedSession(agentSessionId), projectKey),
        projectKey,
      })
      return
    }
    this.rt.attention.set({
      sessionId: agentSessionId,
      kind: action.kind,
      summary: this.attentionSummary(action.kind, pendingEvent),
      projectKey,
    })
  }

  /** A message-mode question was asked, answered, or dismissed. The status
   *  does not change, but a reader with no transcript (a sidebar row, the
   *  mobile list) must learn that the session waits on the person, or no longer does. */
  questionsChanged(agentSessionId: string, sessionId: string): void {
    const status = this.rt.activeSessions.get(sessionId)?.status ?? 'completed'
    this.syncAttention(agentSessionId, sessionId, status)
    this.rt.emit('session-question', { sessionId, agentSessionId, status, at: Date.now(), ...this.waitFacts(sessionId) })
  }

  /** What a session this one started waits on the person for changed. The
   *  status does not change, and this session's own attention does not
   *  either: the session that asks has its own. Only readers of the status
   *  feed (a sidebar row, the mobile list) learn of it. */
  delegatedRequestChanged(sessionId: string): void {
    const session = this.rt.activeSessions.get(sessionId)
    const status = session?.status ?? 'completed'
    this.rt.emit('session-question', { sessionId, agentSessionId: session?.agentSessionId ?? null, status, at: Date.now(), ...this.waitFacts(sessionId) })
  }

  /** The `session.statusChanged` fields that say what waits for the person. */
  private waitFacts(sessionId: string): WaitFacts {
    const facts: WaitFacts = pendingQuestionFact(sessionId)
    if (this.approvalWaits.has(sessionId)) facts.awaitingApproval = true
    const delegatedRequest = this.rt.orchestration?.delegatedRequestOf(sessionId)
    if (delegatedRequest) facts.delegatedRequest = delegatedRequest
    return facts
  }

  private attentionSummary(kind: Exclude<AttentionKind, 'finished'>, event?: NormalizedEvent): string {
    switch (kind) {
      case 'needs_approval':
        return event?.type === 'permission_request'
          ? `Approval needed: ${event.toolName}`
          : 'Approval needed'
      case 'question': {
        const q = event?.type === 'question_request' ? event.questions[0]?.question : undefined
        return q ? `Question: ${q.length > 120 ? `${cutText(q, 117)}…` : q}` : 'Waiting on your answer'
      }
      case 'failed':
        return 'Run failed'
    }
  }

  /** The facts beneath the session's status (plans/037 D5). */
  private facts(sessionId: string): SessionFacts {
    const session = this.rt.activeSessions.get(sessionId)
    const turn = this.rt.turns.current(sessionId)
    const input = session ? this.pendingInputStatus(session) : null
    return {
      turn: turn?.phase ?? { phase: 'none' },
      pendingInput: input === 'awaiting_input' || input === 'awaiting_plan' ? input : null,
      rateLimitParked: !!turn?.isParked,
      backgroundWorkHolds: !!session && backgroundWorkHolds(session),
      holdsOutsideRun: this.holdsOutsideRun(sessionId),
      queueTakesOver: !!turn?.isTakenOverByQueue,
    }
  }

  /** The status that the facts give now. */
  derive(sessionId: string): SessionStatus {
    return deriveSessionStatus(this.facts(sessionId))
  }

  /** Publish the status that the facts give, when it changed. No writer names a
   *  status: it changes a fact, then refreshes. `startsTurn`: a dispatch
   *  announces its turn on the status feed even when the status stays. */
  refresh(sessionId: string, startsTurn = false): void {
    this.applyStatus(sessionId, this.derive(sessionId), startsTurn)
    this.notifyActiveWork()
  }

  /** End a turn with `outcome`, the session's current turn when none is named, then refresh. */
  endTurn(sessionId: string, outcome: TurnOutcome, turn?: Turn): void {
    ;(turn ?? this.rt.turns.current(sessionId) ?? this.rt.turns.begin(sessionId, { phase: 'running' })).settle(outcome)
    this.refresh(sessionId)
  }

  /** A rate limit parks a turn, the session's current turn when none is named, then refresh. */
  park(sessionId: string, turn?: Turn): void {
    ;(turn ?? this.rt.turns.current(sessionId) ?? this.rt.turns.begin(sessionId, { phase: 'running' })).park()
    this.refresh(sessionId)
  }

  /** The session has no turn now, so it is idle: a handoff, a reset, or a released rate limit (plans/037 D7). */
  clearTurn(sessionId: string): void {
    this.rt.turns.clear(sessionId)
    this.refresh(sessionId)
  }

  /** Publish one Solus-owned terminal boundary for a turn: the one given, else
   *  the session's current turn. The event goes out once for each turn.
   *  Queueing the event preserves result-before-settlement ordering when a
   *  provider's `task_complete` caused the status transition in this same stack. */
  queueTurnSettlement(
    sessionId: string,
    outcome: TurnOutcome,
    turn: Turn = this.rt.turns.current(sessionId) ?? this.rt.turns.begin(sessionId, { phase: 'running' }),
  ): void {
    turn.settle(outcome)
    if (!turn.claimSettlement()) return
    const turnId = turn.id
    const settledAt = Date.now()
    queueMicrotask(() => {
      log.info('turn_settled', { sessionId, turnId, outcome, settledAt })
      const settled: NormalizedEvent = { type: 'turn_settled', turnId, outcome, settledAt }
      this.rt.publish(sessionId, settled)
      this.rt.activity.observe(sessionId, settled)
    })
  }

  private writeSessionRecordStatus(sessionId: string, status: SessionRecordStatus): void {
    if (this.recordStatusWritten.get(sessionId) === status) return
    this.recordStatusWritten.set(sessionId, status)
    void setSessionRecordStatus(ANY_ORGANIZATION, sessionId, status).catch((error) => {
      // Unknown outcome: the next transition writes again.
      this.recordStatusWritten.delete(sessionId)
      log.warn('session_record_status_failed', { sessionId, error: String(error) })
    })
  }

  private applyStatus(sessionId: string, newStatus: SessionStatus, startsTurn: boolean): void {
    if (!this.rt.isShuttingDown && (newStatus === 'completed' || newStatus === 'failed' || newStatus === 'interrupted' || newStatus === 'dead' || newStatus === 'rate_limited')) {
      this.rt.restarts.restartRuns?.remove(sessionId)
    } else if (newStatus === 'background') {
      const restartRun = this.rt.restarts.restartRuns?.get(sessionId)
      if (restartRun) this.rt.restarts.restartRuns?.save({ ...restartRun, state: 'background' })
    } else if (newStatus === 'awaiting_input' || newStatus === 'awaiting_plan') {
      const restartRun = this.rt.restarts.restartRuns?.get(sessionId)
      if (restartRun && restartRun.state !== 'awaiting_input') this.rt.restarts.restartRuns?.save({ ...restartRun, state: 'awaiting_input' })
    } else if (newStatus === 'running') {
      const restartRun = this.rt.restarts.restartRuns?.get(sessionId)
      if (restartRun?.state === 'awaiting_input') this.rt.restarts.restartRuns?.save({ ...restartRun, state: 'running' })
    }
    const session = this.rt.activeSessions.get(sessionId)
    // Attention persists across restarts and is correlated with rows read off
    // disk, so it stays keyed by the provider's thread id — seam (b).
    const agentSessionId = session?.agentSessionId ?? null
    if (agentSessionId) this.syncAttention(agentSessionId, sessionId, newStatus)

    const oldStatus = session?.status ?? 'idle'
    const isAwaitingApproval = newStatus === 'awaiting_input' && newestPendingRequest(session?.pendingInputEvents ?? [])?.type === 'permission_request'
    const hasApprovalChanged = isAwaitingApproval !== this.approvalWaits.has(sessionId)
    if (isAwaitingApproval) this.approvalWaits.add(sessionId)
    else this.approvalWaits.delete(sessionId)
    if (oldStatus === newStatus) {
      // The wait changed between a permission and a question; the status did
      // not, so only the readers of the status feed hear it.
      if (startsTurn) this.rt.emit('session-status', { sessionId, agentSessionId, status: newStatus, at: Date.now(), ...this.waitFacts(sessionId) })
      else if (hasApprovalChanged) this.rt.emit('session-question', { sessionId, agentSessionId, status: newStatus, at: Date.now(), ...this.waitFacts(sessionId) })
      return
    }

    let goalUpdate: ThreadGoal | null = null
    if (session) {
      session.status = newStatus
      if (session.backendId === 'claude-code' && agentSessionId) {
        goalUpdate = this.rt.claudeGoals.applySessionStatus(agentSessionId, newStatus)
      }
    }
    // Global (not watch-scoped) feed so agent-conversation cards can track
    // sessions no client is looking at.
    this.rt.emit('session-status', { sessionId, agentSessionId, status: newStatus, at: Date.now(), ...this.waitFacts(sessionId) })

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
    // fact, so write only when it changes. The record exists once the provider started a thread.
    if (agentSessionId) this.writeSessionRecordStatus(sessionId, sessionRecordStatusOf(newStatus))
    this.rt.publish(sessionId, { type: 'status_change', status: newStatus, oldStatus })
    if (
      session &&
      (newStatus === 'completed' || newStatus === 'failed' || newStatus === 'interrupted' || newStatus === 'dead')
    ) {
      this.queueTurnSettlement(sessionId, newStatus)
    }
    if (goalUpdate) this.rt.publish(sessionId, { type: 'goal_updated', goal: goalUpdate })
  }
}
