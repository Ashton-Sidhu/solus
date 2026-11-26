import { withWorkspaceToolAuthority } from '../../admission/workspace-tool-authority'
import { withActorScope } from '../seats/acting-identity'
import { HOST_ACTOR, insightsAccountOf, type Actor } from '../../admission/actor'
import { LOCAL_ORGANIZATION_ID } from '../../admission/principal'
import { userKey } from '@solus/contracts/user'
import { captureServerEvent } from '../../analytics'
import { sessionIsOrganizationWork } from '../../data/sessions/session-records'
import { taskOfTurn, linkPreparedTask } from './run-task-context'
import type { AgentTool } from '../agents/tools/agent-tool'
import { toolAccessRefusal } from '../agents/tools/tool-access'
import type { RunHandle } from '../agents/agent-backend'
import type { SessionRuntime, SessionRunRequest, SessionRunLifecycle } from '../session-runtime'
import type { Turn } from './turns'

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
 * A call runs only when its person may take the action it names (plans/035 §5).
 */
export function credentialScopedAgentTools(tools: AgentTool[], actor: Actor = HOST_ACTOR): AgentTool[] {
  return tools.map((agentTool) => {
    const scoped: AgentTool = {
      ...agentTool,
      execute: async (input, context) => {
        const refusal = await toolAccessRefusal(agentTool, input, context.sessionId(), actor.principal)
        if (refusal) return { ok: false, text: refusal }
        return withActorScope(actor, () => withWorkspaceToolAuthority(actor.principal, () => agentTool.execute(input, context)))
      },
    }
    // Whether the tool is for this person is read as them too.
    const { isOffered } = agentTool
    if (isOffered) scoped.isOffered = () => withWorkspaceToolAuthority(actor.principal, isOffered)
    return scoped
  })
}

export interface StartedRun {
  handle: RunHandle
  run: SessionRunRequest
}

