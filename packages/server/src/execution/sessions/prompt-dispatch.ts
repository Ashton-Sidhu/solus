import { childPermissionMode } from './child-permissions'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import { createLogger } from '../../logger'
import type { AgentTool } from '../agents/tools/agent-tool'
import { solusToolbox } from '../agents/tools/solus-toolbox'
import { instructionsFor, unattendedModelInputFor, runInputFromContext } from '../agents/run-input'
import { sessionExecutionPreferences } from '../../data/sessions/session-states'
import { DEFAULT_EXECUTION_PREFERENCES, type ExecutionPreferences } from '@solus/contracts/settings'
import { sessionSettings } from './session-settings'
import { resolveSessionLineageById } from '../../data/sessions/session-lineage'
import { type CreateSessionOrder } from '../orchestration/session-orchestrator'
import type { AgentId, GitCheckout, IpcContext, PromptOptions, PromptDelivery, PromptDispatchResult, SessionRunInput, ReasoningEffort } from '@solus/contracts/types'
import { defaultContextWindowFor } from '@solus/contracts/types'
import { SeatRequiredError } from '../seats/seat-manager'
import { type Actor } from '../../admission/actor'
import type { SessionRuntime, SessionRunRequest, SessionRunLifecycle, DispatchTarget } from '../session-runtime'

const log = createLogger('SessionRuntime', 'prompt-dispatch.ts')

function selectAgentTools(...groups: Array<Record<string, AgentTool>>): AgentTool[] {
  return groups.flatMap((group) => Object.values(group))
}

export interface CreateSessionRequest extends Omit<CreateSessionOrder, 'modelId'> {
  /** Null for a headless session a client starts on the provider's default. */
  modelId: string | null
  /** The requester's preferences; a child session takes its parent's when absent. */
  executionPreferences?: ExecutionPreferences
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

/**
 * Turns from each kind of sender — a client, an agent, a watch, an
 * automation — built into run requests for `SessionRuntime.runTurn`.
 */
export class PromptDispatch {
  /** Client-generated prompt ids this plane already accepted, insertion-ordered
   *  so the oldest fall off first (outbox replay dedupe, dispatch-client step 6). */
  acceptedClientPromptIds = new Set<string>()

  constructor(private readonly rt: SessionRuntime) {}

