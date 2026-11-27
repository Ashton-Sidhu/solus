import { createLogger } from '../../logger'
import { linkSessionOutput } from '../../data/tasks/task-attachments'
import { saveAsyncQuestion } from '../../data/sessions/async-questions'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { clearForeignTaskSnapshot } from '../../data/tasks/foreign-tasks'
import { getIndexedSession, persistIndexedSessionStart } from '../../db/session-indexer'
import { completeSessionHandoff, registerSessionLineage, replaceSessionLineageThread, sessionIdOfThread } from '../../data/sessions/session-lineage'
import { emitSessionDigestChanged } from '../../data/sessions/session-digests'
import type { AgentBackend, RunHandle } from '../agents/agent-backend'
import type { BackendSession, NormalizedEvent, PromptVia, ThreadGoal } from '@solus/contracts/types'
import { encodePathAsFolder, isSessionBusyStatus } from '@solus/contracts/types'
import { indexLivePlan } from '../../plans/plan-index'
import type { SessionRuntime } from '../session-runtime'
import { eventHasQuestionId } from './input-requests'
import type { PendingStart } from './run-launcher'
import { linkPreparedTask } from './run-task-context'
import { backgroundWorkHolds } from './background-work'
import type { TurnOutcome } from './derived-status'
import type { ActivityKind } from '@solus/contracts/activity'
import { turnActivity } from '../../git/turn-activity'

const log = createLogger('SessionRuntime', 'provider-events.ts')

/** How a run's exit ends its turn, before a rate limit and background work count. */
function exitOutcome(isStopped: boolean, code: number | null, signal: string | null): TurnOutcome {
  if (isStopped) return 'interrupted'
  if (code === 0) return 'completed'
  if (signal === 'SIGINT' || signal === 'SIGKILL') return 'interrupted'
  return code === null ? 'dead' : 'failed'
}

/**
 * The one place backend events enter: each is translated from the provider's
 * thread id to the Solus session once, applied to session state, and delivered.
 */
export class ProviderEvents {
  /** Provider threads whose lineage this process has registered; later inits of the same thread skip the transaction. */
  private registeredLineageThreads = new Set<string>()
  /** Provider threads whose start this process has indexed, with the model and effort it recorded. */
  private indexedThreadStarts = new Map<string, string>()

  constructor(private readonly rt: SessionRuntime) {}

  /** Settle a session that waits in 'background' with no query open (Codex,
   *  or a session that waits on reports) once nothing is left running, no
   *  report is still to come, and no turn takes over. A report that wakes the
   *  session has replaced its record before this runs. */
  endBackgroundWait(sessionId: string): void {
    const session = this.rt.activeSessions.get(sessionId)
    if (session?.status !== 'background' || backgroundWorkHolds(session)) return
    if (this.rt.statuses.holdsOutsideRun(sessionId)) return
    // The turn's outcome shows now: completed, or failed when its run failed while the work ran.
    this.rt.statuses.refresh(sessionId)
    if (!session.backgroundTaskIds?.size) this.rt.activeSessions.delete(sessionId)
    this.rt.orchestration?.backgroundEnded(sessionId)
  }

  /**
   * A run reports that it works (plans/037 D3, D4). Its turn runs. A run whose
   * turn has settled opens a new turn: Claude starts one in its open query when
   * a background task or a steer wakes it. False when the report changes no
   * turn: the run was stopped, so it never opens a turn again, or a newer turn
   * owns the session.
   */
  private runWorks(sessionId: string, backend: AgentBackend, handle: RunHandle | undefined, newTurnId?: string): boolean {
    const current = this.rt.turns.current(sessionId)
    const turn = (handle && this.rt.turns.ofRun(handle)) ?? current
    if (turn && turn !== current) return false
    if (turn?.outcome === 'interrupted') return false
    if (turn && !turn.isSettled) {
      turn.markRunning()
      return true
    }
    const opened = this.rt.turns.begin(sessionId, { id: newTurnId, phase: 'running' })
    if (handle) this.rt.launcher.stopsWithTurn(opened, sessionId, backend, handle)
    return true
  }

