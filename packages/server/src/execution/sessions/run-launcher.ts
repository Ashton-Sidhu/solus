import { existsSync } from 'node:fs'
import { withWorkspaceToolAuthority } from '../../admission/workspace-tool-authority'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import { installedRoutingProviders, routeModelPrompt } from '../agents/model-routing'
import { forkedFrom } from './thread-activity'
import { createLogger } from '../../logger'
import { captureServerEvent } from '../../analytics'
import { computeGitState } from '../../git/git-helpers'
import { warmFinder } from '../../files/file-finder'
import { recordProjectUse } from '../../project-config/projects-manifest'
import type { AgentTool } from '../agents/tools/agent-tool'
import { createClaudeSubagentAgentTool } from '../agents/claude/claude-subagent-tool'
import { createCodexSubagentAgentTool } from '../agents/codex/codex-subagent-tool'
import { resolvePromptImages } from '../agents/prompt-image-refs'
import { unattendedModelInputFor, providerConversationFor } from '../agents/run-input'
import { composeHandoffSeed } from '../agents/session-handoff'
import { buildSystemPrompt } from '../agents/system-hint'
import { tasksForSession } from '../../data/tasks/task-sessions'
import { SessionShelf } from '../../data/sessions/session-states'
import { sessionIsOrganizationWork } from '../../data/sessions/session-records'
import { workspaceToolContext } from '../../data/workspace/tool-context'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { setForeignTaskSnapshot } from '../../data/tasks/foreign-tasks'
import { resolveSessionLineageById } from '../../data/sessions/session-lineage'
import { ANSWERING_ANOTHER_SESSION } from '../orchestration/session-orchestrator'
import type { RunHandle } from '../agents/agent-backend'
import type { BackendSession, SessionStatus, NormalizedEvent, GitCheckout, PromptOptions, PromptDelivery, SessionRunInput, StatusCardState, StatusCardStep, StatusCardStepStatus } from '@solus/contracts/types'
import { gitCheckoutFromState, projectScopeOf } from '@solus/contracts/types'
import { annotateDispatch, dispatchStep, dispatchStepSync } from '../observability/session-emitter'
import { shareTurnTranscripts } from '../seats/member-transcripts'
import { SeatRequiredError } from '../seats/seat-manager'
import { HOST_ACTOR, insightsAccountOf, ownerKeyOf, type Actor } from '../../admission/actor'
import { integrationAgentTools } from '../../integrations/integration-tools'
import { typeSafeKey } from '../../typesafe/credentials'
import { withActorScope } from '../seats/acting-identity'
import { userKey } from '@solus/contracts/user'
import { AGENT_SETUP_STEP, WORKTREE_SETUP_STEPS, worktreeSetupCardId } from '@solus/contracts/setup-card'
import { GithubConnectionRequiredError } from '../../providers/github/connection-required'
import { getDefaultBranch } from '../../git/worktree-manager'
import { accountConnectionsUrl } from '../../vault/account-reads'
import { progressPercent, progressThrottle, type DispatchCheckoutPathOf, type PrepareDispatchCheckout } from './dispatch-repository'
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
    execute: (input, context) => withActorScope(actor, () => withWorkspaceToolAuthority(actor.principal, () => agentTool.execute(input, context))),
  }))
}

interface StartedRun {
  handle: RunHandle
  run: SessionRunRequest
}

/** The reason a worktree setup stops when the person chose to work in the
 *  project folder: the prompt goes on there, and the turn does not fail. */
class WorkLocallyRequest extends Error {
  constructor() { super('Working in the project folder') }
}

/** One change to a setup step. */
interface SetupStepUpdate extends Pick<StatusCardStep, 'percent' | 'detail'> {
  status: StatusCardStepStatus
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
  /** The controllers in `pendingSetupControllers` that make a worktree now. */
  private readonly worktreeSetupControllers = new WeakSet<AbortController>()
  /** Full prompt retained until a failed setup is retried or cancelled on any client. */
  failedSetupPrompts = new Map<string, PromptOptions>()
  /** Copies a Run on send's repository; the setup domain gives it at boot. */
  prepareDispatchCheckout: PrepareDispatchCheckout | null = null
  /** The folder that copy makes, read before the turn is admitted; given with it. */
  dispatchCheckoutPathOf: DispatchCheckoutPathOf | null = null