  /** Submit a prompt to a session and resolve once it has started, steered, or queued. */
  async submitPrompt(
    ctx: IpcContext,
    options: PromptOptions,
    origin?: { clientId?: string; deviceId?: string; actor?: Actor },
  ): Promise<PromptDispatchResult> {
    this.rt.assertNewWorkAllowed()
    const proposedSessionId = ctx.session.sessionId
    if (!proposedSessionId) {
      throw new Error('No sessionId provided — rejecting to prevent misrouting')
    }
    // No seat, no turn: refused here, before the prompt is echoed or queued, so the
    // client can show the connect card instead of a bubble that never answers.
    const provider = ctx.session.provider ?? resolveSessionLineageById(proposedSessionId)?.active.provider
    if (provider && ctx.session.preferredModel !== AUTO_MODEL_ID) {
      try {
        await this.rt.seatForTurn(origin?.actor, provider)
      } catch (error) {
        // The room learns who waits on a seat; the refused client also has the card.
        if (error instanceof SeatRequiredError && origin?.actor?.user) {
          void this.rt.recordActivity({ kind: 'session', id: proposedSessionId }, origin.actor, { kind: 'seat_needed', provider })
        }
        throw error
      }
    }
    if (options.clientPromptId) {
      const dedupeKey = `${proposedSessionId}:${options.clientPromptId}`
      if (this.acceptedClientPromptIds.has(dedupeKey) || this.rt.scheduler.requestQueue.hasPrompt(proposedSessionId, options.clientPromptId)) {
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
    const agentSessionId = this.rt.activeSessions.get(proposedSessionId)?.agentSessionId ?? input.agentSessionId
    // Route by the registered id, never the caller's. A client that resumed this
    // thread from disk without adopting our answer still proposes its own name;
    // obeying it re-points the binding and splits one conversation into two
    // addresses, so each client then sees only the turns it started. A fork is
    // exempt: it carries the source thread's id but is deliberately a new session.
    const sessionId = (!input.forked && agentSessionId ? this.rt.sessionOfThread(agentSessionId) : undefined)
      ?? proposedSessionId
    if (agentSessionId && !input.forked) this.rt.agentSessionToSession.set(agentSessionId, sessionId)
    const target: DispatchTarget = !input.forked && agentSessionId
      ? { kind: 'session', sessionId }
      : { kind: 'new-session' }
    let lifecycle: SessionRunLifecycle
    try {
      lifecycle = await this.rt.runTurn({
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
      if (options.clientPromptId && !this.rt.scheduler.requestQueue.hasPrompt(sessionId, options.clientPromptId)) {
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
   * The run input for a prompt nobody at the session's keyboard sent: the
   * resident run's input, or one rebuilt from the session's stored start
   * configuration. The backend gets the session's active thread; a session
   * with no lineage is its own thread (docs/plans/session-identity.md).
   */
  private async unattendedRunInput(sessionId: string): Promise<{ input: SessionRunInput }> {
    const handoff = resolveSessionLineageById(sessionId)
    const agentSessionId = handoff?.active.providerSessionId ?? sessionId
    const resident = this.rt.activeSessions.get(sessionId)
    if (resident?.runInput) return { input: { ...resident.runInput, agentSessionId, forked: false } }
    // The preferences the session's last run carried, kept across idle release and host restart.
    const preferences = sessionSettings(sessionId)?.preferences ?? await sessionExecutionPreferences(sessionId)
    const meta = await this.rt.history.getSessionInfo(sessionId)
    if (!meta) throw new Error(`Session ${sessionId} not found`)
    if (!meta.model || !meta.reasoningEffort) {
      throw new Error(`Session ${sessionId} has no persisted starting model configuration`)
    }
    const provider = handoff?.active.provider ?? meta.provider
    const cwd = handoff?.active.cwd ?? meta.cwd
    return {
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
        permissionMode: this.rt.sessionPermissionModes.get(sessionId) ?? 'supervised',
        rateLimitBehavior: 'queue',
        ...instructionsFor(preferences, meta.model),
        executionPreferences: preferences,
      },
    }
  }

  async promptSession(
    sessionId: string,
    prompt: string,
    delivery: PromptDelivery = 'queue',
    origin?: Pick<PromptOptions, 'via'> & {
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
    const { input } = await this.unattendedRunInput(sessionId)
    if (permissionMode) input.permissionMode = permissionMode
    await this.rt.seatForTurn(actor, input.provider)
    const lifecycle = await this.rt.runTurn({
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
   * Start a fresh background session running `prompt` on the given agent/model —
   * the entry for the `start_session` MCP tool. Builds a plain run input with no
   * client watching it and routes through `runTurn`, resolving once the new
   * session has initialized and returning its id. The caller renders a card,
   * which watches the session when a user opens it.
   */
  async createSession(req: CreateSessionRequest, actor?: Actor): Promise<{ sessionId: string; agentSessionId: string; taskId?: string }> {
    // No seat, no session: refused before anything is spawned (Step 2 plan §3.3).
    await this.rt.seatForTurn(actor, req.provider)
    const parentId = req.delegation?.parentSessionId
    const namingActor = actor ?? (parentId ? this.rt.activeRunRequests.get(parentId)?.actor : undefined)
    const parentMode = parentId ? this.rt.activeSessions.get(parentId)?.runInput?.permissionMode ?? this.rt.sessionPermissionModes.get(parentId) : undefined
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
          parentSessionId: req.delegation.parentSessionId,
          messageId: req.delegation.messageId,
          intent: req.delegation.intent,
          createdAt: req.delegation.createdAt,
        }
      : undefined
    const lifecycle = await this.rt.runTurn({
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
    const started = await lifecycle.agentSessionId
    this.rt.emit('background-session-created', {
      sessionId,
      prompt: req.prompt,
      cwd: req.cwd,
      preferences,
      actor: namingActor,
    })
    return { ...started, sessionId }
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
  }): Promise<{ sessionId: string; done: Promise<{ output?: string }> }> {
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
    const sessionId = crypto.randomUUID()
    const lifecycle = await this.rt.runTurn({
      input,
      target: { kind: 'new-session' },
      sessionId,
      tools: selectAgentTools(
        solusToolbox.works,
        solusToolbox.docs,
        solusToolbox.artifact,
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
        const messages = await this.rt.history.loadSession(
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
      return { sessionId, done }
    } catch (err) {
      await trackedDone.catch(() => {})
      throw err
    }
  }

  /** Re-submit the same prompt. If the session is dead, drop its provider
   *  thread so a fresh one starts. */
  async retry(ctx: IpcContext, options: PromptOptions, clientId: string | undefined, actor: Actor): Promise<void> {
    const sessionId = this.rt.sessionIdForCtx(ctx)
    if (!sessionId) throw new Error('No session to retry')
    options = this.rt.launcher.failedSetupPrompts.get(sessionId) ?? options
    const session = this.rt.activeSessions.get(sessionId)
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
      this.rt.statuses.setStatus(sessionId, 'idle')
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

    const lifecycle = await this.rt.runTurn(request)
    await lifecycle.agentSessionId
  }
}
