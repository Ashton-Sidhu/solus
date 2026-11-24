import { inlineSessionGuidePrompt } from '../../review/inline-session-guide'
import { enforce, hostPolicies } from '../../host/policy/host-policy-store'
import { providerAvailableForProject } from '../seats/provider-availability'
import { captureServerEvent } from '../../analytics'
import { startRun, credentialScopedAgentTools, type PendingStart, type StartedRun } from './run-lifecycle'
export type { PendingStart } from './run-lifecycle'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { isTaskFolderPath, type TaskFolder } from '@solus/contracts/codebases'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import { installedRoutingProviders, routeModelPrompt } from '../agents/model-routing'
import { forkedFrom } from './thread-activity'
import { createLogger } from '../../logger'
import { computeGitState } from '../../git/git-helpers'
import { warmFinder } from '../../files/file-finder'
import { resolveHomePath } from '../../platform/paths'
import { recordProjectUse } from '../../project-config/projects-manifest'
import { resolvePromptImages } from '../agents/prompt-image-refs'
import { unattendedModelInputFor, providerConversationFor } from '../agents/run-input'
import { composeHandoffSeed } from '../agents/session-handoff'
import { buildSystemPrompt } from '../agents/system-hint'
import { portableSessionPathNote } from '../agents/runtime-instructions'
import { taskIdForSession } from '../../data/tasks/task-sessions'
import { SessionShelf } from '../../data/sessions/session-states'
import { organizationOfSession, sessionIsOrganizationWork } from '../../data/sessions/session-records'
import { workspaceToolContext } from '../../data/workspace/tool-context'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import { ANY_ORGANIZATION, LOCAL_ORGANIZATION_ID } from '../../admission/principal'
import { setForeignTaskSnapshot } from '../../data/tasks/foreign-tasks'
import { resolveSessionLineageById } from '../../data/sessions/session-lineage'
import { recordPromptSender } from '../../data/activity/prompt-senders'
import { ANSWERING_ANOTHER_SESSION } from '../orchestration/session-orchestrator'
import type { AgentBackend, RunHandle } from '../agents/agent-backend'
import { hasOpenBackgroundQuery } from './background-work'
import type { TurnStop } from './turn-stops'
import type { BackendSession, SessionStatus, NormalizedEvent, GitCheckout, PromptOptions, PromptDelivery, SessionRunInput, StatusCardState, StatusCardStep, StatusCardStepStatus } from '@solus/contracts/types'
import { gitCheckoutFromState, isSessionBusyStatus, projectScopeOf } from '@solus/contracts/types'
import { annotateDispatch, dispatchStep, dispatchStepSync } from '../observability/session-emitter'
import { shareTurnTranscripts } from '../seats/member-transcripts'
import { SeatRequiredError } from '../seats/seat-manager'
import { HOST_ACTOR, ownerKeyOf, type Actor } from '../../admission/actor'
import { integrationToolbox } from '../../integrations/integration-tools'
import { appOperationAgentTools } from '../agents/tools/app-tools'
import { withActorScope } from '../seats/acting-identity'
import { AGENT_SETUP_STEP, WORKTREE_SETUP_STEPS, worktreeSetupCardId } from '@solus/contracts/setup-card'
import { GithubConnectionRequiredError } from '../../providers/github/connection-required'
import { getDefaultBranch, recreateMissingWorktree } from '../../git/worktree-manager'
import { accountConnectionsUrl } from '../../vault/account-reads'
import { writeMissingCopiedFiles } from '../../git/worktree-include'
import { progressPercent, progressThrottle, type DispatchCheckoutPathOf, type PrepareDispatchCheckout } from './dispatch-repository'
import { SPAN_SERVICES } from '../../data/insights/registries'
import type { SessionRuntime, SessionRunRequest, SessionRunLifecycle } from '../session-runtime'
import { taskSystemContext, logNewSessionPrompt } from './run-task-context'
import { taskFolderStages, type CreateSessionTaskFolder, type CreatedSessionTaskFolder, type TaskFolderTurn } from './session-task-folders'
import type { SessionFoldersTurn } from './session-folders'
import type { TaskFolderPlan } from '../../git/task-folder-plan'

