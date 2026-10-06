import type { RunLedger } from '../../data/sessions/run-ledger'
import { SessionRequestQueue, type QueuedRequest } from './session-request-queue'
import { sessionQueueMutationSchema, type SessionQueueMutation, type SessionQueueSnapshot } from '@solus/contracts/session-queue'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import { createLogger } from '../../logger'
import type { AgentTool } from '../agents/tools/agent-tool'
import { solusToolbox } from '../agents/tools/solus-toolbox'
import { runInputFromContext } from '../agents/run-input'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import { getIndexedSession } from '../../db/session-indexer'
import { resolveSessionLineageById } from '../../data/sessions/session-lineage'
import type { NormalizedEvent, IpcContext, QueuedPromptSnapshot, QueuedPromptReason, SessionRunInput } from '@solus/contracts/types'
import { isSessionBusyStatus, isSteerableStatus, MODEL_PROFILES } from '@solus/contracts/types'
import { HOST_ACTOR, type Actor } from '../../admission/actor'
import type { ActivityKind } from '@solus/contracts/activity'
import { sameUser } from '@solus/contracts/user'
import type { SessionRuntime, SessionRunRequest, SessionRunLifecycle } from '../session-runtime'

const log = createLogger('SessionRuntime', 'run-scheduler.ts')

const MAX_QUEUE_DEPTH = 32

/**
 * The durable queue of a session: entry order, edits, provider switches in
 * delivery order, holds and Resume, and the drain that starts the next run.
 */
export class RunScheduler {
  readonly requestQueue: SessionRequestQueue
  readonly applyingQueuedSwitch = new Set<string>()
  private readonly reservedQueueEntries = new Set<string>()

  constructor(private readonly rt: SessionRuntime, runLedger: RunLedger | undefined) {
    this.requestQueue = new SessionRequestQueue(runLedger)
  }

  queuedExchanges(): Array<{ sessionId: string; queueId: string; exchangeIds: string[]; reportExchangeIds: string[]; started: boolean }> {
    return [...this.requestQueue.values()].flatMap((entries) => entries.map((entry) => ({
      sessionId: entry.sessionId, queueId: entry.queueId, exchangeIds: entry.run.exchangeIds ?? [],
      reportExchangeIds: entry.run.reportExchangeIds ?? [], started: !!entry.started,
    })))
  }

  hasQueuedPrompt(sessionId: string, queueId: string): boolean {
    return this.requestQueue.get(sessionId)?.some((request) => request.queueId === queueId) ?? false
  }

  /** Rewrite a queued prompt this host sent itself, such as a report that later
   *  reports merge into. Same effect as a person editing it in the queue. */
  replaceQueuedPrompt(sessionId: string, queueId: string, text: string, reportExchangeIds?: string[], exchangeIds?: string[]): boolean {
    return this.editQueued(sessionId, queueId, text, undefined, { reportExchangeIds, exchangeIds })
  }