  constructor(private readonly rt: SessionRuntime) {}

  /**
   * Stops the worktree setup that runs now for `sessionId`. Its half-made
   * worktree and branch are removed, and the same prompt starts in the project
   * folder — for a Run on clone, the clone itself. False when no worktree setup runs.
   */
  continueSetupLocally(sessionId: string): boolean {
    const controller = this.pendingSetupControllers.get(sessionId)
    if (!controller || controller.signal.aborted || !this.worktreeSetupControllers.has(controller)) return false
    log.info('worktree_setup_work_locally', { sessionId })
    controller.abort(new WorkLocallyRequest())
    return true
  }

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
    if (backend.isSessionRunning(agentSessionId)) {
      this.rt.restarts.saveRestartRun({ ...request, input: { ...(session.runInput ?? request.input), agentSessionId } }, await sessionIsOrganizationWork(request.sessionId))
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

  /**
   * A turn acts as its own author (plans/019-acting-identity.md): its worktree,
   * its fetches, and its provider run in their scope. A queued turn can start
   * inside someone else's call, so the scope is set here, not inherited.
   */
  startRunLifecycle(request: SessionRunRequest): Promise<SessionRunLifecycle> {
    return withActorScope(request.actor ?? HOST_ACTOR, () => this.startRunLifecycleInScope(request))
  }

  private async startRunLifecycleInScope(request: SessionRunRequest): Promise<SessionRunLifecycle> {
    if (request.actor) this.rt.rememberSessionActor(request.sessionId, request.actor)
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
    this.rt.restarts.saveRestartRun(request, await sessionIsOrganizationWork(request.sessionId))
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
    await this.rt.handoffs.handOffForPrompt(request, request.actor ?? HOST_ACTOR)
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
    let effectiveGitCtx = sessionGitContext ?? incoming ?? null

    // A Run on send to a host with no checkout yet copies the repository first
    // (docs/run-on.md), on the same setup card as the worktree that may follow.
    const repositoryRun = request.repository
    let worktreeBaseBranch = input.worktreeBaseBranch
    // A clone in an existing worktree, or in its checkout, makes no worktree.
    const makesWorktree = !(repositoryRun && (repositoryRun.repository.worktreePath || (!worktreeBaseBranch && !repositoryRun.repository.newWorktree)))
    const setupSteps: StatusCardStep[] = [
      ...(repositoryRun ? [{ id: 'repository', label: 'Preparing repository' }] : []),
      ...(makesWorktree ? WORKTREE_SETUP_STEPS : []),
      AGENT_SETUP_STEP,
    ].map((step): StatusCardStep => ({ ...step, status: 'pending' }))
    // Inline status card mirroring the pre-run setup. The renderer clears it
    // once the session leaves 'connecting'; a failed card is kept until the
    // user retries setup or explicitly chooses the project directory.
    let setupCardActive = false
    // The person stopped the worktree setup to work in the project folder.
    let worksLocally = false
    let createdWorktreePath: string | undefined
    const setupOutput: string[] = []
    const stepFor = (id: string) => setupSteps.find((step) => step.id === id)
    // The host's clock times each step: it starts at its first active update
    // and ends at its last. A skipped step did no work, so it has no times.
    const setStep = (id: string, update: SetupStepUpdate): void => {
      const step = stepFor(id)
      if (!step) return
      const now = Date.now()
      if (update.status === 'skipped') {
        delete step.startedAt
        delete step.endedAt
      } else if (update.status !== 'pending') {
        step.startedAt ??= now
        if (update.status !== 'active') step.endedAt = now
      }
      step.status = update.status
      if (update.status !== 'active') delete step.percent
      else if (update.percent !== undefined) step.percent = update.percent
      if (update.detail) step.detail = update.detail
    }
    // The next step shows as active before its work starts, with no time yet:
    // the client's card at Send shows the same.
    const announceStep = (id: string): void => {
      const step = stepFor(id)
      if (step?.status === 'pending') step.status = 'active'
    }
    const buildSetupCard = (): StatusCardState => {
      const failedStep = setupSteps.find((step) => step.status === 'error')
      const isWorktree = makesWorktree && !worksLocally
      return {
        id: worktreeSetupCardId(sessionId),
        title: failedStep
          ? (failedStep.id === 'repository' ? 'Repository setup failed' : 'Worktree setup failed')
          : stepFor('repository')?.status === 'active' ? 'Preparing repository…' : isWorktree ? 'Preparing worktree…' : 'Starting session…',
        icon: isWorktree ? 'git-branch' : 'server',
        status: failedStep ? 'error' : 'active',
        // Bounded: at most 100 lines of at most 2,048 characters each.
        output: setupOutput
          .flatMap((line) => line.split('\n'))
          .slice(-100)
          .map((line) => line.slice(0, 2048)),
        worktreeBaseBranch: worksLocally ? undefined : worktreeBaseBranch ?? undefined,
        steps: setupSteps.map((step) => ({ ...step })),
      }
    }
    const publishSetupCard = (card = buildSetupCard()): void => this.rt.publish(sessionId, { type: 'status_card', card })
    if (repositoryRun) {
      const prepareCheckout = this.prepareDispatchCheckout
      if (!prepareCheckout) throw new Error('This host cannot copy a repository.')
      const setupController = new AbortController()
      this.pendingSetupControllers.get(sessionId)?.abort(new Error('Interrupted'))
      this.pendingSetupControllers.set(sessionId, setupController)
      setupCardActive = true
      setupOutput.push(`Preparing ${repositoryRun.repository.cloneUrl}`)
      setStep('repository', { status: 'active' })
      publishSetupCard()
      // Git rewrites its transfer line many times a second; a reader needs a few.
      const mayPublish = progressThrottle(250)
      let lastLineIsProgress = false
      try {
        const path = await dispatchStep(
          'repository_prepare',
          { cloneUrl: repositoryRun.repository.cloneUrl, fn: 'prepareDispatchCheckout', file: 'run-launcher.ts' },
          async (annotate) => {
            const prepared = await prepareCheckout(
              repositoryRun.repository,
              { principal: (request.actor ?? HOST_ACTOR).principal, deviceId: repositoryRun.deviceId },
              {
                signal: setupController.signal,
                onOutput: (line, isProgress) => {
                  // A rewritten transfer line replaces the one before it.
                  if (isProgress && lastLineIsProgress) setupOutput[setupOutput.length - 1] = line
                  else setupOutput.push(line)
                  lastLineIsProgress = isProgress
                  setStep('repository', { status: 'active', percent: progressPercent(line) ?? undefined })
                  if (mayPublish()) publishSetupCard()
                },
              },
            )
            annotate({ path: prepared })
            return prepared
          },
        )
        const checkout = (await this.rt.checkouts.refresh(path)).checkout
        input.workingDirectory = path
        input.projectPath = checkout?.repoRoot ?? path
        effectiveGitCtx = checkout
        // A run that names no base for its new worktree starts from the default branch.
        if (makesWorktree && !worktreeBaseBranch) worktreeBaseBranch = checkout?.targetBranch ?? await getDefaultBranch(path)
        // The client moves the run to the folder it reads here.
        if (checkout) this.rt.publish(sessionId, { type: 'git_context', gitContext: checkout })
        setupOutput.push(`Repository ready at ${path}`)
        log.info('repository_prepared', { sessionId, path })
        setStep('repository', { status: 'done' })
        announceStep(setupSteps[1].id)
        publishSetupCard()
      } catch (e) {
        if (setupController.signal.aborted) {
          log.info('repository_setup_interrupted', { sessionId })
          throw setupController.signal.reason instanceof Error
            ? setupController.signal.reason
            : new Error('Interrupted')
        }
        log.error('repository_prepare_failed', { sessionId, error: String(e) })
        const message = e instanceof Error ? e.message : String(e)
        setupOutput.push(message)
        setStep('repository', { status: 'error', detail: message })
        const card = buildSetupCard()
        const connectionsUrl = e instanceof GithubConnectionRequiredError ? accountConnectionsUrl() : null
        if (connectionsUrl) {
          card.recovery = 'connect-github'
          card.recoveryUrl = connectionsUrl
        }
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

    const resolvedProjectPath = projectScopeOf(input)
    annotateDispatch({
      provider,
      projectRoot: resolvedProjectPath ?? '',
      isContinuation,
      isFork: isForkingInput,
      isResume: !!resumeAgentSessionId,
      hasPendingHandoff: !!pendingHandoff,
    })

    if (!repositoryRun && !effectiveGitCtx?.worktreePath && resolvedProjectPath && resolvedProjectPath !== '~') {
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

    const baseBranch = worktreeBaseBranch
    if (baseBranch && !effectiveGitCtx?.worktreePath && resolvedProjectPath) {
      const setupController = new AbortController()
      this.pendingSetupControllers.get(sessionId)?.abort(new Error('Interrupted'))
      this.pendingSetupControllers.set(sessionId, setupController)
      this.worktreeSetupControllers.add(setupController)
      setupCardActive = true
      setupOutput.push(`Creating worktree from ${baseBranch}`)
      announceStep('fetch')
      publishSetupCard()
      // A checkout reports its files many times a second, like a clone.
      const mayPublishCheckout = progressThrottle(250)
      // A fetch beside a failed checkout can end later; this card is final by then.
      let stagesOpen = true
      const onStage = (stage: string, update: SetupStepUpdate): void => {
        if (!stagesOpen) return
        const isProgress = update.percent !== undefined && stepFor(stage)?.startedAt !== undefined
        setStep(stage, update)
        if (!isProgress || mayPublishCheckout()) publishSetupCard()
      }
      try {
        const gitContext: GitCheckout = await dispatchStep(
          'worktree_create',
          {
            projectPath: resolvedProjectPath ?? '',
            baseBranch,
            fn: 'createWorktree',
            file: 'run-launcher.ts',
          },
          async (annotate) => {
            // `createWorktree` records its own git commands under this step
            // through the ambient context — it takes no telemetry argument.
            // It starts on a temporary branch; `nameWorktreeBranch` names it
            // while the agent works, so the prompt never waits on a model.
            const created = await this.rt.checkouts.create(resolvedProjectPath, baseBranch, {
              signal: setupController.signal,
              naming: input.executionPreferences?.worktreeBranchNaming,
              onStage,
            })
            annotate({ branch: created.branch ?? '', targetBranch: created.targetBranch, worktreePath: created.worktreePath ?? '' })
            return created
          },
        )
        if (existingSession) existingSession.gitContext = gitContext
        effectiveGitCtx = gitContext
        createdWorktreePath = gitContext.worktreePath
        stagesOpen = false
        setupOutput.push(`Branch: ${gitContext.branch}`, `Worktree: ${gitContext.worktreePath}`)
        log.info('worktree_created', { sessionId, branch: gitContext.branch, worktreePath: gitContext.worktreePath })
        captureServerEvent('worktree_created', {})
        this.rt.publish(sessionId, { type: 'git_context', gitContext })
        void this.rt.sessionCheckouts.nameWorktreeBranch(sessionId, gitContext, options.prompt, request.actor, input.executionPreferences)
        // Worktree done → the agent step, which links the workspace first.
        setStep('agent', { status: 'active' })
        publishSetupCard()
      } catch (e) {
        stagesOpen = false
        const reason: unknown = setupController.signal.reason
        if (setupController.signal.aborted && reason instanceof WorkLocallyRequest) {
          // `createWorktree` removed its half-made worktree and branch before it
          // threw. The run goes on in the project folder, which `effectiveGitCtx`
          // already describes, and no later turn makes a worktree.
          worksLocally = true
          input.worktreeBaseBranch = null
          for (const step of WORKTREE_SETUP_STEPS) setStep(step.id, { status: 'skipped' })
          setupOutput.push('Working in the project folder')
          setStep('agent', { status: 'active' })
          publishSetupCard()
        } else if (setupController.signal.aborted) {
          log.info('worktree_setup_interrupted', { sessionId })
          throw reason instanceof Error ? reason : new Error('Interrupted')
        } else {
          log.error('worktree_creation_failed', { sessionId, error: String(e) })
          const message = e instanceof Error ? e.message : String(e)
          setupOutput.push(message)
          // The step that failed is the last one that started; a fetch beside it
          // did not finish for this setup either.
          const activeSteps = setupSteps.filter((step) => step.status === 'active')
          const failedStepId = activeSteps.at(-1)?.id ?? 'checkout'
          for (const step of activeSteps) setStep(step.id, { status: 'error' })
          setStep(failedStepId, { status: 'error', detail: message })
          const card = buildSetupCard()
          card.recovery = 'worktree'
          this.failedSetupPrompts.set(sessionId, options)
          this.rt.statuses.setStatus(sessionId, 'failed')
          publishSetupCard(card)
          throw e
        }
      } finally {
        if (this.pendingSetupControllers.get(sessionId) === setupController) {
          this.pendingSetupControllers.delete(sessionId)
        }
      }
    }

    if (createdWorktreePath) {
      // A worktree made just now is clean and its checkout is known. Its status
      // reaches clients after the agent starts.
      void this.rt.checkouts.refresh(createdWorktreePath)
        .catch((error) => log.warn('checkout_refresh_failed', { sessionId, cwd: createdWorktreePath, error: String(error) }))
    } else if (effectiveGitCtx?.worktreePath) {
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

    // A session in a listed project (or its worktree or subfolder) moves that
    // project up the host's list; an unlisted folder stays off it (project-model §2).
    try { recordProjectUse(effectiveCwd) }
    catch (error) { log.warn('project_last_use_failed', { sessionId, cwd: effectiveCwd, error: String(error) }) }

    // A setup that made no worktree after all (the clone was one already)
    // skips its worktree steps. The reducer clears the card once the run begins.
    if (setupCardActive && stepFor('agent')?.startedAt === undefined) {
      for (const step of setupSteps) {
        if (step.id !== 'agent' && (step.status === 'pending' || step.status === 'active')) setStep(step.id, { status: 'skipped' })
      }
      setStep('agent', { status: 'active' })
      publishSetupCard()
    }

    const effectiveAdditionalDirs = useWorktree && resolvedProjectPath
      ? [...new Set([...(input.additionalDirs || []), resolvedProjectPath])]
      : input.additionalDirs

    // The provider switch (`handOffForPrompt`) only moves the lineage; the
    // handoff transcript is assembled now, for the prompt that asked for it. It's
    // a local read (on-disk transcript, no LLM call), so this stays fast.
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
    // A prompt is work: a settled session is active again, and back in the
    // list of the person the turn is for.
    await new SessionShelf(sessionId).recordPrompt(request.actor ? ownerKeyOf(request.actor) : null)
    void admitTurnAtHome(sessionId)

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
      // A member's transcripts written from here on are shared with the server when the turn ends.
      const turnStartedAt = Date.now()
      // The MCP servers' tools are listed here, for the run's person, so every run —
      // typed, queued, restored, or started by an agent — gets that person's own.
      const integrationTools = await integrationAgentTools(request.actor ?? HOST_ACTOR)
      // Ask Jev uses the run's person's own TypeSafe key (access-model.md §2.6); without one it is not offered.
      // A key that cannot be read (the account is unreachable) only leaves the tool out; it never stops the turn.
      const hasTypeSafeKey = await typeSafeKey().then((key) => !!key.apiKey, (error: unknown) => {
        log.warn('typesafe_key_unreadable', { sessionId, error: error instanceof Error ? error.message : String(error) })
        return false
      })
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
          ...request.tools.filter((tool) => hasTypeSafeKey || tool.name !== 'ask_jev'),
          ...integrationTools,
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
        sessionId,
        // Empty when tracing is off; the snapshot then records no trace.
        turnTraceId: turnTraceId || undefined,
      }))
      handle = agentRun.handle
      const memberLaunch = seat?.launch?.user ? seat.launch : null
      if (memberLaunch) {
        const share = () => shareTurnTranscripts(memberLaunch, turnStartedAt)
        void handle.runPromise.then(share, share)
      }
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

/**
 * An organization session's home is its Solus API (docs/plans/session-archive.md):
 * the turn reaches it too, as the person the run acts for, so the session is
 * active and back in their list on every device. A personal session's home is
 * this machine, which recorded the prompt already. A home that cannot be
 * reached hears of the next turn; nothing waits on it.
 */
async function admitTurnAtHome(sessionId: string): Promise<void> {
  const home = await workspaceToolContext(sessionId).catch(() => null)
  if (!home?.remote) return
  await home.operations.admitSessionTurn(home.context, sessionId).catch((error) => {
    log.warn('session_turn_admission_failed', { sessionId, error: error instanceof Error ? error.message : String(error) })
  })
}