const log = createLogger('SessionRuntime', 'run-launcher.ts')

/** The reason a worktree setup stops when the person chose to work in the
 *  project folder: the prompt goes on there, and the turn does not fail. */
class WorkLocallyRequest extends Error {
  constructor() { super('Working in the project folder') }
}

/** One change to a setup step. */
interface SetupStepUpdate extends Pick<StatusCardStep, 'percent' | 'detail'> {
  status: StatusCardStepStatus
}

/** What the setup of a turn gives the creation of its task folder. */
interface TaskFolderSetup extends Pick<CreateSessionTaskFolder, 'actor' | 'naming' | 'baseBranch' | 'signal'> {
  onStage: (stage: string, update: SetupStepUpdate) => void
  /** Add one line to the output of the setup card. */
  note: (line: string) => void
}

/** What the worktree setup of a turn gives the creation of its worktree. */
interface WorktreeSetup extends TaskFolderSetup, Pick<TaskFolderTurn, 'codebaseId' | 'projectFolder' | 'repositories'> {}

/** What the worktree setup of a turn made. */
interface MadeWorktree {
  /** The task folder, or null for one worktree inside its repository. */
  taskFolder: TaskFolder | null
  /** The checkout of the working directory. Null for a task folder whose working member is a plain folder. */
  gitContext: GitCheckout | null
}

/** A step of a setup card that did not start, or that did not end. */
function isOpenStep(step: StatusCardStep | undefined): boolean {
  return step?.status === 'pending' || step?.status === 'active'
}

/** The branch and the place of what a setup made, for its card and its log. */
function madeWorktreeFacts({ taskFolder, gitContext }: MadeWorktree) {
  return {
    branch: taskFolder?.branch ?? gitContext?.branch,
    worktreePath: taskFolder?.primaryPath ?? gitContext?.worktreePath,
    taskFolder: taskFolder?.root,
  }
}

/**
 * The folder that stands in for a plain working member (docs/plans/codebases.md
 * §7): the member has no checkout, so its session works there. Null for each
 * other session, and for a turn that names that folder already.
 */