export async function startRun(
  rt: SessionRuntime,
  pendingStarts: Map<RunHandle, PendingStart>,
  launch: (request: SessionRunRequest, traceId: string, turn: Turn, releaseLaunch: () => void) => Promise<StartedRun>,
  request: SessionRunRequest, turn: Turn, releaseLaunch: () => void,
): Promise<SessionRunLifecycle> {
  if (request.actor) rt.rememberSessionActor(request.sessionId, request.actor)
  await rt.settleRunOrganization(request)
  // Every prepared/initialized view of a run shares this one exchange array.
  // The request is copied while setup resolves, but ownership must not be.
  request.exchangeIds ??= []
  request.runId ??= crypto.randomUUID()
  if (request.reportExchangeIds?.length) rt.orchestration?.reportsAccepted(request.reportExchangeIds)
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
  const organizationId = await rt.turnOrganization(request.sessionId)
  rt.restarts.saveRestartRun(request, await sessionIsOrganizationWork(request.sessionId))
  const account = insightsAccountOf(request.actor)
  let actor: { userId: string; email?: string } | undefined
  if (account) {
    actor = { userId: userKey(account.id) }
    if (account.email) actor.email = account.email
  }
  const turnTraceId = rt.sessionEmitter.beginTurn({
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
    startedRun = await rt.sessionEmitter.runDispatch(
      request.sessionId,
      'launch_run',
      { promptSource, fn: 'launchRun', file: 'run-launcher.ts' },
      () => launch(request, turnTraceId, turn, releaseLaunch),
    )
  } catch (error) {
    failLaunch(rt, request, turn, turnTraceId, error instanceof Error ? error : new Error(String(error)))
  }
  return finishRunSetup(rt, pendingStarts, startedRun, request, { runStartedAt, promptSource, requestedModel, turnTraceId })
}

interface RunTrace {
  runStartedAt: number
  promptSource: NonNullable<SessionRunRequest['options']['promptSource']>
  requestedModel: string | undefined
  turnTraceId: string
}

async function finishRunSetup(
  rt: SessionRuntime, pendingStarts: Map<RunHandle, PendingStart>, startedRun: StartedRun,
  request: SessionRunRequest, trace: RunTrace,
): Promise<SessionRunLifecycle> {
  const { runStartedAt, promptSource, requestedModel } = trace
  const { handle, run } = startedRun
  const startedExchanges = rt.runExchanges(request)
  // The provider can refuse the turn on a limit before its launch finishes
  // reporting; a parked run has not started, and its release starts it again.
  const parkedBeforeStart = rt.activeSessions.get(request.sessionId)?.status === 'rate_limited'
  if (startedExchanges && !parkedBeforeStart) rt.orchestration?.runStarted(startedExchanges)
  // Its own scope: this runs after `launch_run` resolved, so there is no
  // ambient step left to nest under — but it is still inside the setup
  // window, being awaited before setup is closed below.
  const turnTask = await rt.sessionEmitter.runDispatch(
    request.sessionId,
    'task_dimension',
    { taskId: run.options.issueId ?? '', fn: 'taskOfTurn', file: 'run-task-context.ts' },
    async (annotate) => {
      const task = await taskOfTurn(run)
      annotate({ taskId: task?.id ?? '', title: task?.title ?? '' })
      return task
    },
  )
  rt.sessionEmitter.completeSetup(request.sessionId, {
    provider: run.input.provider,
    model: run.input.model,
    contextWindow: run.input.contextWindow,
    requestedModel,
    projectRoot: run.input.projectPath || run.input.workingDirectory,
    origin: promptSource,
    reasoningEffort: run.input.reasoningEffort,
    taskId: turnTask?.id,
    automationId: run.options.sender?.kind === 'automation' ? run.options.sender.automationId : undefined,
    automationName: run.options.sender?.kind === 'automation' ? run.options.sender.name : undefined,
    taskTitle: turnTask?.title,
    branch: run.input.gitContext?.branch ?? undefined,
    isResume: !!run.input.agentSessionId,
    organizationId: await rt.turnOrganization(request.sessionId),
  })
  if (request.servedEnqueuedAt !== undefined) {
    rt.sessionEmitter.recordQueueWait(request.sessionId, request.servedEnqueuedAt, runStartedAt)
  }
  if (handle.agentSessionId && (!run.input.agentSessionId || run.input.forked) && run.options.issueId) {
    await linkPreparedTask(run, request.sessionId)
  }
  return observeRun(rt, pendingStarts, startedRun, request, trace)
}

function observeRun(
  rt: SessionRuntime, pendingStarts: Map<RunHandle, PendingStart>, { handle, run }: StartedRun,
  request: SessionRunRequest, { runStartedAt, turnTraceId }: RunTrace,
): SessionRunLifecycle {
  const agentSessionId = handle.agentSessionId
    ? Promise.resolve(startedSession(handle.agentSessionId, run.options.issueId))
    : new Promise<{ agentSessionId: string; taskId?: string }>((resolve, reject) => {
        pendingStarts.set(handle, {
          run,
          resolve,
          reject,
        })
        handle.runPromise.then(
          () => {
            if (!pendingStarts.has(handle)) return
            pendingStarts.delete(handle)
            reject(new Error('Run completed before session_init'))
          },
          (err) => {
            if (!pendingStarts.has(handle)) return
            pendingStarts.delete(handle)
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
    const limit = rt.rateLimitPark.currentRateLimitEvent(settledSessionId)
    return !!limit && limit.deferCurrentRun !== true
      && (request.input.rateLimitBehavior === 'ask' || request.input.rateLimitBehavior === 'queue')
  }
  const done = handle.runPromise.then(
    () => {
      const fallback = handle.abortController.signal.aborted ? 'interrupted' as const : 'completed' as const
      const status = rt.sessionEmitter.finishTurn(settledSessionId, fallback, Date.now(), turnTraceId)
      captureSettledRun(status)
      archiveTurn(rt, request, run, handle, status)
      if (!isParkedRateLimit()) {
        rt.settleRunExchanges(request, status, handle, {
          durationMs: Date.now() - runStartedAt,
          toolCallCount: handle.toolCallCount,
        })
      }
      return handle.resultText ? { output: handle.resultText } : {}
    },
    (error) => {
      const fallback = handle.abortController.signal.aborted ? 'interrupted' as const : 'failed' as const
      const status = rt.sessionEmitter.finishTurn(settledSessionId, fallback, Date.now(), turnTraceId)
      captureSettledRun(status)
      archiveTurn(rt, request, run, handle, status)
      if (!isParkedRateLimit()) {
        rt.settleRunExchanges(request, status, handle, {
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
      if (handle.agentSessionId && rt.stopSession(handle.agentSessionId, HOST_ACTOR)) return
      handle.abortController.abort()
    },
    disposition: 'started',
  }
}

/**
 * Hands an ended turn to the session repository writer
 * (docs/plans/portable-sessions.md §7.2). Not awaited: the turn is settled, and
 * the writer records its own failures.
 */
function archiveTurn(rt: SessionRuntime, request: SessionRunRequest, run: SessionRunRequest, handle: RunHandle, status: 'completed' | 'interrupted' | 'failed'): void {
  const threadId = handle.agentSessionId
  const sessionArchive = rt.sessionArchive
  if (!sessionArchive || handle.persistence !== 'session' || !threadId) return
  const sessionId = request.sessionId
  const endedAt = Date.now()
  const workTree = rt.sessionCheckouts.getGitContext(sessionId)?.worktreePath ?? run.input.gitContext?.worktreePath ?? run.input.workingDirectory
  // The provider files of a member's thread are in that member's home, so the read acts as them.
  void withActorScope(request.actor ?? HOST_ACTOR, async () => sessionArchive.turnEnded({
    sessionId,
    organizationId: await rt.turnOrganization(sessionId).catch(() => undefined) ?? LOCAL_ORGANIZATION_ID,
    provider: run.input.provider,
    threadId,
    projectPath: workTree,
    workTree,
    partial: status !== 'completed',
    endedAt,
    model: run.input.model,
    reasoningEffort: run.input.reasoningEffort,
    permissionMode: run.input.permissionMode,
  }))
}

function failLaunch(rt: SessionRuntime, request: SessionRunRequest, turn: Turn, turnTraceId: string, error: Error): never {
  if (!rt.isShuttingDown) rt.restarts.restartRuns?.remove(request.sessionId, request.runId)
  const interrupted = error.message === 'Interrupted'
  rt.sessionEmitter.finishTurn(request.sessionId, interrupted ? 'interrupted' : 'failed', Date.now(), turnTraceId)
  rt.cancelRunExchanges(request, interrupted ? 'interrupted' : 'failed',
    interrupted ? undefined : `The turn could not start: ${error.message}`)
  // No provider ran, so no provider exit starts the next queued prompt.
  if (turn.signal.aborted) rt.scheduler.processQueueForSession(request.sessionId)
  throw error
}