  forgetBackgroundTask(session: BackendSession, backend: AgentBackend, taskId: string, status: 'failed' | 'killed'): void {
    const { sessionId, agentSessionId } = session
    if (this.rt.activeSessions.get(sessionId) !== session || !session.backgroundTaskIds?.has(taskId)) return
    const event = { type: 'background_task_settled', taskId, status } as const
    this.settleBackgroundTask(session, event, agentSessionId ? backend.getSessionHandle(agentSessionId) : undefined, true)
    this.rt.publish(sessionId, event)
  }

  private settleBackgroundTask(
    session: BackendSession,
    event: Extract<NormalizedEvent, { type: 'background_task_settled' }>,
    eventHandle: RunHandle | undefined,
    endsWait: boolean,
  ): void {
    for (const [toolId, taskId] of session.lineageTaskIds ?? []) {
      if (taskId === event.taskId) session.lineageTaskIds?.delete(toolId)
    }
    session.backgroundTasks?.delete(event.taskId)
    if (session.backgroundTaskIds?.delete(event.taskId) && !session.backgroundTaskIds.size) {
      this.rt.publish(session.sessionId, { type: 'background_work', running: false })
    }
    session.awaitableTaskIds?.delete(event.taskId)
    session.awaitedTaskIds?.delete(event.taskId)
    log.info('task_settled', { taskId: event.taskId, status: event.status, sessionId: session.sessionId, inFlight: session.backgroundTaskIds?.size ?? 0 })
    // Claude's open query settles the session on its next result or exit.
    if (eventHandle) return
    if (endsWait) this.endBackgroundWait(session.sessionId)
    if (!session.backgroundTaskIds?.size && !isSessionBusyStatus(session.status) && session.status !== 'background') {
      this.rt.activeSessions.delete(session.sessionId)
    }
  }