  enqueueRequest(
    run: SessionRunRequest,
    metadata: {
      reason: QueuedPromptReason
      sessionId: string
      deviceId?: string
      sourceSessionId?: string
      rateLimitSessionId?: string
      releaseAt?: number
      rateLimitType?: string
    },
  ): SessionRunLifecycle {
    const requestedInput = { ...run.input }
    const target = this.requestQueue.lastSwitchInput(metadata.sessionId)
    if (target) {
      run.input = { ...run.input, provider: target.provider, agentSessionId: null, model: target.model,
        preferredModel: target.preferredModel, reasoningEffort: target.reasoningEffort,
        contextWindow: target.contextWindow, fastMode: target.fastMode }
    }
    const { options } = run
    const queueKey = metadata.sessionId

    let totalDepth = 0
    for (const q of this.requestQueue.values()) totalDepth += q.length
    if (totalDepth >= MAX_QUEUE_DEPTH) {
      throw new Error('Request queue full — back-pressure')
    }

    const queueId = crypto.randomUUID()
    const enqueuedAt = Date.now()
    const prompt = options.displayPrompt ?? options.prompt
    log.info('request_queued', { sessionId: queueKey, reason: metadata.reason, depth: totalDepth + 1 })
    const queuedEvent: Extract<NormalizedEvent, { type: 'prompt_queued' }> = {
      type: 'prompt_queued',
      text: prompt,
      queueId,
      enqueuedAt,
      reason: metadata.reason,
      releaseAt: metadata.releaseAt,
      rateLimitType: metadata.rateLimitType,
      images: options.imageAttachments,
      imageRefs: options.imageAttachmentRefs,
      clientPromptId: options.clientPromptId,
    }
    if (options.via) queuedEvent.via = options.via
    // A held prompt names its author like a sent one: the queue is read by
    // everyone in the room, and a drained turn runs under this person's seat.
    if (run.actor?.user) queuedEvent.author = run.actor.user

    let resolveDone!: () => void
    let rejectDone!: (reason: Error) => void
    const queuedDone = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    this.requestQueue.enqueue({
      queueId,
      prompt,
      sessionId: queueKey,
      deviceId: metadata.deviceId,
      run,
      requestedInput,
      reason: metadata.reason,
      sourceSessionId: metadata.sourceSessionId,
      rateLimitSessionId: metadata.rateLimitSessionId,
      releaseAt: metadata.releaseAt,
      rateLimitType: metadata.rateLimitType,
      resolve: resolveDone,
      reject: rejectDone,
      enqueuedAt,
    })

    this.rt.publish(queueKey, queuedEvent)
    this.publishQueue(queueKey)
    const queuedExchanges = this.rt.runExchanges(run)
    if (queuedExchanges) this.rt.orchestration?.runQueued(queuedExchanges)

    const done = queuedDone.then(() => ({}))
    void done.catch(() => {})
    return {
      agentSessionId: Promise.resolve({ agentSessionId: queueKey }),
      done,
      cancel: () => { this.cancelQueued(queueKey, queueId) },
      disposition: 'queued',
      queueId,
    }
  }

  drainQueue(sessionId: string): void {
    const reason = new Error('Interrupted')
    const queue = this.requestQueue.get(sessionId)
    if (!queue) return
    for (let i = queue.length - 1; i >= 0; i--) {
      const req = queue[i]
      this.requestQueue.remove(sessionId, req.queueId)
      // A queued prompt never reaches the normal settlement path when Stop
      // drains it, so its sender would otherwise stay held forever.
      this.rt.cancelRunExchanges(req.run)
      req.reject(reason)
      this.rt.publish(req.sessionId, { type: 'prompt_dequeued', queueId: req.queueId })
      if (req.rateLimitSessionId) this.rt.rateLimitPark.cleanupRateLimitTimerIfUnused(req.rateLimitSessionId)
      log.info('queued_request_drained', { queueId: req.queueId, sessionId })
    }
    this.requestQueue.save(sessionId)
  }

  sessionQueue(ctx: IpcContext): SessionQueueSnapshot {
    const sessionId = this.rt.sessionIdForCtx(ctx)
    if (!sessionId) throw new Error('A session is required to read its queue.')
    return { held: !!this.requestQueue.get(sessionId)?.some((entry) => entry.held), entries: this.queuedPromptsForSession(sessionId) }
  }

  publishQueue(sessionId: string): void {
    this.rt.publish(sessionId, { type: 'session_queue', held: !!this.requestQueue.get(sessionId)?.some((entry) => entry.held), entries: this.queuedPromptsForSession(sessionId) })
  }

  async sessionQueueChange(ctx: IpcContext, input: SessionQueueMutation, actor: Actor): Promise<SessionQueueSnapshot> {
    const sessionId = this.rt.sessionIdForCtx(ctx)
    if (!sessionId) throw new Error('A session is required to change its queue.')
    return this.changeSessionQueue(sessionId, runInputFromContext(ctx), sessionQueueMutationSchema.parse(input), actor)
  }

