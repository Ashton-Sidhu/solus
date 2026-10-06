import { createLogger } from '../../logger'
import { attentionActionForStatus } from '../../attention/attention-service'
import { finishedSummary } from '../../attention/finished-summary'
import type { AttentionKind } from '@solus/contracts/attention-types'
import { pendingAsyncQuestions } from '../../data/sessions/async-questions'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { sessionRecordStatusOf, setSessionRecordStatus } from '../../data/sessions/session-records'
import { applyPendingAssignment } from './turn-organization'
import { clearForeignTaskSnapshot } from '../../data/tasks/foreign-tasks'
import { getIndexedSession } from '../../db/session-indexer'
import type { BackendSession, SessionStatus, NormalizedEvent, SessionRecordStatus, ThreadGoal } from '@solus/contracts/types'
import { isSessionBusyStatus } from '@solus/contracts/types'
import type { SessionRuntime } from '../session-runtime'

const log = createLogger('SessionRuntime', 'session-statuses.ts')

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

  liveSessionStatus(sessionId: string): SessionStatus | null {
    if (this.rt.rateLimitPark.currentRateLimitEvent(sessionId)) return 'rate_limited'
    return this.rt.activeSessions.get(sessionId)?.status ?? null
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
      if (alive || hasPendingRun) {
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

    // Self-heal for any active-work transition that bypassed setStatus
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
    this.setStatus(sessionId, 'dead')
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
    this.rt.attention.set({
      sessionId: agentSessionId,
      kind: action.kind,
      summary: action.kind === 'finished'
        ? finishedSummary(getIndexedSession(agentSessionId), projectKey)
        : this.attentionSummary(action.kind, pendingEvent),
      projectKey,
    })
  }

  private attentionSummary(kind: Exclude<AttentionKind, 'finished'>, event?: NormalizedEvent): string {
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

  setStatus(sessionId: string, newStatus: SessionStatus): void {
    this.applyStatus(sessionId, newStatus)
    this.notifyActiveWork()
  }

  /** Publish one Solus-owned terminal boundary for the active top-level turn.
   *  Queueing the event preserves result-before-settlement ordering when a
   *  provider's `task_complete` caused the status transition in this same stack. */
  private queueTurnSettlement(
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
      this.rt.publish(sessionId, { type: 'turn_settled', turnId, outcome, settledAt })
    })
  }

  private writeSessionRecordStatus(sessionId: string, status: SessionRecordStatus): void {
    if (this.recordStatusWritten.get(sessionId) === status) return
    // A session admitted for an organization before its record existed is assigned now that the record exists.
    applyPendingAssignment(sessionId)
    this.recordStatusWritten.set(sessionId, status)
    void setSessionRecordStatus(ANY_ORGANIZATION, sessionId, status).catch((error) => {
      // Unknown outcome: the next transition writes again.
      this.recordStatusWritten.delete(sessionId)
      log.warn('session_record_status_failed', { sessionId, error: String(error) })
    })
  }

  private applyStatus(sessionId: string, newStatus: SessionStatus): void {
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
        goalUpdate = this.rt.claudeGoals.applySessionStatus(agentSessionId, newStatus)
      }
    }
    // Global (not watch-scoped) feed so agent-conversation cards can track
    // sessions no client is looking at.
    this.rt.emit('session-status', { sessionId, agentSessionId, status: newStatus, at: Date.now() })

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
      this.queueTurnSettlement(sessionId, session, newStatus)
    }
    if (goalUpdate) this.rt.publish(sessionId, { type: 'goal_updated', goal: goalUpdate })
  }
}
