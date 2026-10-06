import { createLogger } from '../../logger'
import { Task } from '../../data/tasks/task'
import { saveAsyncQuestion } from '../../data/sessions/async-questions'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { applyPendingAssignment } from './turn-organization'
import { clearForeignTaskSnapshot } from '../../data/tasks/foreign-tasks'
import { getIndexedSession, persistIndexedSessionStart } from '../../db/session-indexer'
import { completeSessionHandoff, registerSessionLineage, replaceSessionLineageThread } from '../../data/sessions/session-lineage'
import type { AgentBackend } from '../agents/agent-backend'
import type { SessionStatus, NormalizedEvent, ThreadGoal } from '@solus/contracts/types'
import { encodePathAsFolder, isSessionBusyStatus } from '@solus/contracts/types'
import { indexLivePlan } from '../../plans/plan-index'
import type { SessionRuntime } from '../session-runtime'
import { eventHasQuestionId } from './input-requests'
import type { PendingStart } from './run-launcher'
import { linkPreparedTask } from './run-task-context'

const log = createLogger('SessionRuntime', 'provider-events.ts')

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

  /** Settle a session that waits in 'background' with no query open (Codex)
   *  once nothing is left running and no turn takes over. */
  private endBackgroundWait(sessionId: string): void {
    const session = this.rt.activeSessions.get(sessionId)
    if (session?.status !== 'background' || session.backgroundTaskIds?.size) return
    this.rt.statuses.setStatus(sessionId, 'completed')
    this.rt.activeSessions.delete(sessionId)
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
            if (pendingStart.run.options.taskId) started.taskId = pendingStart.run.options.taskId
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
          // The status write below is skipped as already written, so an
          // admitted or inherited organization lands here, before the record
          // is born, not at the turn's end.
          applyPendingAssignment(initSessionId)
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
            this.rt.statuses.setStatus(initSessionId, 'running')
          }
        } else {
          this.rt.activeSessions.set(initSessionId, {
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
          // Created directly as running — applyStatus never sees a transition,
          // so the global feed needs its own emit.
          this.rt.emit('session-status', { sessionId: initSessionId, agentSessionId: event.sessionId, status: 'running', at: Date.now() })
        }
        const goalObjective = initializedRun?.options.goalObjective
        if (backend.id === 'claude-code' && goalObjective) {
          initializedGoal = this.rt.claudeGoals.get(event.sessionId)
            ?? this.rt.claudeGoals.create({ threadId: event.sessionId, objective: goalObjective })
        }
        if (firstDispatchRun?.options.taskId) {
          // Task attempts use the stable Solus session id. The renderer writes
          // the same binding after session_init; using the provider thread id
          // here creates a second link that resolves to the same conversation.
          void linkPreparedTask(firstDispatchRun, initSessionId)
        }
        this.rt.statuses.notifyActiveWork()
      }

      const sessionId = this.rt.agentSessionToSession.get(agentSessionId)
      if (sessionId && event.type !== 'rate_limit') {
        this.rt.sessionEmitter.onEvent(sessionId, event)
      }
      const session = sessionId ? this.rt.activeSessions.get(sessionId) : undefined
      if (session) {
        session.lastActivityAt = Date.now()

        if (event.type === 'session_changed_files_updated') {
          if (session.runInput) session.runInput.sessionChangedFiles = [...event.paths]
          const activeRequest = this.rt.activeRunRequests.get(session.sessionId)
          if (activeRequest) activeRequest.input.sessionChangedFiles = [...event.paths]
          this.rt.reportToActiveRun(session.sessionId, (run) => this.rt.orchestration?.runEvent(run, event))
        } else if (event.type === 'question_request' && event.responseMode === 'message') {
          if (!saveAsyncQuestion(session.sessionId, agentSessionId, event)) return
          this.rt.statuses.syncAttention(agentSessionId, session.sessionId, session.status)
          this.rt.reportToActiveRun(session.sessionId, (run) => this.rt.orchestration?.runEvent(run, event))
        } else if (event.type === 'permission_request' || event.type === 'question_request') {
          session.hasPendingInput = true
          session.pendingInputEvents.push(event)
          this.rt.inputRequests.questionIdToSession.set(event.questionId, session.sessionId)
          this.rt.statuses.setStatus(session.sessionId, 'awaiting_input')
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
            void Task.linkSessionOutput(ANY_ORGANIZATION, session.sessionId, {
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
          this.rt.statuses.setStatus(session.sessionId, status)
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
          this.rt.statuses.setStatus(session.sessionId, this.rt.statuses.pendingInputStatus(session))
        }

        // A work the turn made is part of what it answers its senders with.
        if (event.type === 'work_created' || event.type === 'artifact_created') {
          this.rt.reportToActiveRun(session.sessionId, (run) => this.rt.orchestration?.runEvent(run, event))
        }

        // Both task lifecycle events fall through to delivery below: an async
        // sub-agent's card can only track the agent through them, since the SDK
        // answers its tool call at launch rather than at completion.
        if (event.type === 'background_task_started') {
          ;(session.backgroundTaskIds ??= new Set()).add(event.taskId)
          log.info('task_started', { taskId: event.taskId, sessionId: session.sessionId, inFlight: session.backgroundTaskIds.size })
          // A task can be backgrounded after the turn already settled to idle;
          // pull the session back to running so it reflects the in-flight work.
          if (!isSessionBusyStatus(session.status)) this.rt.statuses.setStatus(session.sessionId, 'running')
        }

        if (event.type === 'background_task_settled') {
          session.backgroundTaskIds?.delete(event.taskId)
          log.info('task_settled', { taskId: event.taskId, status: event.status, sessionId: session.sessionId, inFlight: session.backgroundTaskIds?.size ?? 0 })
          // A still-open query (Claude) drives the real terminal status via its
          // next task_complete or its exit. A provider whose turn already ended
          // (Codex) has no query: a task that finished wakes the agent with a
          // new turn, and one that was stopped or killed ends the wait here.
          if (!eventHandle && (event.status === 'stopped' || event.status === 'killed')) this.endBackgroundWait(session.sessionId)
        }

        if (event.type === 'task_complete') {
          const handle = backend.getSessionHandle(agentSessionId)
          if (handle) handle.resultText = event.result
          this.rt.activeRunRequests.delete(session.sessionId)
          // The agent is done, but the SDK query stays open while its background
          // tasks run and emits exit only once they settle. A task that never
          // ends (a log tail, a dev server) would otherwise hold 'running' for
          // the life of the query, so the turn settles into 'background'.
          if (this.rt.orchestration?.isAwaitingReplies(session.sessionId)) {
            log.info('turn_complete_awaiting_agent_reply', { sessionId: session.sessionId, holdingRunning: true })
          } else if (session.backgroundTaskIds?.size) {
            log.info('turn_complete_tasks_in_flight', { sessionId: session.sessionId, inFlight: session.backgroundTaskIds.size })
            this.rt.statuses.setStatus(session.sessionId, 'background')
            this.rt.scheduler.processQueueForSession(session.sessionId)
          } else {
            this.rt.statuses.setStatus(session.sessionId, 'completed')
          }
        }

        if (event.type === 'rate_limit') {
          const rateLimitEvent = this.rt.rateLimitPark.rateLimits.record(session.sessionId, this.rt.rateLimitPark.prepareRateLimit(backend.id, event))
          if (!rateLimitEvent) return
          event = rateLimitEvent
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
          this.rt.statuses.setStatus(session.sessionId, 'rate_limited')
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

      this.rt.publish(sessionId, event)
      if (initializedGoal) this.rt.publish(sessionId, { type: 'goal_updated', goal: initializedGoal })
    })

    backend.on('exit', (agentSessionId: string | null, code: number | null, signal: string | null) => {
      if (agentSessionId) this.rt.inputRequests.expirePendingInput(backend, agentSessionId)

      // The sessions this exit settles: the one the provider named, or — when it
      // died before ever issuing a thread — whatever runs are still pending on
      // this backend, each of which already knows its own Solus id.
      const namedSessionId = agentSessionId ? this.rt.agentSessionToSession.get(agentSessionId) : undefined
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
        const pending = this.rt.launcher.pendingStarts.get(handle)
        if (pending) {
          this.rt.launcher.pendingStarts.delete(handle)
          pending.reject(new Error(`Run exited before session_init`))
        }
      }

      for (const sessionId of settledSessionIds) {
        this.rt.flushPendingSession(sessionId)
        // The turn is over, so its replay log has done its job — durable history
        // covers it from here. Cleared after the flush so the final text is logged
        // for anyone binding in the same tick.
        this.rt.missingRunCounts.delete(sessionId)

        const rateLimitEvent = this.rt.rateLimitPark.currentRateLimitEvent(sessionId)
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
        // A provider whose background work outlives the turn (Codex) settles
        // into 'background', as Claude's open query does. Claude's tasks end
        // with its query, so its exit never leaves any.
        const hasBackgroundWork = !!agentSessionId && !!backend.hasBackgroundTasks?.(agentSessionId)
        const newStatus: SessionStatus = settledStatus !== 'completed'
          ? settledStatus
          : this.rt.orchestration?.isAwaitingReplies(sessionId)
            ? 'running'
            : hasBackgroundWork
              ? 'background'
              : settledStatus
        this.rt.sessionEmitter.recordTerminal(
          sessionId,
          settledStatus === 'completed' || settledStatus === 'rate_limited'
            ? 'ok'
            : settledStatus === 'interrupted'
              ? 'interrupted'
              : 'error',
        )

        // Settle the status while the record still exists, so `applyStatus`
        // reads the real previous status and the global feed and the watching
        // clients each learn the transition exactly once. A queued prompt about
        // to take over is not a settlement, so it suppresses the terminal
        // status — asked, not dispatched, because the drain must happen after
        // the teardown below or it would delete the record its own run creates.
        const status = this.rt.activeSessions.get(sessionId)?.status
        if (agentSessionId) {
          try { this.rt.handoffs.handoffCarry.settle(agentSessionId, newStatus, this.rt.turnLog.get(sessionId) ?? [], Date.now()) }
          catch (error) { log.error('handoff_carry_save_failed', { sessionId, error: String(error) }) }
        }
        this.rt.turnLog.delete(sessionId)
        const queueWillTakeOver = newStatus === 'interrupted' && this.rt.scheduler.hasReadyQueuedRequest(sessionId)
        const wasStarting = status === 'connecting' || (newStatus === 'interrupted' && status === 'running')
        if (!queueWillTakeOver && !wasStarting) this.rt.statuses.setStatus(sessionId, newStatus)

        if (!hasPendingRateLimit) {
          // A session in 'background' stays resident: its tasks settle and stop through it.
          if (newStatus !== 'background') this.rt.activeSessions.delete(sessionId)
          this.rt.activeRunRequests.delete(sessionId)
        }

        if (newStatus === 'failed' || newStatus === 'dead') {
          this.rt.emitError(sessionId, backend.getEnrichedError(agentSessionId, code))
        }

        this.rt.scheduler.processQueueForSession(sessionId)
      }
    })

    backend.on('background-command-completed', (agentSessionId: string, prompt: string) => {
      const sessionId = this.rt.sessionOfThread(agentSessionId)
      if (!sessionId) return
      void this.rt.dispatch.promptSession(sessionId, prompt, 'queue', { via: 'background-command' }).catch((error) => {
        log.warn('background_command_wake_failed', { agentSessionId, error: error instanceof Error ? error.message : String(error) })
        // No turn takes over, so the wait the command held ends here.
        const sessionId = this.rt.agentSessionToSession.get(agentSessionId)
        if (sessionId) this.endBackgroundWait(sessionId)
      })
    })

    backend.on('error', (agentSessionId: string | null, err: Error) => {
      if (agentSessionId) this.rt.inputRequests.expirePendingInput(backend, agentSessionId)

      const namedSessionId = agentSessionId ? this.rt.agentSessionToSession.get(agentSessionId) : undefined
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
        const pending = this.rt.launcher.pendingStarts.get(handle)
        if (pending) {
          this.rt.launcher.pendingStarts.delete(handle)
          pending.reject(err)
        }
      }

      for (const sessionId of failedSessionIds) {
        this.rt.sessionEmitter.recordTerminal(sessionId, 'error')
        const rateLimitEvent = this.rt.rateLimitPark.currentRateLimitEvent(sessionId)
        this.rt.missingRunCounts.delete(sessionId)

        if (rateLimitEvent) {
          this.rt.statuses.setStatus(sessionId, 'rate_limited')
          this.rt.publish(sessionId, rateLimitEvent)
          continue
        }

        // Status first, while the record still exists, so the transition is
        // published once rather than once here and once from applyStatus.
        this.rt.statuses.setStatus(sessionId, 'dead')
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
