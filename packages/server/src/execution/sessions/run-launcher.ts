import { existsSync } from 'node:fs'
import { withWorkspaceToolAuthority } from '../../admission/workspace-tool-authority'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import { installedRoutingProviders, routeModelPrompt } from '../agents/model-routing'
import { forkedFrom } from './thread-activity'
import { createLogger } from '../../logger'
import { captureServerEvent } from '../../analytics'
import { computeGitState } from '../../git/git-helpers'
import { warmFinder } from '../../files/file-finder'
import type { AgentTool } from '../agents/tools/agent-tool'
import { createClaudeSubagentAgentTool } from '../agents/claude/claude-subagent-tool'
import { createCodexSubagentAgentTool } from '../agents/codex/codex-subagent-tool'
import { resolvePromptImages } from '../agents/prompt-image-refs'
import { unattendedModelInputFor, providerConversationFor } from '../agents/run-input'
import { composeHandoffSeed } from '../agents/session-handoff'
import { buildSystemPrompt } from '../agents/system-hint'
import { tasksForSession } from '../../data/tasks/task-sessions'
import { recordSessionPrompt } from '../../data/sessions/session-states'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { setForeignTaskSnapshot } from '../../data/tasks/foreign-tasks'
import { resolveSessionLineageById } from '../../data/sessions/session-lineage'
import { ANSWERING_ANOTHER_SESSION } from '../orchestration/session-orchestrator'
import type { RunHandle } from '../agents/agent-backend'
import type { BackendSession, SessionStatus, NormalizedEvent, GitCheckout, PromptOptions, PromptDelivery, SessionRunInput, StatusCardState, StatusCardStep } from '@solus/contracts/types'
import { gitCheckoutFromState, projectScopeOf } from '@solus/contracts/types'
import { annotateDispatch, dispatchStep, dispatchStepSync } from '../observability/session-emitter'
import { SeatRequiredError } from '../seats/seat-manager'
import { HOST_ACTOR, insightsAccountOf, withActorCredentials, type Actor } from '../../admission/actor'
import { userKey } from '@solus/contracts/user'
import { SPAN_SERVICES } from '../../data/insights/registries'
import type { SessionRuntime, SessionRunRequest, SessionRunLifecycle } from '../session-runtime'
import { taskOfTurn, linkPreparedTask, taskSystemContext, logNewSessionPrompt } from './run-task-context'

const log = createLogger('SessionRuntime', 'run-launcher.ts')

export interface PendingStart {
  run: SessionRunRequest
  resolve: (value: { agentSessionId: string; taskId?: string }) => void
  reject: (reason: Error) => void
}