  private async changeSessionQueue(sessionId: string, sourceInput: SessionRunInput, mutation: SessionQueueMutation, actor: Actor): Promise<SessionQueueSnapshot> {
    if (mutation.kind === 'switch') {
      await this.queueProviderSwitch(sessionId, sourceInput, mutation, actor)
    } else if (mutation.kind === 'resume') {
      const entries = this.requestQueue.get(sessionId) ?? []
      if (entries.some((entry) => this.reservedQueueEntries.has(entry.queueId))) throw new Error('A queue change is still being applied. Try Resume after it finishes.')
      const resumable = entries.filter((entry) => {
        if (!entry.held) return false
        const author = entry.run.actor?.user ?? entry.author
        return author ? !!actor.user && sameUser(author.id, actor.user.id) : ['local-owner', 'remote-owner', 'system'].includes(actor.principal.kind)
      })
      if (!resumable.length && entries.some((entry) => entry.held)) throw new Error('Each author must resume their own queued work.')
      for (const entry of resumable) {
        entry.held = false
        entry.error = undefined
        entry.run.actor = actor
        entry.revision = (entry.revision ?? 0) + 1
      }
      this.requestQueue.save(sessionId)
      this.processQueueForSession(sessionId)
    } else {
      const entry = this.requestQueue.get(sessionId)?.find((item) => item.queueId === mutation.queueId)
      if (!entry || (entry.revision ?? 0) !== mutation.revision) {
        throw new Error('This queue entry changed or started. Refresh the queue before editing it.')
      }
      if (this.reservedQueueEntries.has(entry.queueId)) throw new Error('This queue entry is being delivered. Wait for the provider to answer.')
      await this.changeQueueEntry(entry, mutation, actor)
    }
    this.publishQueue(sessionId)
    return { held: !!this.requestQueue.get(sessionId)?.some((entry) => entry.held), entries: this.queuedPromptsForSession(sessionId) }
  }

  private async changeQueueEntry(entry: QueuedRequest,
    mutation: Exclude<SessionQueueMutation, { kind: 'switch' | 'resume' }>, actor: Actor): Promise<void> {
    if (mutation.kind === 'remove') {
      this.cancelQueued(entry.sessionId, entry.queueId, actor)
      this.processQueueForSession(entry.sessionId)
    } else if (mutation.kind === 'move') {
      this.requestQueue.move(entry.sessionId, entry.queueId, mutation.beforeQueueId)
      this.rebindQueue(entry.sessionId)
    } else if (mutation.kind === 'edit') {
      this.requestQueue.edit(entry, mutation)
      this.recordHeldPromptChange(entry, actor, 'edited')
    } else {
      if (entry.kind === 'provider_switch' || entry.held) throw new Error('Resume the queue before steering a prompt.')
      const active = this.rt.activeSessions.get(entry.sessionId)
      if (!active?.agentSessionId || !isSteerableStatus(active.status)) throw new Error('There is no active turn to steer.')
      if (entry.run.input.provider !== active.backendId) throw new Error('A prompt cannot steer across a queued provider switch.')
      const author = entry.run.actor?.user ?? entry.author
      if (author && (!actor.user || !sameUser(author.id, actor.user.id))) throw new Error('Only its author can promote a prompt to steering.')
      // Reserve the entry while the provider answers. A concurrent edit cannot
      // change the text after it was sent, and a completed turn cannot drain it.
      entry.held = true
      entry.revision = (entry.revision ?? 0) + 1
      this.requestQueue.save(entry.sessionId)
      this.publishQueue(entry.sessionId)
      this.reservedQueueEntries.add(entry.queueId)
      let accepted: SessionRunLifecycle | null
      try {
        accepted = await this.rt.launcher.steerActiveTurn({ ...entry.run, actor, options: { ...entry.run.options, delivery: 'steer' } }, active.agentSessionId, active)
        if (!accepted) throw new Error('The turn ended before steering was accepted. The prompt remains queued.')
      } catch (error) {
        entry.held = false
        this.requestQueue.save(entry.sessionId)
        this.publishQueue(entry.sessionId)
        throw error
      } finally { this.reservedQueueEntries.delete(entry.queueId) }
      this.requestQueue.remove(entry.sessionId, entry.queueId)
      this.rt.publish(entry.sessionId, { type: 'prompt_dequeued', queueId: entry.queueId })
      void accepted.done.then(() => entry.resolve(), (error) => entry.reject(error))
    }
  }