function standInDirectory(taskFolder: TaskFolder | null, projectPath: string | undefined): string | null {
  return taskFolder && !taskFolder.primaryIsWorktree && !isTaskFolderPath(projectPath) ? taskFolder.primaryPath : null
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
    if (options.via) event.via = options.via
    if (options.sender) event.sender = options.sender
    return event
  }

  /** Keep who sent a prompt no person typed, so a history reload can say it too. */
  private async recordSender(sessionId: string, options: PromptOptions): Promise<void> {
    if (!options.sender) return
    try {
      await recordPromptSender(await this.rt.turnOrganization(sessionId) ?? LOCAL_ORGANIZATION_ID, sessionId, options.sender, options.displayPrompt ?? options.prompt)
    } catch (error) {
      // Live readers still get it on the event; only a reload would miss it.
      log.warn('prompt_sender_append_failed', { sessionId, error: String(error) })
    }
  }

  async steerActiveTurn(
    request: SessionRunRequest,
    agentSessionId: string,
    session: BackendSession,
  ): Promise<SessionRunLifecycle | null> {
    const backend = this.rt.backendFor(session.backendId)
    // A steer joins a running turn; a policy changed since it started can put that turn above its ceiling (plans/030 §6.3).
    const activeMode = session.runInput?.permissionMode
    if (activeMode) enforce(hostPolicies().forWork(await organizationOfSession(session.sessionId)).runDenial({ mode: activeMode, provider: session.backendId }))
    const handle = await backend.steerSession(agentSessionId, {
      prompt: await inlineSessionGuidePrompt(request.options.prompt, request.sessionId, session.runInput?.workingDirectory),
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
    void this.recordSender(session.sessionId, request.options)
    if (backend.isSessionRunning(agentSessionId)) {
      this.rt.restarts.saveRestartRun({ ...request, input: { ...(session.runInput ?? request.input), agentSessionId } }, await sessionIsOrganizationWork(request.sessionId), 'running')
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
    const turn = this.rt.turnStops.begin(request.sessionId)
    // Until the provider spawns, the launch is the turn's work: Stop ends it at
    // its next check, so no provider starts for a stopped turn.
    const releaseLaunch = turn.onStop(() => true)
    try {
      return await startRun(this.rt, this.pendingStarts, (run, traceId, stop, release) => this.launchRun(run, traceId, stop, release), request, turn, releaseLaunch)
    } catch (error) {
      this.rt.turnStops.end(request.sessionId, turn)
      throw error
    } finally {
      releaseLaunch()
    }
  }

  /**
   * The provider run is the turn's work from its spawn: Stop cancels it, before
   * or after `session_init`. When the run exits and leaves background work, Stop
   * cancels that work instead, until a later turn replaces this one.
   */
  stopsWithTurn(turn: TurnStop, sessionId: string, backend: AgentBackend, handle: RunHandle): void {
    const releaseRun = turn.onStop(() => {
      const session = this.rt.activeSessions.get(sessionId)
      // Stop is the way out of a task that never settles: cancelling the query
      // is what ends the work the agent left running, held or not. A run that
      // is still live after a first Stop takes the second one (a force stop).
      if (session?.agentSessionId && (isSessionBusyStatus(session.status) || hasOpenBackgroundQuery(session) || backend.isSessionRunning(session.agentSessionId))
        && backend.cancelSession(session.agentSessionId)) return true
      // Before `session_init` the run has no thread to cancel by.
      if (!backend.getPendingHandles().includes(handle)) return false
      handle.abortController.abort()
      return true
    })
    const settle = (): void => {
      releaseRun()
      const session = this.rt.activeSessions.get(sessionId)
      const threadId = session?.agentSessionId
      if (session && threadId && hasOpenBackgroundQuery(session)) turn.onStop(() => backend.cancelSession(threadId))
      else this.rt.turnStops.end(sessionId, turn)
    }
    void handle.runPromise.then(settle, settle)
  }

  /**
   * Make the task folder of a new worktree session (docs/plans/codebases.md
   * §7), as one step of the dispatch. `note` gets a line of the setup card
   * for each repository whose files are checked out. Stop rolls the creation
   * back in the module, so nothing of it stays.
   */
  private makeTaskFolder(sessionId: string, plan: TaskFolderPlan, options: TaskFolderSetup): Promise<CreatedSessionTaskFolder> {
    const repositories = [
      ...(plan.workingMemberIsRepository ? [{ path: plan.workingMember, name: basename(plan.workingMember) }] : []),
      ...plan.repositories,
    ]
    return dispatchStep(
      'task_folder_create',
      { projectPath: plan.workingMember, baseBranch: options.baseBranch ?? '', repositoryCount: repositories.length, fn: 'createTaskFolder', file: 'run-launcher.ts' },
      async (annotate) => {
        options.note(`Task folder: ${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'}`)
        const created = await this.rt.taskFolders.create(sessionId, plan, {
          actor: options.actor,
          naming: options.naming,
          baseBranch: options.baseBranch,
          signal: options.signal,
          onRepository: taskFolderStages(repositories, options.onStage, (name, count) => options.note(`Worktree ${count} of ${repositories.length}: ${name}`)),
        })
        annotate({ branch: created.taskFolder.branch, root: created.taskFolder.root })
        return created
      },
    )
  }

  /**
   * The worktree of a new worktree session. A worktree session of several
   * repositories, or of a plain folder, works in a task folder
   * (docs/plans/codebases.md §7). Each other session gets one worktree inside
   * its repository, as before. A plan that cannot be made is the error of the
   * setup, with its reason.
   */
  private async makeWorktree(sessionId: string, setup: WorktreeSetup): Promise<MadeWorktree> {
    const { projectFolder, baseBranch } = setup
    const plan = await this.rt.taskFolders.plan(sessionId, { codebaseId: setup.codebaseId, projectFolder, repositories: setup.repositories, actor: setup.actor })
    if (plan) {
      const { taskFolder, checkout } = await this.makeTaskFolder(sessionId, plan, setup)
      return { taskFolder, gitContext: checkout && this.rt.checkouts.attach(taskFolder.primaryPath, checkout) }
    }
    const gitContext = await dispatchStep(
      'worktree_create',
      {
        projectPath: projectFolder,
        baseBranch: baseBranch ?? '',
        fn: 'createWorktree',
        file: 'run-launcher.ts',
      },
      async (annotate) => {
        // `createWorktree` records its own git commands under this step
        // through the ambient context — it takes no telemetry argument.
        // It starts on a temporary branch; `nameWorktreeBranch` names it
        // while the agent works, so the prompt never waits on a model.
        const created = await this.rt.checkouts.create(projectFolder, baseBranch ?? undefined, {
          signal: setup.signal,
          naming: setup.naming,
          onStage: setup.onStage,
        })
        annotate({ branch: created.branch ?? '', targetBranch: created.targetBranch, worktreePath: created.worktreePath ?? '' })
        return created
      },
    )
    return { taskFolder: null, gitContext }
  }

  /** Tell the clients where the session works after its setup, and name the new branch beside the turn. */
  private announceMadeWorktree(sessionId: string, made: MadeWorktree, projectFolder: string, prompt: string, actor: Actor | undefined, preferences: SessionRunInput['executionPreferences']): void {
    const { taskFolder, gitContext } = made
    if (gitContext) {
      this.rt.publish(sessionId, { type: 'git_context', cwd: gitContext.worktreePath ?? projectFolder, gitContext })
      void this.rt.sessionCheckouts.nameWorktreeBranch(sessionId, gitContext, prompt, actor, preferences)
    } else if (taskFolder) {
      // A plain working member has no checkout to name by: the task folder names its branch.
      void this.rt.taskFolders.nameBranch(sessionId, taskFolder.root, prompt, actor, preferences)
    }
  }

  /**
   * The folders of the session besides its working directory, read from its
   * codebase and its record now. Answers the paths that the provider gets for
   * this turn: the granted folders, and for a worktree session also its
   * project root (`projectRoot`), as before.
   */
  private async providerDirectoriesFor(sessionId: string, turn: SessionFoldersTurn, projectRoot: string | null): Promise<string[]> {
    await dispatchStep(
      'session_folders',
      { cwd: turn.workingDirectory, fn: 'SessionFolders.resolve', file: 'run-launcher.ts' },
      async (annotate) => {
        const folders = await this.rt.sessionFolders.resolve(sessionId, turn)
        annotate({ folderCount: folders.length })
      },
    )
    const granted = this.rt.sessionFolders.grantedPaths(sessionId)
    return projectRoot ? [...new Set([...granted, resolveHomePath(projectRoot)])] : granted
  }

  private async launchRun(request: SessionRunRequest, turnTraceId: string, turn: TurnStop, releaseLaunch: () => void): Promise<StartedRun> {
    await this.rt.sessionCheckouts.finishHeldMove(request.sessionId)
    request = this.rt.sessionCheckouts.continueInMovedCheckout(request)
    // More than one prompt can be queued before the first fork turn obtains
    // a provider thread. Once it exists, those prompts continue the fork.
    if (request.input.forkPointId) {
      const active = resolveSessionLineageById(request.sessionId)?.active
      if (active?.providerSessionId) {
        const { forkPointId: _pointId, ...input } = request.input
        request = {
          ...request,
          input: { ...input, agentSessionId: active.providerSessionId, forked: false },
          target: { kind: 'session', sessionId: request.sessionId },
        }
      }
    }
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
      const releaseRouting = turn.onStop(() => { controller.abort(new Error('Interrupted')); return true })
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
            const routedOrganizationId = await organizationOfSession(sessionId)
            for (const agent of metadata) {
              if (!providerAvailableForProject(agent.id, input.projectPath)) continue
              // A provider the policies do not allow is never routed to (plans/030 §6.5).
              if (!!hostPolicies().forWork(routedOrganizationId).providerDenial(agent.id)) continue
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
        releaseRouting()
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
    if (isForkingInput && input.agentSessionId && !activeLineage?.providerSessionId && !input.forkPointId) {
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
      // The prompts queued behind a setup were written for the checkout it makes,
      // which now never exists, so Stop drops them with it.
      const releaseSetup = turn.onStop(() => {
        this.rt.scheduler.drainQueue(sessionId)
        setupController.abort(new Error('Interrupted'))
        if (this.pendingSetupControllers.get(sessionId) === setupController) this.pendingSetupControllers.delete(sessionId)
        return true
      })
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
        // A new worktree starts from the branch the send named, else the default branch.
        if (makesWorktree && !worktreeBaseBranch) {
          worktreeBaseBranch = repositoryRun.repository.baseBranch ?? checkout?.targetBranch ?? await getDefaultBranch(path)
        }
        // The client moves the run to the folder it reads here.
        if (checkout) this.rt.publish(sessionId, { type: 'git_context', cwd: path, gitContext: checkout })
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
        releaseSetup()
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

    const turnActor = request.actor ?? HOST_ACTOR
    // A session that works in a task folder continues there: no later turn makes a second one.
    let taskFolder: TaskFolder | null = this.rt.taskFolders.ofTurn(sessionId, effectiveGitCtx?.worktreePath ?? resolvedProjectPath, resolvedProjectPath)
    let madeTaskFolder = false
    let isCodebaseSettled = false

    const baseBranch = worktreeBaseBranch
    if (baseBranch && !effectiveGitCtx?.worktreePath && !taskFolder && resolvedProjectPath) {
      const setupController = new AbortController()
      this.pendingSetupControllers.get(sessionId)?.abort(new Error('Interrupted'))
      this.pendingSetupControllers.set(sessionId, setupController)
      // The prompts queued behind a setup were written for the checkout it makes,
      // which now never exists, so Stop drops them with it.
      const releaseSetup = turn.onStop(() => {
        this.rt.scheduler.drainQueue(sessionId)
        setupController.abort(new Error('Interrupted'))
        if (this.pendingSetupControllers.get(sessionId) === setupController) this.pendingSetupControllers.delete(sessionId)
        return true
      })
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
      // The command of a layout reports no stage: the steps that are still open did no work.
      const skipOpenSteps = (): void => {
        for (const step of WORKTREE_SETUP_STEPS) {
          if (isOpenStep(stepFor(step.id))) setStep(step.id, { status: 'skipped' })
        }
      }
      try {
        // The codebase of the session is known before the plan: the first worktree session of a container gets its task folder (decisions 13 and 14).
        await this.rt.sessionFolders.settleCodebase(sessionId, {
          workingDirectory: resolvedProjectPath,
          repositoryRoot: effectiveGitCtx?.repoRoot,
          codebaseId: input.codebaseId,
          noCodebase: input.noCodebase,
          preferences: input.executionPreferences,
          actor: turnActor,
        })
        isCodebaseSettled = true
        const made = await this.makeWorktree(sessionId, {
          codebaseId: input.codebaseId,
          projectFolder: resolvedProjectPath,
          repositories: input.worktreeRepositories ?? null,
          actor: turnActor,
          naming: input.executionPreferences?.worktreeBranchNaming,
          baseBranch,
          signal: setupController.signal,
          onStage,
          note: (line) => { if (stagesOpen) setupOutput.push(line) },
        })
        const { gitContext } = made
        if (made.taskFolder) {
          taskFolder = made.taskFolder
          madeTaskFolder = true
          skipOpenSteps()
        }
        if (gitContext) {
          if (existingSession) existingSession.gitContext = gitContext
          effectiveGitCtx = gitContext
          createdWorktreePath = gitContext.worktreePath
        }
        // A dispatch's copied files go into its new worktree too: the checkout
        // it was made from may be a person's own, which never gets them.
        const copiedFiles = repositoryRun?.repository.files ?? []
        if (copiedFiles.length > 0 && gitContext?.worktreePath) {
          const written = await writeMissingCopiedFiles(gitContext.worktreePath, copiedFiles)
          setupOutput.push(`Copied ${written} of ${copiedFiles.length} files from .worktreeinclude`)
        }
        stagesOpen = false
        const facts = madeWorktreeFacts(made)
        setupOutput.push(`Branch: ${facts.branch}`, facts.taskFolder ? `Task folder: ${facts.taskFolder}` : `Worktree: ${facts.worktreePath}`)
        log.info('worktree_created', { sessionId, ...facts })
        captureServerEvent('worktree_created', {})
        this.announceMadeWorktree(sessionId, made, resolvedProjectPath, options.prompt, request.actor, input.executionPreferences)
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
        releaseSetup()
        if (this.pendingSetupControllers.get(sessionId) === setupController) {
          this.pendingSetupControllers.delete(sessionId)
        }
      }
    }

    // A worktree or the working folder of a task folder that was deleted outside Solus comes back on the next turn.
    if (taskFolder && !madeTaskFolder) await this.rt.taskFolders.restore(sessionId, taskFolder, turnActor)

    if (createdWorktreePath) {
      // A worktree made just now is clean and its checkout is known. Its status
      // reaches clients after the agent starts.
      void this.rt.checkouts.refresh(createdWorktreePath)
        .catch((error) => log.warn('checkout_refresh_failed', { sessionId, cwd: createdWorktreePath, error: String(error) }))
    } else if (effectiveGitCtx?.worktreePath) {
      let current = await this.rt.checkouts.refresh(effectiveGitCtx.worktreePath)
      // A worktree folder deleted outside Solus comes back on the next turn.
      if (!current.checkout && !existsSync(effectiveGitCtx.worktreePath)) {
        await recreateMissingWorktree(effectiveGitCtx)
        current = await this.rt.checkouts.refresh(effectiveGitCtx.worktreePath)
      }
      if (!current.checkout) throw new Error('The session worktree is no longer available')
      effectiveGitCtx = current.checkout
    }
    const useWorktree = !!effectiveGitCtx?.worktreePath
    const effectiveCwd = useWorktree ? effectiveGitCtx!.worktreePath! : standInDirectory(taskFolder, resolvedProjectPath) ?? resolvedProjectPath
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

    const providerDirectories = await this.providerDirectoriesFor(sessionId, {
      workingDirectory: effectiveCwd,
      repositoryRoot: effectiveGitCtx?.repoRoot,
      codebaseId: input.codebaseId,
      noCodebase: input.noCodebase,
      preferences: input.executionPreferences,
      isCodebaseSettled,
      actor: turnActor,
    }, useWorktree && resolvedProjectPath ? resolvedProjectPath : null)

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
            loadPage: (threadId, loadProjectPath, turnLimit, before) => this.rt.history.loadHandoffPage(
              pendingHandoff.fromProvider, threadId, loadProjectPath, turnLimit, before),
            loadFirstTurn: (threadId, loadProjectPath) => this.rt.history.loadHandoffFirstTurn(pendingHandoff.fromProvider, threadId, loadProjectPath),
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
    // Stopped during setup: publishing the dispatch now would open the stopped turn again.
    turn.signal.throwIfAborted()
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
    this.rt.statuses.setStatus(sessionId, newStatus, true)
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
        fn: 'taskIdForSession',
        file: 'run-launcher.ts',
      }, async (annotate) => {
        const found = await taskIdForSession(ANY_ORGANIZATION, sessionId)
        annotate({ taskId: found ?? '' })
        return found
      })
      if (existingTask) options.taskId = existingTask
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
        // No session id yet, so no link is written here and the organization is not read.
        const prepared = await this.rt.sessionTaskPreparer(LOCAL_ORGANIZATION_ID, {
          // A session with a provider conversation is past its first dispatch.
          // A provider handoff is a new backend conversation, not a new Solus
          // session, so the prior provider id counts. A fork carries its
          // source's id purely to branch from, and the provider starts a fresh
          // conversation for it — so it is a first dispatch.
          existingAgentSessionId: isForkingSession
            ? null
            : effectiveInput.agentSessionId ?? pendingHandoff?.fromSessionId ?? null,
          taskId: boundTaskId,
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
        const composed = await taskSystemContext(options.taskId!, options.taskSnapshot ?? null, sessionId, effectiveInput.executionPreferences)
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
    void this.recordSender(sessionId, options)

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
      const pathNote = this.rt.sessionSync?.takeNote(sessionId)
      const systemPrompt = [
        userInstructions,
        options.systemPrompt,
        handoffPayload?.seedSystemAppend,
        pathNote ? portableSessionPathNote(pathNote.from, pathNote.to) : null,
        // Last, so an app's new state leaves the rest of the prompt as it was.
        this.rt.appModelContexts.systemSection(sessionId),
      ].filter(Boolean).join('\n\n')
      this.rt.sessionEmitter.recordSystemPrompt(request.sessionId, systemPrompt)
      // Image bytes are read here, not carried through the turn: `options` keeps
      // only the refs, so the transcript event and the queue preview never hold
      // base64. Must be awaited before the synchronous launch step below.
      const promptImages = await resolvePromptImages(options)
      // Resolved again here, not only at submit: a queued prompt drains later, and
      // the author's seat may have been removed or expired in between.
      const seat = await this.rt.seatForTurn(request.actor, provider)
      // The session's organization: its policies are checked again where the provider starts (plans/030 §6.3).
      const organizationId = await organizationOfSession(sessionId)
      // A member's transcripts written from here on are shared with the server when the turn ends.
      const turnStartedAt = Date.now()
      const providerPrompt = await inlineSessionGuidePrompt(options.prompt, sessionId, effectiveCwd)
      // The MCP servers' tools are listed here, for the run's person, so every run —
      // typed, queued, restored, or started by an agent — gets that person's own.
      const { tools: integrationTools, instructions: integrationInstructions, cliSkip } = await integrationToolbox(request.actor ?? HOST_ACTOR, effectiveCwd)
      // The operations of the host's apps are tools too (docs/plans/apps.md §7.1); a name already in the run stays with its tool.
      const appTools = await appOperationAgentTools(request.actor ?? HOST_ACTOR, new Set([...request.tools, ...integrationTools].map((tool) => tool.name)))
      if (this.rt.isShuttingDown) throw new Error('Interrupted')
      // The last check before the provider spawns; from here Stop cancels its run.
      turn.signal.throwIfAborted()
      releaseLaunch()
      const savedRestart = this.rt.restarts.restartRuns?.get(sessionId)
      if (savedRestart && savedRestart.runId === request.runId) {
        // From here the provider may hold the prompt, so it is never sent again.
        this.rt.restarts.restartRuns?.save({ ...savedRestart, input: effectiveInput, state: 'running', options: undefined })
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
        additionalDirectories: providerDirectories.join(', '),
        systemPromptChars: systemPrompt.length,
        isResume: !!effectiveInput.agentSessionId,
        isFork: !!effectiveInput.forked,
        fastMode: !!effectiveInput.fastMode,
        imageAttachmentCount: promptImages?.length ?? 0,
        fn: 'runAgent',
        file: 'run-launcher.ts',
      }, () => this.rt.runAgent({
        organizationId,
        provider,
        prompt: providerPrompt,
        cwd: effectiveCwd,
        projectRoot: resolvedProjectPath,
        tools: credentialScopedAgentTools([
          ...request.tools,
          ...integrationTools,
          ...appTools,
        ], request.actor),
        model: effectiveInput.model,
        reasoningEffort: effectiveInput.reasoningEffort,
        permissionMode: effectiveInput.permissionMode,
        persistence: 'session',
        service: SPAN_SERVICES.sessions,
        conversation: providerConversationFor(effectiveInput),
        additionalDirectories: providerDirectories,
        // Read here, at the spawn: a folder attached while the launch waited is in the block.
        codebase: this.rt.sessionFolders.promptFolders(sessionId),
        imageAttachments: promptImages,
        contextWindow: effectiveInput.contextWindow,
        fastMode: effectiveInput.fastMode,
        systemPrompt,
        integrationInstructions,
        delegationInstructions: effectiveInput.executionPreferences?.delegationInstructions,
        cliSkip,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        seat: seat ?? undefined,
      }, {
        sessionId,
        // Empty when tracing is off; the snapshot then records no trace.
        turnTraceId: turnTraceId || undefined,
      }))
      handle = agentRun.handle
      this.stopsWithTurn(turn, sessionId, backend, handle)
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
      // A stopped launch is already interrupted.
      if (!turn.signal.aborted) this.rt.statuses.setStatus(sessionId, 'failed')
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