function startedSession(agentSessionId: string, taskId?: string): Parameters<PendingStart['resolve']>[0] {
  const result: Parameters<PendingStart['resolve']>[0] = { agentSessionId }
  if (taskId) result.taskId = taskId
  return result
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

/**
 * Starting a run: worktree and model setup, the provider launch, steering
 * into a turn that is open, and the lifecycle a caller waits on.
 */
export class RunLauncher {
  pendingStarts = new Map<RunHandle, PendingStart>()
  /** Worktree setup begins before an agent RunHandle exists, so it needs its
   *  own cancellation path for Stop/Ctrl-C. */
  pendingSetupControllers = new Map<string, AbortController>()
  /** Full prompt retained until a failed setup is retried or cancelled on any client. */
  failedSetupPrompts = new Map<string, PromptOptions>()

  constructor(private readonly rt: SessionRuntime) {}

  /** The transcript echo for a prompt whose sender is waiting on us to render
   *  it — every other client gets the same event from the run itself. */
  userMessageEvent(
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
    }
    return event
  }

  async steerActiveTurn(
    request: SessionRunRequest,
    agentSessionId: string,
    session: BackendSession,
  ): Promise<SessionRunLifecycle | null> {
    const backend = this.rt.backendFor(session.backendId)
    const handle = await backend.steerSession(agentSessionId, {
      prompt: request.options.prompt,
      imageAttachments: await resolvePromptImages(request.options),
    })
    if (!handle) return null
    // A steer is answered by the turn that accepted it. Its exchanges join that
    // turn now, in the same microtask the acceptance resolved in, before any
    // event of that turn's end can be handled, so they settle with it and hear
    // its questions.
    if (request.reportExchangeIds?.length) this.rt.orchestration?.reportsAccepted(request.reportExchangeIds)
    const steeredIds = request.exchangeIds?.splice(0) ?? []
    if (steeredIds.length) {
      const activeRun = this.rt.activeRunRequests.get(request.sessionId)
      if (activeRun?.runId) {
        (activeRun.exchangeIds ??= []).push(...steeredIds)
        this.rt.orchestration?.runStarted({ runId: activeRun.runId, sessionId: request.sessionId, exchangeIds: steeredIds })
      } else {
        // A backgrounded turn has already released its run record.
        request.exchangeIds = steeredIds
        const steered = this.rt.runExchanges(request)
        if (steered) this.rt.orchestration?.runStarted(steered)
        void handle.runPromise.then(
          () => this.rt.settleRunExchanges(request, handle.abortController.signal.aborted ? 'interrupted' : 'completed', handle, {}),
          () => this.rt.settleRunExchanges(request, handle.abortController.signal.aborted ? 'interrupted' : 'failed', handle, {}),
        )
      }
    }

    session.promptCount = (session.promptCount ?? 0) + 1
    session.lastActivityAt = Date.now()
    const userMessage = this.userMessageEvent(request.options, 'steer', request.actor)
    const organizationId = await this.rt.turnOrganization(request.sessionId)
    if (backend.isSessionRunning(agentSessionId)) {
      this.rt.restarts.saveRestartRun({ ...request, input: { ...(session.runInput ?? request.input), agentSessionId } }, organizationId)
    }
    this.rt.publish(session.sessionId, userMessage)

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

  async startRunLifecycle(request: SessionRunRequest): Promise<SessionRunLifecycle> {
    await this.rt.useTaskLeadPreferences(request)
    await this.rt.settleRunOrganization(request)
    // Every prepared/initialized view of a run shares this one exchange array.
    // The request is copied while setup resolves, but ownership must not be.
    request.exchangeIds ??= []
    request.runId ??= crypto.randomUUID()
    if (request.reportExchangeIds?.length) this.rt.orchestration?.reportsAccepted(request.reportExchangeIds)
    // Before launch: the provider can report this turn's own plan before the
    // launch step returns, and that plan must survive.
    this.rt.orchestration?.sessionTurnStarted(request.sessionId)
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
    const organizationId = await this.rt.turnOrganization(request.sessionId)
    this.rt.restarts.saveRestartRun(request, organizationId)
    const account = insightsAccountOf(request.actor)
    let actor: { userId: string; email?: string } | undefined
    if (account) {
      actor = { userId: userKey(account.id) }
      if (account.email) actor.email = account.email
    }
    const turnTraceId = this.rt.sessionEmitter.beginTurn({
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
      startedRun = await this.rt.sessionEmitter.runDispatch(
        request.sessionId,
        'launch_run',
        { promptSource, fn: 'launchRun', file: 'run-launcher.ts' },
        () => this.launchRun(request, turnTraceId),
      )
    } catch (error) {
      if (!this.rt.isShuttingDown) this.rt.restarts.restartRuns?.remove(request.sessionId, request.runId)
      const interrupted = error instanceof Error && error.message === 'Interrupted'
      this.rt.sessionEmitter.finishTurn(request.sessionId, interrupted ? 'interrupted' : 'failed', Date.now(), turnTraceId)
      this.rt.cancelRunExchanges(request, interrupted ? 'interrupted' : 'failed',
        interrupted ? undefined : `The turn could not start: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
    const { handle, run } = startedRun
    const startedExchanges = this.rt.runExchanges(request)
    // The provider can refuse the turn on a limit before its launch finishes
    // reporting; a parked run has not started, and its release starts it again.
    const parkedBeforeStart = this.rt.activeSessions.get(request.sessionId)?.status === 'rate_limited'
    if (startedExchanges && !parkedBeforeStart) this.rt.orchestration?.runStarted(startedExchanges)
    // Its own scope: this runs after `launch_run` resolved, so there is no
    // ambient step left to nest under — but it is still inside the setup
    // window, being awaited before setup is closed below.
    const turnTask = await this.rt.sessionEmitter.runDispatch(
      request.sessionId,
      'task_dimension',
      { taskId: run.options.taskId ?? '', fn: 'taskOfTurn', file: 'run-task-context.ts' },
      async (annotate) => {
        const task = await taskOfTurn(run)
        annotate({ taskId: task?.id ?? '', title: task?.title ?? '' })
        return task
      },
    )
    this.rt.sessionEmitter.completeSetup(request.sessionId, {
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
      organizationId: await this.rt.turnOrganization(request.sessionId),
    })
    if (request.servedEnqueuedAt !== undefined) {
      this.rt.sessionEmitter.recordQueueWait(request.sessionId, request.servedEnqueuedAt, runStartedAt)
    }
    if (handle.agentSessionId && (!run.input.agentSessionId || run.input.forked) && run.options.taskId) {
      await linkPreparedTask(run, request.sessionId)
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
      const limit = this.rt.rateLimitPark.currentRateLimitEvent(settledSessionId)
      return !!limit && limit.deferCurrentRun !== true
        && (request.input.rateLimitBehavior === 'ask' || request.input.rateLimitBehavior === 'queue')
    }
    const done = handle.runPromise.then(
      () => {
        const fallback = handle.abortController.signal.aborted ? 'interrupted' as const : 'completed' as const
        const status = this.rt.sessionEmitter.finishTurn(settledSessionId, fallback, Date.now(), turnTraceId)
        captureSettledRun(status)
        if (!isParkedRateLimit()) {
          this.rt.settleRunExchanges(request, status, handle, {
            durationMs: Date.now() - runStartedAt,
            toolCallCount: handle.toolCallCount,
          })
        }
        return handle.resultText ? { output: handle.resultText } : {}
      },
      (error) => {
        const fallback = handle.abortController.signal.aborted ? 'interrupted' as const : 'failed' as const
        const status = this.rt.sessionEmitter.finishTurn(settledSessionId, fallback, Date.now(), turnTraceId)
        captureSettledRun(status)
        if (!isParkedRateLimit()) {
          this.rt.settleRunExchanges(request, status, handle, {
            durationMs: Date.now() - runStartedAt,
            toolCallCount: handle.toolCallCount,
            error: error instanceof Error ? error.message : String(error),
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
        if (handle.agentSessionId && this.rt.stopSession(handle.agentSessionId, HOST_ACTOR)) return
        handle.abortController.abort()
      },
      disposition: 'started',
    }
  }

  private async launchRun(request: SessionRunRequest, turnTraceId: string): Promise<StartedRun> {
    request = this.rt.sessionCheckouts.continueInMovedCheckout(request)
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
      this.rt.statuses.setStatus(sessionId, 'connecting')
      try {
        // Auto's selection is Solus work the turn waits on before any provider
        // starts, so it is a dispatch step: the insights waterfall shows the
        // time it took and the model it settled on.
        const route = await dispatchStep(
          'model_route',
          { requestedModel: AUTO_MODEL_ID, fn: 'routeModelPrompt', file: 'run-launcher.ts' },
          async (annotate) => {
            const metadata = await installedRoutingProviders([...this.rt.backends.values()].map(backend => backend.metadata))
            controller.signal.throwIfAborted()
            const available: typeof metadata = []
            for (const agent of metadata) {
              try { await this.rt.seatForTurn(request.actor, agent.id); available.push(agent) }
              catch (error) { if (!(error instanceof SeatRequiredError)) throw error }
            }
            // A preferred provider with no quota left cannot answer this turn,
            // so the category's other model takes it instead of a run that
            // fails on arrival.
            const routing = input.executionPreferences?.modelRouting ?? DEFAULT_EXECUTION_PREFERENCES.modelRouting
            const route = await routeModelPrompt(options.displayPrompt ?? options.prompt, routing, available, controller.signal, {
              spent: provider => this.rt.usageLimits.isSpent(provider),
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
        this.rt.publish(sessionId, {
          type: 'model_routed',
          provider: route.provider,
          modelConfig: { modelId: route.modelId, reasoningEffort: input.reasoningEffort, contextWindow: input.contextWindow, fastMode: false },
          usedFallback: route.usedFallback,
        })
        log.info('model_routed', { sessionId, ...route })
      } catch (error) {
        if (!controller.signal.aborted) this.rt.statuses.setStatus(sessionId, 'failed')
        throw error
      } finally {
        if (this.pendingSetupControllers.get(sessionId) === controller) this.pendingSetupControllers.delete(sessionId)
      }
    }
    const pendingHandoff = this.rt.handoffs.pendingHandoffFor(sessionId)
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
    const existingSession = isContinuation ? this.rt.activeSessions.get(sessionId) : undefined
    // What `--resume` gets. Never the Solus id: the provider has never heard of it.
    const resumeAgentSessionId = isContinuation
      ? existingSession?.agentSessionId
        ?? (activeLineage?.provider === input.provider ? activeLineage.providerSessionId : null)
        ?? input.agentSessionId
      : null
    const provider = pendingHandoff ? existingSession?.backendId ?? input.provider : input.provider
    const backend = this.rt.backendFor(provider)
    this.rt.rateLimitPark.rateLimits.clear(sessionId)

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
      await this.rt.recordActivity({ kind: 'session', id: sessionId }, request.actor ?? HOST_ACTOR, forkedFrom(input.agentSessionId, input.forkExcludeLatestTurn))
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
        { projectPath: resolvedProjectPath, fn: 'computeGitState', file: 'run-launcher.ts' },
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
      this.rt.publish(sessionId, { type: 'status_card', card: buildWorktreeCard(0) })
      try {
        const gitContext: GitCheckout = await dispatchStep(
          'worktree_create',
          {
            projectPath: resolvedProjectPath ?? '',
            baseBranch: worktreeBaseBranch ?? '',
            fn: 'createWorktree',
            file: 'run-launcher.ts',
          },
          async (annotate) => {
            // `createWorktree` records its own git commands under this step
            // through the ambient context — it takes no telemetry argument.
            // It starts on a temporary branch; `nameWorktreeBranch` names it
            // while the agent works, so the prompt never waits on a model.
            const created = await this.rt.checkouts.create(resolvedProjectPath, worktreeBaseBranch, {
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
        this.rt.publish(sessionId, { type: 'git_context', gitContext })
        void this.rt.sessionCheckouts.nameWorktreeBranch(sessionId, gitContext, options.prompt, request.actor, input.executionPreferences)
        // Worktree done → advance to "Linking thread workspace".
        this.rt.publish(sessionId, { type: 'status_card', card: buildWorktreeCard(1) })
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
        this.rt.statuses.setStatus(sessionId, 'failed')
        this.rt.publish(sessionId, { type: 'status_card', card })
        throw e
      } finally {
        if (this.pendingSetupControllers.get(sessionId) === setupController) {
          this.pendingSetupControllers.delete(sessionId)
        }
      }
    }

    if (effectiveGitCtx?.worktreePath) {
      const current = await this.rt.checkouts.refresh(effectiveGitCtx.worktreePath)
      if (!current.checkout) throw new Error('The session worktree is no longer available')
      effectiveGitCtx = current.checkout
    }
    const useWorktree = !!effectiveGitCtx?.worktreePath
    const effectiveCwd = useWorktree ? effectiveGitCtx!.worktreePath! : resolvedProjectPath
    // A session restored without its git context still points at its worktree
    // path. A provider spawned there fails with an unrelated error (Claude
    // reports a libc mismatch), so say what is really missing.
    if (effectiveCwd && !existsSync(effectiveCwd)) {
      throw new Error(`The working directory ${effectiveCwd} no longer exists. Its worktree was probably removed; start a new session.`)
    }

    // Start mirroring this repo's HEAD/refs/index now that the session's git
    // context is settled, so external branch/commit/stage changes flow back
    // live. The checkout service installs filesystem watchers when a client
    // holds a foreground lease; headless runs still share current identity.
    this.rt.sessionCheckouts.setSessionGitEnvironment(sessionId, effectiveCwd, effectiveGitCtx)
    effectiveGitCtx = this.rt.sessionCheckouts.getGitContext(sessionId) ?? effectiveGitCtx

    // Prewarm the file index for the exact path the Files view will query
    // (worktree root when present, else the project) so its first open hits a
    // ready index instead of paying for the initial filesystem scan.
    if (effectiveCwd && effectiveCwd !== '~') warmFinder(effectiveCwd)

    // Workspace linked (git watcher + file index warmed) → advance to the final
    // "Starting session" step; the reducer clears the card once the run begins.
    if (worktreeCardActive) {
      this.rt.publish(sessionId, { type: 'status_card', card: buildWorktreeCard(2) })
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
          file: 'run-launcher.ts',
        },
        async (annotate) => {
          const handoff = await this.rt.handoffs.handoffBuilder(pendingHandoff.fromSessionId, resolvedProjectPath, {
            fromProvider: pendingHandoff.fromProvider, targetProvider: input.provider, targetModel: input.model,
            contextWindow: input.contextWindow, nextPrompt: options.prompt + input.extraInstructions,
            historyTokens: input.executionPreferences?.handoffHistoryTokens ?? DEFAULT_EXECUTION_PREFERENCES.handoffHistoryTokens,
            sourceStatus: this.rt.handoffs.handoffCarry.get(pendingHandoff.fromSessionId)?.status ?? this.rt.activeSessions.get(sessionId)?.status,
            loadSession: async (threadId, loadProjectPath) => this.rt.handoffs.handoffCarry.merge(threadId, await this.rt.history.loadSession(
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
    if (dispatchAgentSessionId) this.rt.agentSessionToSession.set(dispatchAgentSessionId, sessionId)

    // Recorded at dispatch, not at session_init: the session exists — and is
    // addressable — from the moment work starts on its behalf. It carries the
    // status it had coming in, so `setStatus` below performs a real transition
    // and publishes it once; writing `newStatus` here would make the dispatch
    // silent to everyone watching.
    this.rt.activeSessions.set(sessionId, {
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
    this.rt.statuses.setStatus(sessionId, newStatus)
    this.rt.statuses.notifyActiveWork()
    // A prompt is work: a settled or snoozed session is active again.
    await recordSessionPrompt(sessionId)

    // A session never makes a task of its own: a prompt that names no task
    // runs with none (docs/plans/task-conversation.md, decision 8). A provider
    // handoff is a new backend conversation of the same Solus session, so it
    // stays under the task the session has.
    if (pendingHandoff && !options.taskId) {
      const existingTask = await dispatchStep('task_lookup', {
        fn: 'tasksForSession',
        file: 'run-launcher.ts',
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
        file: 'run-launcher.ts',
      }, async (annotate) => {
        const prepared = await this.rt.sessionTaskPreparer(ANY_ORGANIZATION, {
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
        fn: 'taskSystemContext',
        file: 'run-launcher.ts',
      }, async (annotate) => {
        const composed = await taskSystemContext(options.taskId!, options.taskSnapshot ?? null, sessionId, options.taskRole, effectiveInput.executionPreferences)
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
    this.rt.publish(sessionId, this.userMessageEvent(options, undefined, request.actor), {
      except: request.servedQueueId || options.clientPromptId ? undefined : sourceClientId,
    })

    let handle: RunHandle
    const activeRun: SessionRunRequest = { ...request, input: effectiveInput }
    try {
      this.rt.activeRunRequests.set(sessionId, activeRun)
      if (!dispatchAgentSessionId) {
        await dispatchStep(
          'session_log',
          {
            provider: backend.id,
            cwd: effectiveCwd ?? '',
            fn: 'logNewSessionPrompt',
            file: 'run-launcher.ts',
          },
          () => logNewSessionPrompt(effectiveInput, options, backend.id),
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
      this.rt.sessionEmitter.recordSystemPrompt(request.sessionId, systemPrompt)
      // Image bytes are read here, not carried through the turn: `options` keeps
      // only the refs, so the transcript event and the queue preview never hold
      // base64. Must be awaited before the synchronous launch step below.
      const promptImages = await resolvePromptImages(options)
      // Resolved again here, not only at submit: a queued prompt drains later, and
      // the author's seat may have been removed or expired in between.
      const seat = await this.rt.seatForTurn(request.actor, provider)
      if (this.rt.isShuttingDown) throw new Error('Interrupted')
      const savedRestart = this.rt.restarts.restartRuns?.get(sessionId)
      if (savedRestart && savedRestart.runId === request.runId) {
        this.rt.restarts.restartRuns?.save({ ...savedRestart, input: effectiveInput, state: 'running' })
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
        file: 'run-launcher.ts',
      }, () => this.rt.runAgent({
        provider,
        prompt: options.prompt,
        cwd: effectiveCwd,
        tools: credentialScopedAgentTools([
          ...request.tools,
          // The other backend's subagent runs on the turn author's own login.
          (provider === 'codex' ? createClaudeSubagentAgentTool : createCodexSubagentAgentTool)(
            this.rt,
            (subagentProvider) => this.rt.seatForTurn(request.actor, subagentProvider),
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
      const launchedRestart = this.rt.restarts.restartRuns?.get(sessionId)
      if (launchedRestart && launchedRestart.runId === request.runId && handle.agentSessionId) {
        this.rt.restarts.restartRuns?.save({ ...launchedRestart, input: { ...launchedRestart.input, agentSessionId: handle.agentSessionId }, state: 'running' })
      }
    } catch (err) {
      this.rt.activeRunRequests.delete(sessionId)
      this.rt.statuses.setStatus(sessionId, 'failed')
      this.rt.activeSessions.delete(sessionId)
      // A drained queue entry has no RPC caller to reject to: the refusal reaches
      // the transcript as an error so the connect card can stand in for the turn.
      if (err instanceof SeatRequiredError && request.servedQueueId) {
        const enriched = backend.getEnrichedError(dispatchAgentSessionId ?? null, null)
        enriched.message = err.message
        this.rt.emitError(sessionId, enriched)
      }
      throw err
    }

    return { handle, run: activeRun }
  }
}