  private async queueProviderSwitch(sessionId: string, sourceInput: SessionRunInput, mutation: Extract<SessionQueueMutation, { kind: 'switch' }>, actor: Actor): Promise<void> {
    this.rt.assertNewWorkAllowed()
    const backend = this.rt.backendFor(mutation.provider)
    if (backend.metadata.available === false) throw new Error(backend.metadata.unavailableReason ?? 'This provider is unavailable on the host.')
    if (mutation.modelConfig.modelId === AUTO_MODEL_ID) throw new Error('Choose a specific model for a provider switch.')
    const modelId = mutation.modelConfig.modelId ?? backend.metadata.defaultModel
    const profile = MODEL_PROFILES[mutation.provider]?.[modelId]
    if (modelId && !profile && !backend.metadata.models.some((model) => model.id === modelId)) throw new Error('This model is unavailable for the selected provider.')
    if (profile && (!profile.reasoningLevels.includes(mutation.modelConfig.reasoningEffort)
      || mutation.modelConfig.fastMode && !profile.supportsFastMode
      || mutation.modelConfig.contextWindow !== null && !profile.contextWindows.includes(mutation.modelConfig.contextWindow))) {
      throw new Error('These options are unavailable for the selected model.')
    }
    let depth = 0
    for (const queue of this.requestQueue.values()) depth += queue.length
    if (depth >= MAX_QUEUE_DEPTH) throw new Error('Request queue full — back-pressure')
    const config = mutation.modelConfig
    const input = { ...sourceInput }
    input.provider = mutation.provider
    input.model = modelId
    input.preferredModel = modelId || null
    input.reasoningEffort = config.reasoningEffort
    input.contextWindow = config.contextWindow
    input.fastMode = config.fastMode
    const text = `Switch to ${mutation.provider}${config.modelId ? ` · ${config.modelId}` : ''}`
    const entry: QueuedRequest = {
      queueId: crypto.randomUUID(), sessionId, kind: 'provider_switch', prompt: text,
      enqueuedAt: Date.now(), reason: 'busy', held: true, resolve: () => {}, reject: () => {},
      run: { sessionId, target: { kind: 'session', sessionId }, input, tools: [], actor,
        options: { prompt: '', displayPrompt: text } },
    }
    // Reserve delivery order before the asynchronous seat check.
    this.requestQueue.enqueue(entry)
    this.reservedQueueEntries.add(entry.queueId)
    try { await this.rt.seatForTurn(actor, mutation.provider) } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error)
      this.requestQueue.save(sessionId)
      this.publishQueue(sessionId)
      throw error
    } finally { this.reservedQueueEntries.delete(entry.queueId) }
    entry.held = false
    this.requestQueue.save(sessionId)
    this.publishQueue(sessionId)
    this.processQueueForSession(sessionId)
  }

  private rebindQueue(sessionId: string): void {
    const active = this.rt.activeSessions.get(sessionId)
    const first = this.requestQueue.get(sessionId)?.[0]
    const lineage = resolveSessionLineageById(sessionId)?.active
    const provider = active?.backendId ?? lineage?.provider
    const current = active?.runInput ?? (first && first.run.input.provider === provider ? first.run.input : first?.requestedInput ?? first?.run.input)
    if (current) this.requestQueue.rebind(sessionId, { ...current, provider: provider ?? current.provider,
      agentSessionId: active?.agentSessionId ?? lineage?.providerSessionId ?? current.agentSessionId })
  }

  private async applyQueuedProviderSwitch(entry: QueuedRequest): Promise<void> {
    const sessionId = entry.sessionId
    this.applyingQueuedSwitch.add(sessionId)
    try {
      const target = entry.run.input
      const session = this.rt.activeSessions.get(sessionId)
      const current = resolveSessionLineageById(sessionId)?.active
      const threadId = session?.agentSessionId ?? current?.providerSessionId ?? target.agentSessionId
      const sourceProvider = session?.backendId ?? current?.provider ?? getIndexedSession(threadId ?? '')?.provider
      if (sourceProvider && threadId && sourceProvider !== target.provider) {
        // Check the incoming budget before committing a provider change.
        await this.rt.handoffs.handoffBuilder(threadId, target.projectPath, {
          loadSession: async (id, path) => this.rt.handoffs.handoffCarry.merge(id, await this.rt.history.loadSession(sourceProvider, id, path)),
          fromProvider: sourceProvider, targetProvider: target.provider, targetModel: target.model,
          contextWindow: target.contextWindow, nextPrompt: (this.requestQueue.get(sessionId)?.[0]?.run.options.prompt ?? '') + target.extraInstructions,
          historyTokens: target.executionPreferences?.handoffHistoryTokens ?? DEFAULT_EXECUTION_PREFERENCES.handoffHistoryTokens,
          sourceStatus: this.rt.handoffs.handoffCarry.get(threadId)?.status ?? session?.status,
        })
      }
      const result = sourceProvider === target.provider
        ? null : await this.rt.handoffs.switchSessionProvider(sessionId, target.provider, threadId, entry.run.actor ?? HOST_ACTOR)
      if (session) session.runInput = { ...target, agentSessionId: result ? result.restoredSessionId ?? null : threadId ?? null }
      this.requestQueue.settle(entry)
      this.requestQueue.rebind(sessionId, { ...target, agentSessionId: result ? result.restoredSessionId ?? null : threadId ?? null })
      this.rt.publish(sessionId, { type: 'provider_switch_applied', provider: target.provider,
        modelConfig: { modelId: target.preferredModel, reasoningEffort: target.reasoningEffort, contextWindow: target.contextWindow, fastMode: target.fastMode }, result })
    } catch (error) {
      try { this.requestQueue.settle(entry, error instanceof Error ? error.message : String(error)) } catch (saveError) {
        this.requestQueue.holdUncertain(entry, `The host could not save the result. Check its history before resuming: ${String(saveError)}`)
        log.error('queue_settlement_save_failed', { sessionId, queueId: entry.queueId, error: String(saveError) })
      }
    } finally {
      this.applyingQueuedSwitch.delete(sessionId)
      this.publishQueue(sessionId)
      this.processQueueForSession(sessionId)
    }
  }

  cancelQueuedPrompt(ctx: IpcContext, queueId: string, actor: Actor): boolean {
    const sessionId = this.rt.sessionIdForCtx(ctx)
    if (!sessionId) return false
    return this.cancelQueued(sessionId, queueId, actor)
  }

  /** Callers outside the renderer name the session by its provider thread. */
  cancelQueued(sessionId: string, queueId: string, actor?: Actor): boolean {
    const queue = this.requestQueue.get(sessionId)
    if (!queue) return false
    const idx = queue.findIndex((r) => r.queueId === queueId)
    if (idx === -1) return false
    this.rt.cancelRunExchanges(queue[idx]!.run)
    const req = this.requestQueue.remove(sessionId, queueId)!
    this.rebindQueue(sessionId)
    req.reject(new Error('Cancelled by user'))
    this.rt.publish(req.sessionId, { type: 'prompt_dequeued', queueId: req.queueId })
    this.recordHeldPromptChange(req, actor, 'removed')
    if (req.rateLimitSessionId) this.rt.rateLimitPark.cleanupRateLimitTimerIfUnused(req.rateLimitSessionId)
    this.requestQueue.save(sessionId)
    this.publishQueue(sessionId)
    log.info('queued_request_cancelled', { queueId, sessionId })
    return true
  }

  /** Rewrite a prompt that is still waiting its turn. Both fields matter: the
   *  queue displays `displayPrompt ?? prompt`, the run sends `prompt`. */
  editQueuedPrompt(ctx: IpcContext, queueId: string, text: string, actor: Actor): boolean {
    const sessionId = this.rt.sessionIdForCtx(ctx)
    return sessionId ? this.editQueued(sessionId, queueId, text, actor) : false
  }

  private editQueued(sessionId: string, queueId: string, text: string, actor?: Actor, reports?: { reportExchangeIds?: string[]; exchangeIds?: string[] }): boolean {
    const trimmed = text.trim()
    if (!trimmed) return false
    const req = this.requestQueue.get(sessionId)?.find((r) => r.queueId === queueId)
    if (!req) return false

    if (this.reservedQueueEntries.has(req.queueId)) return false
    this.requestQueue.edit(req, { kind: 'edit', queueId, revision: req.revision ?? 0, text: trimmed }, reports)
    this.rt.publish(req.sessionId, { type: 'prompt_queue_updated', queueId, text: trimmed })
    this.recordHeldPromptChange(req, actor, 'edited')
    this.publishQueue(sessionId)
    log.info('queued_request_edited', { queueId, sessionId })
    return true
  }

  /**
   * Someone removed or edited a prompt another person held (plan 004 D2): the
   * prompt's author and everyone else read who did it. A person changing their
   * own held prompt, and the host draining the queue, record nothing.
   */
  private recordHeldPromptChange(req: QueuedRequest, actor: Actor | undefined, change: 'removed' | 'edited'): void {
    const by = actor?.user
    const author = req.run.actor?.user ?? undefined
    if (!actor || !by || (author && sameUser(by.id, author.id))) return
    const kind: ActivityKind = author
      ? { kind: 'queued_prompt_changed', queueId: req.queueId, change, author }
      : { kind: 'queued_prompt_changed', queueId: req.queueId, change }
    void this.rt.recordActivity({ kind: 'session', id: req.sessionId }, actor, kind)
  }

  /** Whether the next drain would actually dispatch — the same question
   *  `processQueueForSession` asks, for callers that must decide before it is
   *  safe to run the drain itself. */
  hasReadyQueuedRequest(sessionId: string): boolean {
    const next = this.requestQueue.get(sessionId)?.[0]
    return !!next && this.isQueuedRequestReady(next)
  }

  private isQueuedRequestReady(req: QueuedRequest): boolean {
    if (req.held || this.applyingQueuedSwitch.has(req.sessionId)) return false
    if (req.kind === 'provider_switch') {
      const session = this.rt.activeSessions.get(req.sessionId)
      if (session && (isSessionBusyStatus(session.status) || (!!session.agentSessionId && this.rt.backendFor(session.backendId).isSessionRunning(session.agentSessionId)))) return false
    }
    if (req.reason !== 'rate_limit') return true
    if (!req.rateLimitSessionId) return true
    const event = this.rt.rateLimitPark.rateLimits.current(req.rateLimitSessionId, Date.now() / 1000)
    if (!event) return true
    // A limit with no known reset never becomes ready on its own; only an
    // explicit send releases it.
    if (event.resetsAt === null) return false
    return event.resetsAt * 1000 <= Date.now()
  }

  processQueueForSession(sessionId: string): boolean {
    if (this.rt.isShuttingDown) return false
    const queue = sessionId ? this.requestQueue.get(sessionId) : undefined
    if (!queue?.length) return false
    const resident = this.rt.activeSessions.get(sessionId)
    if (resident && isSessionBusyStatus(resident.status) && resident.status !== 'background') return false

    // Only process the oldest (first) request. If it isn't ready yet, don't
    // skip ahead — the queue is FIFO and later entries may depend on this one.
    const req = queue[0]
    if (!this.isQueuedRequestReady(req)) return false

    try { this.requestQueue.claim(sessionId) } catch (error) {
      req.held = true
      req.error = `The host could not save the delivery receipt: ${error instanceof Error ? error.message : String(error)}`
      req.revision = (req.revision ?? 0) + 1
      this.publishQueue(sessionId)
      log.error('queue_receipt_save_failed', { sessionId, queueId: req.queueId, error: String(error) })
      return false
    }
    log.info('queued_request_processing', { queueId: req.queueId })

    this.rt.publish(req.sessionId, { type: 'prompt_dequeued', queueId: req.queueId })
    if (req.kind === 'provider_switch') {
      void this.applyQueuedProviderSwitch(req)
      return true
    }

    const reqInput = req.run.input
    const dispatchSession = this.rt.activeSessions.get(req.sessionId)
    const freshProvider = reqInput.provider
    const input: SessionRunInput = {
      ...reqInput,
      provider: freshProvider,
      agentSessionId: dispatchSession?.backendId === freshProvider ? dispatchSession.agentSessionId : reqInput.agentSessionId,
    }

    const run: SessionRunRequest = {
      ...req.run,
      input,
      target: { kind: 'session', sessionId: req.sessionId },
      sessionId: req.sessionId,
      servedQueueId: req.queueId,
      servedEnqueuedAt: req.enqueuedAt,
      // SAFETY: the shared executor validates each tool's declared Zod fields
      // before invoking it. Restore the full catalog, never persisted closures.
      tools: req.run.tools.length ? req.run.tools : Object.values(solusToolbox).flatMap((group) => Object.values(group)) as AgentTool[],
      options: { ...req.run.options, promptSource: 'queued' },
    }
    // A session in 'background' still has its provider query open. A second
    // run would resume the same thread beside it, so the prompt goes into the
    // open query; a fresh run is only the fallback once that query has closed.
    const lifecycle = dispatchSession?.status === 'background' && dispatchSession.agentSessionId
      ? this.rt.launcher.steerActiveTurn(run, dispatchSession.agentSessionId, dispatchSession)
        .then((steered) => steered ?? this.rt.launcher.startRunLifecycle(run))
      : this.rt.launcher.startRunLifecycle(run)
    lifecycle
      .then((lifecycle) => lifecycle.done)
      .then(() => { this.requestQueue.settle(req); req.resolve(); this.publishQueue(sessionId) })
      .catch((error) => {
        try { this.requestQueue.settle(req, error instanceof Error ? error.message : String(error)) } catch (saveError) {
          this.requestQueue.holdUncertain(req, `The host could not save the result. Check its history before resuming: ${String(saveError)}`)
          log.error('queue_settlement_save_failed', { sessionId, queueId: req.queueId, error: String(saveError) })
        }
        req.reject(error)
        this.publishQueue(sessionId)
      })
    return true
  }

  queuedPromptsForSession(sessionId: string): QueuedPromptSnapshot[] {
    const queue = this.requestQueue.get(sessionId) ?? []
    return queue
      .filter((entry) => entry.run.options.via !== 'session-report' && entry.run.options.via !== 'question-answer')
      .map((r) => ({
        queueId: r.queueId,
        kind: r.kind ?? 'prompt', revision: r.revision ?? 0, held: r.held, error: r.error,
        provider: r.run.input.provider,
        modelConfig: { modelId: r.run.input.preferredModel, reasoningEffort: r.run.input.reasoningEffort, contextWindow: r.run.input.contextWindow, fastMode: r.run.input.fastMode },
        attachments: r.run.options.queueAttachments,
        clientPromptId: r.run.options.clientPromptId,
        text: r.prompt,
        enqueuedAt: r.enqueuedAt,
        reason: r.reason,
        releaseAt: r.releaseAt,
        rateLimitType: r.rateLimitType,
        images: r.run.options.imageAttachments,
        imageRefs: r.run.options.imageAttachmentRefs,
        author: r.run.actor?.user ?? r.author,
      }))
  }
}