  wire(backend: AgentBackend): void {
    backend.on('session-index-updated', (event) => {
      this.rt.emit('session-index-updated', event)
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
        this.rt.usageLimits.applyWindows(backend.id, event.windows)
        return
      }

      let initializedGoal: ThreadGoal | null = null

      // ─── Session-level state (always runs, even with nobody watching) ───

      if (event.type === 'session_init') {
        backend.permissions.setCurrentSessionId(event.sessionId)
        // Link the originating run to the freshly-issued provider thread.
        const initHandle = backend.getSessionHandle(event.sessionId)
        const pendingStart = initHandle ? this.rt.launcher.pendingStarts.get(initHandle) : undefined
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
          ?? this.rt.agentSessionToSession.get(event.sessionId)
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
          && this.rt.agentSessionToSession.get(event.sessionId) === initSessionId
        if (!alreadyRegistered) {
          const registered = registerSessionLineage({
            sessionId: initSessionId,
            provider: backend.id,
            providerSessionId: event.sessionId,
            cwd: pendingStart?.run.input.workingDirectory
              ?? this.rt.activeSessions.get(initSessionId)?.runInput?.workingDirectory
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
          const sourceRun = pendingStart?.run ?? this.rt.activeRunRequests.get(initSessionId)
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
        this.rt.agentSessionToSession.set(event.sessionId, initSessionId)
        const pendingHandoff = this.rt.handoffs.pendingHandoffs.get(initSessionId)
        if (pendingHandoff) {
          const handoffCwd = pendingStart?.run.input.workingDirectory
            ?? this.rt.activeSessions.get(initSessionId)?.runInput?.workingDirectory
            ?? getIndexedSession(event.sessionId)?.cwd
            ?? '~'
          try {
            completeSessionHandoff(initSessionId, backend.id, event.sessionId, handoffCwd)
            this.rt.handoffs.pendingHandoffs.delete(initSessionId)
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
            this.rt.launcher.pendingStarts.delete(initHandle)
            initializedRun = {
              ...pendingStart.run,
              target: { kind: 'session', sessionId: initSessionId },
              input: {
                ...pendingStart.run.input,
                agentSessionId: event.sessionId,
                forked: false,
              },
            }
            this.rt.activeRunRequests.set(initSessionId, initializedRun)
            // A created child's card knew it by its pending message; from here
            // its updates name the real thread.
            const startedRun = this.rt.runExchanges(initializedRun)
            if (startedRun) this.rt.orchestration?.sessionStarted(startedRun, initializedRun.input.workingDirectory)
            const started: Parameters<PendingStart['resolve']>[0] = { agentSessionId: event.sessionId }
            if (pendingStart.run.options.issueId) started.taskId = pendingStart.run.options.issueId
            pendingStart.resolve(started)
          }
        }
        // Preserve the run contract so a reattaching client (e.g. after a
        // refresh) can read back the live status, model config and permission
        // mode via bindRuntimeSession, and a backgrounded automation can
        // re-dispatch by run input alone. Without this.rt, a first-run session has
        // no runInput and bind returns null, leaving the session stuck at idle.
        const existingSession = this.rt.activeSessions.get(initSessionId)
        const runReqInput = this.rt.activeRunRequests.get(initSessionId)?.input ?? initializedRun?.input
        const restartRun = this.rt.restarts.restartRuns?.get(initSessionId)
        if (restartRun && !this.rt.isShuttingDown) {
          this.rt.restarts.restartRuns?.save({ ...restartRun, input: { ...restartRun.input, agentSessionId: event.sessionId }, state: 'running' })
        }
        // Every column the index row fills is COALESCE-guarded, and status has its
        // own writer, so a later init of the same thread only matters when the
        // model or effort the record shows has changed.
        const indexedStart = runReqInput ? `${runReqInput.model}\u0000${runReqInput.reasoningEffort}` : null
        if (runReqInput && indexedStart && this.indexedThreadStarts.get(event.sessionId) !== indexedStart) {
          this.indexedThreadStarts.set(event.sessionId, indexedStart)
          this.rt.statuses.recordStatusWritten.set(initSessionId, 'running')
          const forkSource = firstDispatchRun?.input.forked ? firstDispatchRun.input.agentSessionId : null
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
            firstDispatchRun?.startedBy,
            forkSource ? () => {
              const sourceId = sessionIdOfThread(forkSource)
              if (sourceId !== initSessionId) void emitSessionDigestChanged(sourceId).catch((error) => {
                log.warn('fork_lineage_notify_failed', { sessionId: initSessionId, error: String(error) })
              })
            } : undefined,
            this.rt.sessionFolders.recordFields(initSessionId),
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
          if ((existingSession.status === 'connecting' || !isSessionBusyStatus(existingSession.status))
            && this.runWorks(initSessionId, backend, initHandle)) {
            this.rt.statuses.refresh(initSessionId)
          }
        } else if (this.runWorks(initSessionId, backend, initHandle, initializedRun?.options.clientPromptId)) {
          this.rt.activeSessions.set(initSessionId, {
            sessionId: initSessionId,
            agentSessionId: event.sessionId,
            backendId: backend.id,
            status: 'running',
            pendingInputEvents: [],
            lastActivityAt: Date.now(),
            promptCount: 0,
            runInput: runReqInput,
            gitContext: runReqInput?.gitContext ?? undefined,
          })
          // Created directly as running — applyStatus never sees a transition,
          // so the global feed needs its own emit.
          this.rt.emit('session-status', { sessionId: initSessionId, agentSessionId: event.sessionId, status: 'running', at: Date.now() })
        }
        const goalObjective = initializedRun?.options.goalObjective
        if (backend.id === 'claude-code' && goalObjective) {
          initializedGoal = this.rt.claudeGoals.get(event.sessionId)
            ?? this.rt.claudeGoals.create({ threadId: event.sessionId, objective: goalObjective })
        }
        if (firstDispatchRun?.options.issueId) {
          // Task attempts use the stable Solus session id. The renderer writes
          // the same binding after session_init; using the provider thread id
          // here creates a second link that resolves to the same conversation.
          void linkPreparedTask(firstDispatchRun, initSessionId)
        }
        this.rt.statuses.notifyActiveWork()
      }

      const sessionId = this.rt.agentSessionToSession.get(agentSessionId)
      if (sessionId && event.type !== 'rate_limit') {
        turnActivity.observe(sessionId, event)
        this.rt.sessionFolders.observe(sessionId, event)
        this.rt.sessionEmitter.onEvent(sessionId, event)
      }
      const session = sessionId ? this.rt.activeSessions.get(sessionId) : undefined
      if (session) {
        session.lastActivityAt = Date.now()
        // The turn this event's run belongs to (plans/037 D3).
        const runTurn = (eventHandle && this.rt.turns.ofRun(eventHandle)) ?? this.rt.turns.current(session.sessionId)

        if (event.type === 'error' && event.kind === 'auth') {
          this.rt.expireSeatForTurn(this.rt.activeRunRequests.get(session.sessionId)?.actor, backend.id, event.message)
        }

        if (event.type === 'session_changed_files_updated') {
          this.rt.reportToActiveRun(session.sessionId, (run) => this.rt.orchestration?.runEvent(run, event))
        } else if (event.type === 'question_request' && event.responseMode === 'message') {
          if (!saveAsyncQuestion(session.sessionId, agentSessionId, event)) return
          this.rt.statuses.questionsChanged(agentSessionId, session.sessionId)
          this.rt.reportToActiveRun(session.sessionId, (run) => this.rt.orchestration?.runEvent(run, event))
        } else if (event.type === 'permission_request' || event.type === 'question_request') {
          session.hasPendingInput = true
          session.pendingInputEvents.push(event)
          this.rt.inputRequests.questionIdToSession.set(event.questionId, session.sessionId)
          this.rt.statuses.refresh(session.sessionId)
          this.rt.reportToActiveRun(session.sessionId, (run) => this.rt.orchestration?.inputRequested(run, event))
        } else if (event.type === 'plan') {
          const cwd = session.runInput?.workingDirectory ?? getIndexedSession(agentSessionId)?.cwd ?? '~'
          if (event.planToolUseId && event.planContent.trim()) {
            const planToolUseId = event.planToolUseId
            void indexLivePlan({
              provider: backend.id,
              sessionId: session.sessionId,
              threadId: agentSessionId,
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
          // A plan is named by its session and its tool use.
          if (event.planToolUseId) {
            void linkSessionOutput(ANY_ORGANIZATION, session.sessionId, {
              kind: 'plan',
              targetScope: session.sessionId,
              targetKey: event.planToolUseId,
            }).catch((error) => {
              log.warn('task_plan_link_failed', {
                sessionId: session.sessionId,
                planToolUseId: event.planToolUseId,
                error: error instanceof Error ? error.message : String(error),
              })
            })
          }
          session.hasPendingInput = true
          session.pendingInputEvents.push(event)
          this.rt.inputRequests.questionIdToSession.set(event.questionId, session.sessionId)
          const status = this.rt.statuses.pendingInputStatus(session)
          this.rt.statuses.refresh(session.sessionId)
          this.rt.reportToActiveRun(session.sessionId, (run) => {
            this.rt.orchestration?.runEvent(run, event)
            if (status === 'awaiting_input' || status === 'awaiting_plan') this.rt.orchestration?.inputRequested(run, event)
          })
        } else if (event.type === 'permission_resolved') {
          this.rt.inputRequests.nameDecision(event)
          session.pendingInputEvents = session.pendingInputEvents.filter(
            (pendingEvent) => !eventHasQuestionId(pendingEvent, event.questionId),
          )
          this.rt.inputRequests.questionIdToSession.delete(event.questionId)
          session.hasPendingInput = session.pendingInputEvents.length > 0
          this.rt.statuses.refresh(session.sessionId)
        }

        // A work the turn made is part of what it answers its senders with.
        if (event.type === 'work_created' || event.type === 'artifact_created') {
          this.rt.reportToActiveRun(session.sessionId, (run) => this.rt.orchestration?.runEvent(run, event))
        }

        // Both task lifecycle events fall through to delivery below: an async
        // sub-agent's card can only track the agent through them, since the SDK
        // answers its tool call at launch rather than at completion.
        if (event.type === 'background_task_started') {
          const wasRunning = !!session.backgroundTaskIds?.size
          ;(session.backgroundTaskIds ??= new Set()).add(event.taskId)
          if (event.kind) (session.backgroundTasks ??= new Map()).set(event.taskId, { taskId: event.taskId, kind: event.kind, ...(event.description && { description: event.description }) })
          if (event.lineageTask) (session.lineageTaskIds ??= new Map()).set(event.toolUseId ?? event.taskId, event.taskId)
          if (!wasRunning) this.rt.publish(session.sessionId, { type: 'background_work', running: true })
          if (event.awaitable) (session.awaitableTaskIds ??= new Set()).add(event.taskId)
          log.info('task_started', { taskId: event.taskId, sessionId: session.sessionId, inFlight: session.backgroundTaskIds.size, awaitable: !!event.awaitable })
          // A task can be backgrounded after the turn already settled to idle;
          // pull the session back to running so it reflects the in-flight work.
          if (!isSessionBusyStatus(session.status) && this.runWorks(session.sessionId, backend, eventHandle)) {
            this.rt.statuses.refresh(session.sessionId)
          }
        }

        if (event.type === 'background_task_settled') {
          this.settleBackgroundTask(session, event, eventHandle, event.status === 'stopped' || event.status === 'killed')
        }

        if (event.type === 'task_complete') {
          const handle = backend.getSessionHandle(agentSessionId)
          if (handle) handle.resultText = event.result
        }

        // The result of an older run, or of a run whose turn was stopped, does
        // not end the session's current turn.
        const endsCurrentTurn = !runTurn || (runTurn === this.rt.turns.current(session.sessionId) && runTurn.outcome !== 'interrupted')
        if (event.type === 'task_complete' && endsCurrentTurn) {
          const endedTurn = runTurn ?? this.rt.turns.begin(session.sessionId, { phase: 'running' })
          // Before the actor of the run is forgotten: a folder that the turn wrote outside its folders is shown for review.
          void this.rt.sessionFolders.attachObserved(session.sessionId)
          this.rt.activeRunRequests.delete(session.sessionId)
          // The agent is done, but the SDK query stays open while its background
          // tasks run and emits exit only once they settle. Work the agent waits
          // on settles the turn into 'background'. Work it leaves running (a dev
          // server, a log tail) does not: the turn completes and notifies, and
          // the query stays open for that work (docs/background-work.md). The
          // sessions the agent sent work to hold it too, until they report.
          const isAwaitingReplies = this.rt.statuses.holdsOutsideRun(session.sessionId)
          if (isAwaitingReplies || session.backgroundTaskIds?.size) {
            const holds = isAwaitingReplies || backgroundWorkHolds(session)
            log.info('turn_complete_tasks_in_flight', { sessionId: session.sessionId, inFlight: session.backgroundTaskIds?.size ?? 0, isAwaitingReplies, holds })
            // Work that holds gives 'background': the settlement goes out when the wait ends.
            this.rt.statuses.endTurn(session.sessionId, 'completed', endedTurn)
            this.rt.scheduler.processQueueForSession(session.sessionId)
          } else if (this.rt.scheduler.hasReadyQueuedRequest(session.sessionId)) {
            // A queued prompt takes over at the exit: the session is not done,
            // so it stays running and no "completed" reaches any client. The
            // turn itself is over, and settles for those who wait on it.
            log.info('turn_complete_queue_takes_over', { sessionId: session.sessionId })
            endedTurn.handOverToQueue(true)
            this.rt.statuses.queueTurnSettlement(session.sessionId, 'completed', endedTurn)
          } else {
            this.rt.statuses.endTurn(session.sessionId, 'completed', endedTurn)
          }
        }

        if (event.type === 'rate_limit') {
          const rateLimitEvent = this.rt.rateLimitPark.rateLimits.record(session.sessionId, this.rt.rateLimitPark.prepareRateLimit(backend.id, event))
          if (!rateLimitEvent) return
          event = rateLimitEvent
        }

        if (event.type === 'rate_limit' && event.status !== 'allowed' && !event.isUsingOverage
          && runTurn?.signal.aborted) {
          // A person stopped this turn before its limit arrived. Stop wins: the
          // turn settles as interrupted, and its prompt is not held or re-queued.
          this.rt.rateLimitPark.rateLimits.clear(session.sessionId)
          return
        }

        if (event.type === 'rate_limit' && event.status !== 'allowed' && !event.isUsingOverage) {
          const run = this.rt.activeRunRequests.get(session.sessionId)
          const deferCurrentRun = event.deferCurrentRun === true && !!run
          this.rt.rateLimitPark.scheduleRateLimitRelease(session.sessionId, event.resetsAt)
          if (deferCurrentRun) {
            // Codex can report that the account is exhausted while it is still
            // completing the current turn. Keep that snapshot for the next send,
            // but do not interrupt the stream or present it as a failed prompt.
            return
          }

          this.rt.sessionEmitter.acceptRateLimit(session.sessionId, event.rateLimitType)
          // The run keeps the behaviour its sender chose (plans/018 §3.1): it is
          // carried with the run and its queue entry, so another client's later
          // edit does not change it.
          if (run?.input.rateLimitBehavior === 'queue') {
            this.rt.rateLimitPark.queueActiveRateLimitedRequest(session.sessionId)
          }
          // Publish the queue before the status so clients cannot briefly show
          // a decision card for a retry the host already chose to queue.
          this.rt.statuses.park(session.sessionId, runTurn)
          // The run keeps its exchanges whether it waits in the queue for the
          // reset or on a person's decision; its senders hear it is parked.
          const parked = run ? this.rt.runExchanges(run) : null
          // The event counts seconds; the orchestrator's readers count milliseconds.
          if (parked) this.rt.orchestration?.runRateLimited(parked, { resetsAt: event.resetsAt === null ? undefined : event.resetsAt * 1000, limitType: event.rateLimitType })
        }
      }

      if (!session && event.type === 'rate_limit') {
        // No session record to key the limit against; without one there is
        // nothing to hold the snapshot for, so route the event through as-is.
        if (!sessionId) return
        const rateLimitEvent = this.rt.rateLimitPark.rateLimits.record(sessionId, this.rt.rateLimitPark.prepareRateLimit(backend.id, event))
        if (!rateLimitEvent) return
        event = rateLimitEvent
      }

      if (!sessionId) return
      this.rt.inputRequests.stampTurnAuthor(sessionId, event)
      this.rt.activity.observe(sessionId, event)

      // ─── Delivery ───
      //
      // No early return when nobody is watching: a session with an empty watch
      // set is an ordinary count, and the buffering and turn accumulation below
      // still have to happen so a client that joins later sees the turn.

      if (event.type === 'text_chunk') {
        // The delivery the run was dispatched with, so a second client's setting cannot change it mid-stream.
        const streamingMode = this.rt.activeRunRequests.get(sessionId)?.input.executionPreferences?.responseStreamingMode
          ?? DEFAULT_EXECUTION_PREFERENCES.responseStreamingMode
        for (const delivered of this.rt.responseText.append(sessionId, event, streamingMode, Date.now())) {
          this.rt.publish(sessionId, delivered)
        }
        return
      }

      if (backend.id === 'claude-code' && event.type === 'task_complete') {
        const goal = this.rt.claudeGoals.recordCompletedTurn(agentSessionId, event.usage, event.durationMs)
        if (goal) this.rt.publish(sessionId, { type: 'goal_updated', goal })
      }
      if (backend.id === 'claude-code' && event.type === 'usage' && event.partialTurn) {
        const goal = this.rt.claudeGoals.recordCompletedTurn(agentSessionId, event.partialTurn.usage, event.partialTurn.durationMs ?? 0)
        if (goal) this.rt.publish(sessionId, { type: 'goal_updated', goal })
      }

      this.rt.publish(sessionId, event)
      if (initializedGoal) this.rt.publish(sessionId, { type: 'goal_updated', goal: initializedGoal })
    })

    backend.on('exit', (agentSessionId: string | null, code: number | null, signal: string | null, run?: RunHandle) => {
      if (agentSessionId) this.rt.inputRequests.expirePendingInput(backend, agentSessionId)

      // The sessions this exit settles: the one the provider named, or the run
      // that ended, which knows its own Solus id. Only an exit with neither may
      // belong to any pending run on this backend.
      const exitedRuns = run ? [run] : agentSessionId ? [] : backend.getPendingHandles()
      const namedSessionId = agentSessionId ? this.rt.agentSessionToSession.get(agentSessionId) : undefined
      const settledSessionIds = namedSessionId
        ? [namedSessionId]
        : [...new Set(
            exitedRuns
              .map((handle) => handle.sessionId)
              .filter((id): id is string => !!id),
          )]

      // No early return when nobody is watching: a headless agent (created via
      // start_sessions, card not yet opened) still needs its exit lifecycle —
      // status broadcast, cleanup, and above all the queue drain, or prompts
      // relayed into it while busy would hang forever.
      for (const handle of exitedRuns) {
        const pending = this.rt.launcher.pendingStarts.get(handle)
        if (pending) {
          this.rt.launcher.pendingStarts.delete(handle)
          pending.reject(new Error(`Run exited before session_init`))
        }
      }

      for (const sessionId of settledSessionIds) {
        // The turn of the run that exited (plans/037 D3). The exit of an older
        // run settles that run's turn only: a newer turn owns the session, with
        // its record, its log, and its status.
        const current = this.rt.turns.current(sessionId)
        const exitTurn = (run && this.rt.turns.ofRun(run)) ?? current
        if (exitTurn && exitTurn !== current) {
          this.rt.statuses.queueTurnSettlement(sessionId, exitOutcome(exitTurn.signal.aborted, code, signal), exitTurn)
          this.rt.scheduler.processQueueForSession(sessionId)
          continue
        }
        this.rt.flushPendingSession(sessionId)
        // The turn is over, so its replay log has done its job — durable history
        // covers it from here. Cleared after the flush so the final text is logged
        // for anyone binding in the same tick.
        this.rt.missingRunCounts.delete(sessionId)

        const rateLimitEvent = this.rt.rateLimitPark.currentRateLimitEvent(sessionId)
        const hasPendingRateLimit = rateLimitEvent != null
        const exitWasRateLimited = hasPendingRateLimit && rateLimitEvent.deferCurrentRun !== true
        const outcome = exitOutcome(!!exitTurn?.signal.aborted, code, signal)
        // Codex tasks outlive the turn; keep their wait policy until they end.
        const exited = this.rt.activeSessions.get(sessionId)
        const hasBackgroundWork = !!agentSessionId && !!backend.hasBackgroundTasks?.(agentSessionId)
        // A Claude task that the exit killed sends no settle: its row leaves here.
        if (exited?.backgroundTaskIds?.size && !hasBackgroundWork) {
          exited.backgroundTaskIds.clear()
          exited.backgroundTasks?.clear()
          exited.awaitedTaskIds = exited.awaitableTaskIds = undefined
          this.rt.publish(sessionId, { type: 'background_work', running: false })
        }
        this.rt.sessionEmitter.recordTerminal(
          sessionId,
          exitWasRateLimited || outcome === 'completed' ? 'ok' : outcome === 'interrupted' ? 'interrupted' : 'error',
        )

        // The run's turn ends. A parked turn does not settle: its prompt runs
        // again as a new turn (plans/037 D7). Work that holds after the exit
        // gives 'background', and the wait ends as the turn's outcome.
        const turn = exitTurn ?? this.rt.turns.begin(sessionId, { phase: 'running' })
        if (exitWasRateLimited) turn.park()
        else turn.settle(outcome)
        // A queued prompt that left before the exit no longer takes over.
        turn.handOverToQueue(false)
        const newStatus = this.rt.statuses.derive(sessionId)

        // Settle the status while the record still exists, so `applyStatus`
        // reads the real previous status and the global feed and the watching
        // clients each learn the transition exactly once. A queued prompt about
        // to take over suppresses the terminal presentation status. The queue
        // is checked before dispatch, because the drain must happen after
        // the teardown below or it would delete the record its own run creates.
        if (agentSessionId) {
          try { this.rt.handoffs.handoffCarry.settle(agentSessionId, newStatus, this.rt.turnLog.get(sessionId) ?? [], Date.now()) }
          catch (error) { log.error('handoff_carry_save_failed', { sessionId, error: String(error) }) }
        }
        this.rt.turnLog.delete(sessionId)
        const queueWillTakeOver = (newStatus === 'interrupted' || newStatus === 'completed') && this.rt.scheduler.hasReadyQueuedRequest(sessionId)
        if (!queueWillTakeOver) this.rt.statuses.refresh(sessionId)
        else if (exited) {
          // The UI can skip a status as the queue takes over, but the run still ends.
          if (newStatus === 'completed') turn.handOverToQueue(true)
          this.rt.statuses.queueTurnSettlement(sessionId, newStatus === 'completed' ? 'completed' : 'interrupted', turn)
        }
        // A wait on reports alone is no interrupted work: after a host restart
        // the reports still come through the exchanges' own recovery.
        if (newStatus === 'background' && !hasBackgroundWork) this.rt.restarts.restartRuns?.remove(sessionId)

        if (!hasPendingRateLimit) {
          // Running tasks stay resident even after completion, so they can be
          // stopped; a session that waits on reports stays to show its wait.
          if (newStatus !== 'background' && !hasBackgroundWork) this.rt.activeSessions.delete(sessionId)
          this.rt.activeRunRequests.delete(sessionId)
        }

        if (!exitWasRateLimited && (outcome === 'failed' || outcome === 'dead')) {
          this.rt.emitError(sessionId, backend.getEnrichedError(agentSessionId, code))
        }

        this.rt.scheduler.processQueueForSession(sessionId)
      }
    })

    backend.on('background-task-completed', (agentSessionId: string, prompt: string, via: PromptVia | undefined) => {
      const sessionId = this.rt.sessionOfThread(agentSessionId)
      if (!sessionId) return
      // The wake turn answers the exchanges the backgrounded run left open.
      const exchangeIds = this.rt.orchestration?.backgroundExchangeIds(sessionId)
      void this.rt.dispatch.promptSession(sessionId, prompt, 'queue', { via, exchangeIds }).catch((error) => {
        log.warn('background_task_wake_failed', { agentSessionId, error: error instanceof Error ? error.message : String(error) })
        // No turn takes over, so the wait the task held ends here.
        const sessionId = this.rt.agentSessionToSession.get(agentSessionId)
        if (sessionId) this.endBackgroundWait(sessionId)
      })
    })

    // A thread that continues in a new agent session by handoff gets the same divider as a switch.
    backend.on('thread-handed-off', (agentSessionId: string, model: string | null) => {
      const sessionId = this.rt.sessionOfThread(agentSessionId)
      // The handoff happens in a run, as the person whose turn it is.
      const actor = sessionId ? this.rt.activeRunRequests.get(sessionId)?.actor : undefined
      if (!sessionId || !actor) return
      const handedOff: Extract<ActivityKind, { kind: 'agent_switched' }> = { kind: 'agent_switched', provider: backend.id, fromProvider: backend.id }
      if (model) handedOff.model = model
      void this.rt.recordActivity({ kind: 'session', id: sessionId }, actor, handedOff)
    })

    backend.on('background-work-ended', (agentSessionId: string) => {
      const sessionId = this.rt.agentSessionToSession.get(agentSessionId)
      if (sessionId) this.endBackgroundWait(sessionId)
    })

    backend.on('error', (agentSessionId: string | null, err: Error, run?: RunHandle) => {
      if (agentSessionId) this.rt.inputRequests.expirePendingInput(backend, agentSessionId)

      // One backend runs many sessions: an error that names its run fails that
      // run only. Without a run or a provider id, any pending run may be the one.
      const failedRuns = run ? [run] : agentSessionId ? [] : backend.getPendingHandles()
      const namedSessionId = agentSessionId ? this.rt.agentSessionToSession.get(agentSessionId) : undefined
      const failedSessionIds = namedSessionId
        ? [namedSessionId]
        : [...new Set(
            failedRuns
              .map((handle) => handle.sessionId)
              .filter((id): id is string => !!id),
          )]

      for (const handle of failedRuns) {
        const pending = this.rt.launcher.pendingStarts.get(handle)
        if (pending) {
          this.rt.launcher.pendingStarts.delete(handle)
          pending.reject(err)
        }
      }

      for (const sessionId of failedSessionIds) {
        // As at an exit: the error of an older run ends that run's turn only,
        // and a run that was stopped ends as stopped (plans/037 D3).
        const current = this.rt.turns.current(sessionId)
        const failedTurn = (run && this.rt.turns.ofRun(run)) ?? current
        const outcome = failedTurn?.signal.aborted ? 'interrupted' : 'dead'
        if (failedTurn && failedTurn !== current) {
          this.rt.statuses.queueTurnSettlement(sessionId, outcome, failedTurn)
          continue
        }
        this.rt.sessionEmitter.recordTerminal(sessionId, 'error')
        const rateLimitEvent = this.rt.rateLimitPark.currentRateLimitEvent(sessionId)
        this.rt.missingRunCounts.delete(sessionId)

        if (rateLimitEvent) {
          this.rt.statuses.park(sessionId, failedTurn)
          this.rt.publish(sessionId, rateLimitEvent)
          continue
        }

        // Status first, while the record still exists, so the transition is
        // published once rather than once here and once from applyStatus.
        this.rt.statuses.endTurn(sessionId, outcome, failedTurn)
        this.rt.activeSessions.delete(sessionId)
        this.rt.activeRunRequests.delete(sessionId)
        clearForeignTaskSnapshot(sessionId)

        const enriched = backend.getEnrichedError(agentSessionId, null)
        enriched.message = err.message
        this.rt.emitError(sessionId, enriched)
      }
    })
  }
}
