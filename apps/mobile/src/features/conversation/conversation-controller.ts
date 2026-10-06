import type { SendOutbox } from '@solus/client-core/send-outbox'
import { INITIAL_HISTORY_TURNS, OLDER_HISTORY_TURNS } from '@solus/client-core/session-history-page'
import type { AgentId, AgentMetadata, PermissionMode, ReasoningEffort, SessionRecord, WatchSessionResult, WireNormalizedEvent } from '@solus/contracts/types'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import type { ExecutionPreferences } from '@solus/contracts/settings'
import type { ModelOptions } from '@solus/contracts/settings'
import { isSessionBusyStatus, REQUEST_NOT_ANSWERABLE_CODE, requestExpiryText } from '@solus/contracts/types'
import { rpcErrorCode } from '@solus/client-core/rpc-error'
import type { HostConnection } from '../hosts/host-connections'
import {
  conversationContext,
  implementationMode,
  implementPlanPrompt,
  revisePlanPrompt,
  DEFAULT_RUN_SETTINGS,
  type ConversationRun,
  type RunSettings,
} from './lib/ipc-context'
import { hostAgents } from './lib/host-agents'
import { queuedMessageAttachments, uploadedMessageAttachments } from './lib/message-attachments'
import { canRouteAuto, newSessionModel, rememberedFastMode, savedSessionModel, selectModel, supportedPermissionMode, supportsFastMode, type AgentCapabilities } from './lib/run-settings'
import { attachmentLimitProblem, composePrompt, uploadAttachment, type AttachmentIo, type PickedFile, type UploadedAttachment } from './lib/attachments'
import { hasHostCapability } from '@solus/client-core/host-capabilities'
import type { AgentPlanAwaiting } from './lib/agent-plans'
import { TranscriptModel, type TranscriptItem } from './lib/transcript-model'
import type { QueueAttachment, SessionQueueMutation, SessionQueueSnapshot } from '@solus/contracts/session-queue'
import { parseAgentAuthCommand } from '@solus/contracts/agent-auth'
import { AgentAuthFlow } from './agent-auth-flow'

/**
 * One open conversation on one host (plan 017 stage 3). It owns the watch,
 * the event subscription, and the transcript model; React reads the model
 * through `ConversationStore` slices.
 *
 * Order, as the desktop client does it (`session-bootstrap.ts`): durable
 * history first, then `watchSession` with `attachRuntime`, which replays the
 * turn in flight to this client alone. Events that arrive before history is in
 * memory are held and applied after it. A reconnect that did not recover the
 * server session rebuilds from a fresh history page and a fresh watch; a
 * recovered socket continues as it was. Prompts carry a client-made id from
 * the durable outbox, so a retry after an uncertain send is the same message.
 */

export type ConversationPhase =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

export interface ConversationTarget {
  hostId: string
  /** A saved session to open, or a new one to start in `workingDirectory`. */
  record?: Pick<SessionRecord, 'sessionId' | 'provider' | 'projectPath' | 'cwd' | 'model' | 'reasoningEffort' | 'title' | 'customTitle'>
  newSession?: { sessionId: string; provider: AgentId; workingDirectory: string }
}

export interface ConversationDeps {
  connection: HostConnection
  outbox: SendOutbox
  /** The person's run settings when the conversation opens. */
  runSettings(): Promise<RunSettings>
  /** The person's execution preferences now, sent with every call (plans/018 §6). */
  executionPreferences(): ExecutionPreferences
  /** Keeps a model's chosen options as the person's own for next time. */
  saveModelOptions?(provider: AgentId, model: string, options: ModelOptions): void
  /** The person's "name new sessions" setting; absent never names one. */
  autoRenameSessions?(): boolean
  organizationId(): string | null
  uuid(): string
  /** Reads and sends picked files; absent where attaching is not offered. */
  attachmentIo?: AttachmentIo
  onChange(changes: { items: string[]; order: boolean; meta: boolean }): void
}

/** The outbox queue of one conversation. Forgetting a host removes every
 *  queue under `conversationOutboxPrefix(hostId)`. */
export function conversationOutboxKey(hostId: string, sessionId: string): string {
  return `${hostId}/${sessionId}`
}

export function conversationOutboxPrefix(hostId: string): string {
  return `solus.sendOutbox.v1.${hostId}/`
}

export class ConversationController {
  model: TranscriptModel
  phase: ConversationPhase = { kind: 'loading' }
  run: ConversationRun
  loadingOlder = false
  /** Uploaded to the host, waiting for the next prompt. */
  attachments: readonly UploadedAttachment[] = []
  uploading = 0
  queue: SessionQueueSnapshot = { held: false, entries: [] }
  /** `/login`, `/design-login`, and `/mcp login|logout`, run here instead of by the agent. */
  readonly auth: AgentAuthFlow
  /** The host's agents, whether each is installed, and what each can do.
   *  Null until the host answers: unknown, not unavailable. */
  agents: readonly AgentMetadata[] | null = null
  /** The host reported no TypeSafe key, so Auto cannot route a first prompt. */
  autoNeedsKey = false
  /** Settles when the host has answered what its agents offer; history does not wait on it. */
  runOptionsLoaded: Promise<void> = Promise.resolve()
  /** True once the host knows the session; before that uploads name a draft. */
  private started: boolean
  private projectPath: string
  private settings: RunSettings | null = null
  /** Bumps on each (re)load; an answer for an older load is dropped. */
  private loadGeneration = 0
  private held: WireNormalizedEvent[] | null = null
  /** The prompt that started a new session, until the host names the session from it. */
  private openingPrompt: string | null = null
  private watching = false
  private closed = false
  private readonly cleanups: Array<() => void> = []

  constructor(readonly target: ConversationTarget, private readonly deps: ConversationDeps) {
    this.projectPath = target.record?.projectPath ?? ''
    this.run = initialRun(target, deps.organizationId(), deps.uuid)
    this.started = !!target.record
    this.model = new TranscriptModel(this.run.sessionId)
    const { connection } = deps
    this.auth = new AgentAuthFlow({ connection, notice: (text, tone) => {
      this.model.addNotice(text, tone)
      this.flush()
    } })
    this.cleanups.push(() => this.auth.close())
    this.cleanups.push(connection.events.subscribe('session.eventReceived', (payload) => {
      if (payload.sessionId === this.run.sessionId) this.receive(payload.event)
    }))
    this.cleanups.push(connection.events.subscribe('session.errorReceived', (payload) => {
      if (payload.sessionId !== this.run.sessionId) return
      this.model.addNotice(`Error: ${payload.error.message}`, 'error')
      this.flush()
    }))
    this.cleanups.push(connection.events.subscribe('session.statusChanged', (payload) => {
      if (payload.sessionId !== this.run.sessionId) return
      this.model.setStatus(payload.status)
      this.flush()
    }))
    // A session name set anywhere (generated here or on desktop, or typed) is
    // the session's: the header shows it, and a hand rename stops naming.
    this.cleanups.push(connection.events.subscribe('session.titleChanged', (payload) => {
      if (payload.sessionId !== this.run.sessionId && payload.sessionId !== this.run.agentSessionId) return
      this.run.title = payload.title
      this.openingPrompt = null
      this.flush(true)
    }))
    this.cleanups.push(connection.events.subscribe('config.changed', (snapshot) => {
      this.autoNeedsKey = snapshot.typeSafe?.source === null
      this.settleRun()
      this.flush(true)
    }))
    this.cleanups.push(connection.onReset(() => { void this.load() }))
    this.cleanups.push(connection.onAccepted(() => { void this.drainOutbox() }))
  }

  get hostId(): string {
    return this.target.hostId
  }

  /** Auto can pick this session's model: nothing has started it yet. */
  get canRoute(): boolean {
    return canRouteAuto({ started: this.started, agentSessionId: this.run.agentSessionId })
  }

  capabilitiesOf(provider: AgentId): AgentCapabilities {
    return this.agents?.find((agent) => agent.id === provider)?.capabilities
  }

  /** First load, and the rebuild after a reset. */
  async load(): Promise<void> {
    if (this.closed) return
    const generation = ++this.loadGeneration
    this.held = []
    this.watching = false
    this.setPhase({ kind: 'loading' })
    try {
      await this.applyRunSettingsOnce()
      this.runOptionsLoaded = this.loadRunOptions(generation)
      const model = await this.readHistory(generation)
      if (!model) return
      model.agentSessionId = this.run.agentSessionId
      // Prompts not yet confirmed stay visible across the rebuild.
      for (const record of this.deps.outbox.entriesFor(this.outboxKey)) {
        model.addOptimisticUser(record.clientPromptId, record.text, record.lastError ? 'failed' : 'queued', queuedMessageAttachments(record.payload))
        if (record.lastError) model.markDelivery(record.clientPromptId, 'failed', record.lastError)
      }
      this.model = model
      const held = this.held ?? []
      this.held = null
      for (const event of held) this.receive(event)

      const watched = await this.watch()
      if (generation !== this.loadGeneration) return
      this.applyWatch(watched)
      this.setPhase({ kind: 'ready' })
      this.flush(true)
      void this.drainOutbox()
    } catch (error) {
      if (generation !== this.loadGeneration) return
      this.held = null
      this.setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** The person's run settings, applied once: new work runs in their
   *  default mode and model, as on desktop; a live run's own settings replace
   *  them when the watch answers. */
  private async applyRunSettingsOnce(): Promise<void> {
    if (this.settings) return
    this.settings = await this.deps.runSettings()
    this.run.permissionMode = this.settings.defaultPermissionMode
    if (!this.target.record) Object.assign(this.run, newSessionModel(this.run.provider, this.settings))
    else this.run.fastMode = rememberedFastMode(this.run.provider, this.run.preferredModel, this.settings)
    this.settleRun()
  }

  /** What the host's agents offer, and whether Auto can route here. A host
   *  that cannot answer leaves every choice open, as the desktop does. */
  private async loadRunOptions(generation: number): Promise<void> {
    const [agents, config] = await Promise.all([
      hostAgents(this.deps.connection),
      this.canRoute ? this.deps.connection.api.configGet().catch(() => null) : null,
    ])
    if (generation !== this.loadGeneration || this.closed) return
    if (agents) this.agents = agents
    // An older host does not report the key; unknown is not missing, as on desktop.
    if (config) this.autoNeedsKey = config.typeSafe?.source === null
    this.settleRun()
    this.flush(true)
  }

  /**
   * Keeps the next run inside what the agent and host offer: a permission mode
   * the agent lacks, Auto on a host that cannot route, and fast mode on a model
   * without it each fall back. A started Auto run stays: the host chose it.
   */
  private settleRun(): void {
    const defaultMode = this.settings?.defaultPermissionMode ?? 'supervised'
    this.run.permissionMode = supportedPermissionMode(this.run.permissionMode, this.capabilitiesOf(this.run.provider), defaultMode)
    if (this.run.preferredModel === AUTO_MODEL_ID && this.canRoute && this.autoNeedsKey) {
      Object.assign(this.run, newSessionModel(this.run.provider, this.defaultsWithoutAuto(this.run.provider)))
    }
    if (!supportsFastMode(this.run.provider, this.run.preferredModel)) this.run.fastMode = false
  }

  /** The person's defaults with Auto left out for one agent. */
  private defaultsWithoutAuto(provider: AgentId): RunSettings | null {
    return this.settings?.defaultModels?.[provider] === AUTO_MODEL_ID
      ? { ...this.settings, defaultModels: { ...this.settings.defaultModels, [provider]: '' } } : this.settings
  }

  /** The first history page as a fresh model, or null when a newer load began.
   *  A new session has no history. */
  private async readHistory(generation: number): Promise<TranscriptModel | null> {
    if (!this.target.record) return new TranscriptModel(this.run.sessionId)
    const api = this.deps.connection.api
    const description = await api.describeSession(this.run.provider, this.target.record.sessionId).catch(() => null)
    if (generation !== this.loadGeneration) return null
    const lineage = description?.lineage
    if (lineage) {
      this.run.sessionId = lineage.sessionId
      this.run.agentSessionId = lineage.active.providerSessionId ?? null
      this.run.provider = lineage.active.provider
    }
    const page = await api.loadSessionPage({
      sessionId: this.run.sessionId,
      projectPath: this.projectPath || this.run.workingDirectory || undefined,
      provider: this.run.provider,
      turnLimit: INITIAL_HISTORY_TURNS,
    })
    return generation === this.loadGeneration ? TranscriptModel.fromHistory(this.run.sessionId, page) : null
  }

  async loadOlder(): Promise<void> {
    const cursor = this.model.olderCursor
    if (!cursor || this.loadingOlder || this.phase.kind !== 'ready') return
    const generation = this.loadGeneration
    const model = this.model
    this.loadingOlder = true
    this.flush(true)
    try {
      const page = await this.deps.connection.api.loadSessionPage({
        sessionId: this.run.sessionId,
        projectPath: this.projectPath || this.run.workingDirectory || undefined,
        provider: this.run.provider,
        turnLimit: OLDER_HISTORY_TURNS,
        before: cursor,
      })
      if (generation === this.loadGeneration && model === this.model) model.prependHistory(page)
    } catch {
      // The reader can scroll up again; a failed older page changes nothing shown.
    } finally {
      this.loadingOlder = false
      this.flush(true)
    }
  }

  /** Sends one prompt. Its id is made once and kept in the outbox until the
   *  host confirms it, so any retry is the same message to the host. While a
   *  turn runs, `delivery` chooses queue or steer; a waiting queue always queues.
   *  A sign-in command never reaches the agent: it runs here. */
  async send(text: string, options: { permissionMode?: PermissionMode; delivery?: 'queue' | 'steer' } = {}): Promise<void> {
    const prompt = text.trim()
    const authCommand = parseAgentAuthCommand(prompt, this.run.provider)
    if (authCommand) return this.auth.run(authCommand, this.run.workingDirectory)
    const attachments = this.attachments
    if (!prompt && attachments.length === 0) return
    const clientPromptId = this.deps.uuid()
    const busy = isSessionBusyStatus(this.model.status)
    if (options.permissionMode) this.run.permissionMode = options.permissionMode
    this.attachments = []
    if (!this.started && !this.run.agentSessionId && prompt && this.openingPrompt === null) this.openingPrompt = prompt
    this.model.addOptimisticUser(clientPromptId, prompt, 'sending', uploadedMessageAttachments(attachments))
    if (!busy && !this.queue.entries.length && !this.queue.held) this.model.setStatus('connecting')
    this.flush(true)
    const hostReadsImageRefs = attachments.some((attachment) => attachment.kind === 'image')
      && hasHostCapability(await this.deps.connection.supervisor.whenCapabilities(), 'promptImageRefs')
    const composed = composePrompt(prompt, attachments, hostReadsImageRefs)
    this.deps.outbox.enqueue(this.outboxKey, {
      clientPromptId,
      sessionId: this.run.sessionId,
      text: prompt,
      enqueuedAt: Date.now(),
      payload: { ...composed, displayPrompt: prompt, delivery: this.queue.entries.length ? 'queue' : busy ? options.delivery ?? 'steer' : undefined,
        queueAttachments: attachments.map((attachment) => ({ id: attachment.id, type: attachment.kind, name: attachment.name,
          hostPath: attachment.hostPath, mimeType: attachment.mimeType, size: attachment.size })),
        queueAttachmentContext: attachments.filter((attachment) => attachment.kind === 'file').map((attachment) => `[Attached file: ${attachment.hostPath}]`).join('\n'),
      },
    })
    await this.drainOutbox(true)
  }

  /** Uploads picked files to the host now, so the prompt can name them. */
  async attach(files: readonly PickedFile[]): Promise<void> {
    const io = this.deps.attachmentIo
    if (!io || files.length === 0) return
    const problem = attachmentLimitProblem(files, this.attachments.length + this.uploading)
    if (problem) {
      this.model.addNotice(problem, 'error')
      this.flush()
      return
    }
    this.uploading += files.length
    this.flush(true)
    for (const file of files) {
      try {
        const uploaded = await uploadAttachment(file, {
          api: this.deps.connection.api,
          ctx: this.uploadContext(),
          serverUrl: this.deps.connection.transport.serverUrl,
          io,
          uuid: this.deps.uuid,
        })
        if (!this.closed) this.attachments = [...this.attachments, uploaded]
      } catch (error) {
        this.model.addNotice(`${file.name} was not attached: ${error instanceof Error ? error.message : String(error)}`, 'error')
      } finally {
        this.uploading -= 1
        this.flush(true)
      }
    }
  }

  /** Takes an attachment off the next prompt. The host keeps the upload. */
  removeAttachment(id: string): void {
    this.attachments = this.attachments.filter((attachment) => attachment.id !== id)
    this.flush(true)
  }

  /** The `send` decision on a failed prompt: the same id goes again. */
  async retry(clientPromptId: string): Promise<void> {
    this.deps.outbox.retry(this.outboxKey, clientPromptId)
    this.model.markDelivery(clientPromptId, 'sending')
    this.flush()
    await this.drainOutbox(true)
  }

  /** The `remove` decision on a failed or waiting prompt. */
  discard(clientPromptId: string): void {
    this.deps.outbox.remove(this.outboxKey, clientPromptId)
    this.model.markDelivery(clientPromptId, 'failed', 'Not sent.')
    this.flush()
  }

  /**
   * The run settings for the next prompt. The current turn keeps its options.
   */
  updateRun(change: { model?: string; reasoningEffort?: ReasoningEffort; permissionMode?: PermissionMode; fastMode?: boolean }): boolean {
    if (change.model !== undefined) Object.assign(this.run, selectModel(this.run.provider, change.model, this.settings))
    if (change.reasoningEffort !== undefined) this.run.reasoningEffort = change.reasoningEffort
    if (change.permissionMode !== undefined) this.run.permissionMode = change.permissionMode
    if (change.fastMode !== undefined) this.run.fastMode = change.fastMode
    this.settleRun()
    if (change.model !== undefined || change.reasoningEffort !== undefined || change.fastMode !== undefined) this.rememberModelOptions()
    this.flush(true)
    return true
  }

  private rememberModelOptions(): void {
    const provider = this.run.provider
    const model = this.run.preferredModel
    if (!this.settings || !model || model === 'auto') return
    const options = { reasoningEffort: this.run.reasoningEffort, contextWindow: this.run.contextWindow, fastMode: this.run.fastMode }
    this.settings.modelOptionsByProvider ??= {}
    this.settings.modelOptionsByProvider[provider] = { ...this.settings.modelOptionsByProvider[provider], [model]: options }
    this.deps.saveModelOptions?.(provider, model, options)
  }

  async changeQueue(mutation: SessionQueueMutation): Promise<void> {
    await this.deps.connection.api.sessionQueueChange(this.context(), mutation)
  }

  async refreshQueue(): Promise<void> {
    const queue = this.queue
    const snapshot = await this.deps.connection.api.sessionQueue(this.context())
    if (this.queue !== queue || this.closed) return
    this.queue = snapshot
    this.flush(true)
  }

  async switchProvider(provider: 'claude-code' | 'codex'): Promise<void> {
    if (provider === this.run.provider && !this.queue.entries.some((entry) => entry.kind === 'provider_switch')) return
    const choice = newSessionModel(provider, this.defaultsWithoutAuto(provider))
    if (!this.started) {
      this.run.provider = provider
      Object.assign(this.run, choice)
      this.settleRun()
      this.flush(true)
      return
    }
    await this.changeQueue({ kind: 'switch', provider, modelConfig: {
      modelId: choice.preferredModel, reasoningEffort: choice.reasoningEffort, contextWindow: choice.contextWindow, fastMode: false,
    } })
  }

  async uploadQueueFiles(files: readonly PickedFile[]): Promise<QueueAttachment[]> {
    const io = this.deps.attachmentIo
    if (!io) throw new Error('File uploads are unavailable.')
    const problem = attachmentLimitProblem(files, 0)
    if (problem) throw new Error(problem)
    const result: QueueAttachment[] = []
    for (const file of files) {
      const attachment = await uploadAttachment(file, { api: this.deps.connection.api, ctx: this.uploadContext(),
        serverUrl: this.deps.connection.transport.serverUrl, io, uuid: this.deps.uuid })
      result.push({ id: attachment.id, type: attachment.kind, name: attachment.name, hostPath: attachment.hostPath,
        mimeType: attachment.mimeType, size: attachment.size })
    }
    return result
  }

  async stop(): Promise<void> {
    this.model.setStatus('interrupted')
    this.flush()
    try {
      await this.deps.connection.api.stopSession(this.run.sessionId)
    } catch (error) {
      this.model.addNotice(`Could not stop: ${(error instanceof Error ? error.message : String(error))}`, 'error')
      this.flush()
    }
  }

  async answerPermission(questionId: string, optionId: string): Promise<boolean> {
    const accepted = await this.callWithContext((ctx) =>
      this.answerOrExpire(questionId, this.deps.connection.api.respondPermission(ctx, this.run.sessionId, questionId, optionId)))
    return this.afterAnswer(accepted)
  }

  async answerQuestion(questionId: string, answers: Record<string, string>): Promise<boolean> {
    const accepted = await this.callWithContext((ctx) =>
      this.answerOrExpire(questionId, this.deps.connection.api.respondQuestion(ctx, this.run.sessionId, questionId, answers)))
    return this.afterAnswer(accepted)
  }

  /** The host no longer holds the request: its card closes and says why. */
  private async answerOrExpire(questionId: string, answer: Promise<boolean>): Promise<boolean | null> {
    try {
      return await answer
    } catch (error) {
      if (!(error instanceof Error) || rpcErrorCode(error) !== REQUEST_NOT_ANSWERABLE_CODE) throw error
      this.model.expireRequest(questionId, 'closed')
      this.model.addNotice(requestExpiryText('closed'), 'info')
      this.flush()
      return null
    }
  }

  /**
   * Approves this session's plan the way the desktop does: the host stops the
   * planning run, starts a fresh provider thread, and records the decision;
   * then the implementation prompt is sent. The card shows accepted only after
   * the host agreed.
   */
  async approvePlan(plan: Extract<TranscriptItem, { kind: 'plan' }>, note = ''): Promise<boolean> {
    const settings = this.settings ?? await this.deps.runSettings()
    const agentSessionId = this.run.agentSessionId ?? this.run.sessionId
    try {
      await this.deps.connection.api.acceptPlan(this.context(), { planId: plan.planId, startNewSession: true })
    } catch (error) {
      this.model.addNotice(`The plan was not approved: ${(error instanceof Error ? error.message : String(error))}`, 'error')
      this.flush()
      return false
    }
    this.model.setPlanDecision(plan.planId, 'accepted')
    this.model.setStatus('idle')
    this.run.agentSessionId = null
    this.model.agentSessionId = null
    this.flush()
    await this.send(implementPlanPrompt({ ...plan, agentSessionId }, note), { permissionMode: implementationMode(settings.defaultPermissionMode) })
    return true
  }

  /** Request changes: a live run is answered with its deny option so the note
   *  steers into the same turn; otherwise the finished run is stopped. */
  async requestPlanChanges(plan: Extract<TranscriptItem, { kind: 'plan' }>, comment: string): Promise<boolean> {
    const status = this.model.status
    const live = !!plan.questionId && plan.options.length > 0
      && (status === 'running' || status === 'awaiting_plan' || status === 'awaiting_input')
    try {
      if (live && plan.questionId) {
        const deny = plan.options.find((option) => option.kind === 'deny') ?? plan.options[plan.options.length - 1]
        // A plan whose run already ended is not held any more; the revise note still goes.
        if (deny) await this.deps.connection.api.respondPermission(this.context(), this.run.sessionId, plan.questionId, deny.id).catch((error) => {
          if (!(error instanceof Error) || rpcErrorCode(error) !== REQUEST_NOT_ANSWERABLE_CODE) throw error
        })
      } else {
        await this.deps.connection.api.stopSession(this.run.sessionId)
      }
    } catch (error) {
      this.model.addNotice(`The plan decision was not sent: ${(error instanceof Error ? error.message : String(error))}`, 'error')
      this.flush()
      return false
    }
    this.model.setPlanDecision(plan.planId, 'rejected')
    this.flush()
    if (comment.trim()) await this.send(revisePlanPrompt(comment), { permissionMode: 'plan' })
    return true
  }

  /**
   * Decides a plan written by a session this one sent work to. The host
   * approves or asks for changes on that session itself; this session sends
   * nothing. A refusal means the plan no longer waits (decided elsewhere).
   */
  async decideAgentPlan(plan: AgentPlanAwaiting, decision: 'approve' | 'request_changes', comment = ''): Promise<boolean> {
    const accepted = await this.callWithContext((ctx) => this.deps.connection.api.decideSessionPlan(
      ctx, plan.targetSessionId, decision, decision === 'request_changes' ? comment.trim() : undefined))
    if (accepted) this.model.agentPlans.markDecided(plan.targetSessionId, plan.messageId)
    else if (accepted === false) this.model.addNotice('This plan is no longer waiting on a decision.', 'info')
    this.flush(true)
    return accepted === true
  }

  /** Answer the offer to move this session into the agent's worktree. The
   *  card shows the host's answer; a refusal leaves a notice. */
  async decideWorktreeOffer(offerId: string, decision: 'switch' | 'keep'): Promise<void> {
    const resolution = await this.callWithContext((ctx) => this.deps.connection.api.decideWorktreeOffer(ctx, offerId, decision))
    if (resolution) this.model.setWorktreeOfferResolution(offerId, resolution)
    this.flush()
  }

  async rateLimitDecision(action: 'send_now' | 'stop' | 'wait'): Promise<void> {
    await this.callWithContext((ctx) => this.deps.connection.api.rateLimitDecision(ctx, action))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.loadGeneration += 1
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    if (this.watching) void this.deps.connection.api.unwatchSession(this.run.sessionId).catch(() => undefined)
  }

  // ─── Internals ───

  private receive(event: WireNormalizedEvent): void {
    if (this.held) {
      this.held.push(event)
      return
    }
    if (event.type === 'session_init') {
      this.run.agentSessionId = event.sessionId
      void this.nameSession(event.sessionId)
    }
    // The provider changed its own mode (Claude leaving plan mode): the next prompt keeps it.
    if (event.type === 'permission_mode_changed') this.run.permissionMode = event.permissionMode
    if (event.type === 'session_queue') {
      this.queue = { held: event.held, entries: event.entries }
      this.model.setQueued(event.entries.filter((entry) => entry.kind !== 'provider_switch'))
    }
    if (event.type === 'provider_switch_applied') {
      this.run.provider = event.provider
      this.run.preferredModel = event.modelConfig.modelId
      this.run.reasoningEffort = event.modelConfig.reasoningEffort
      this.run.contextWindow = event.modelConfig.contextWindow
      if (event.result) this.run.agentSessionId = event.result.restoredSessionId ?? null
    }
    this.model.apply(event)
    this.run.status = this.model.status
    this.flush(event.type === 'session_queue' || event.type === 'provider_switch_applied')
  }

  private async watch(): Promise<WatchSessionResult> {
    const watched = await this.deps.connection.api.watchSession({
      sessionId: this.run.sessionId,
      agentSessionId: this.run.agentSessionId ?? undefined,
      provider: this.run.provider,
      attachRuntime: !!this.run.agentSessionId,
    })
    this.watching = true
    return watched
  }

  private applyWatch(watched: WatchSessionResult): void {
    // The host is authoritative on identity: another client may know this
    // provider thread under the id it answered with.
    if (watched.sessionId !== this.run.sessionId) this.run.sessionId = watched.sessionId
    for (const question of watched.pendingQuestions ?? []) {
      this.model.apply({ type: 'question_request', questionId: question.questionId, questions: question.questions, responseMode: question.responseMode })
    }
    const runtime = watched.runtime
    if (runtime) {
      this.model.setStatus(runtime.status)
      this.model.setRateLimit(runtime.rateLimitInfo)
      this.queue = { held: runtime.queuedPrompts.some((entry) => entry.held), entries: runtime.queuedPrompts }
      this.model.setQueued(runtime.queuedPrompts.map((queued) => ({ queueId: queued.queueId, text: queued.text, clientPromptId: queued.clientPromptId })))
      if (runtime.modelConfig) {
        this.run.preferredModel = runtime.modelConfig.modelId
        this.run.reasoningEffort = runtime.modelConfig.reasoningEffort
        this.run.contextWindow = runtime.modelConfig.contextWindow ?? this.run.contextWindow
        this.run.fastMode = runtime.modelConfig.fastMode
      }
      if (runtime.permissionMode) this.run.permissionMode = runtime.permissionMode
    } else if (this.run.agentSessionId) {
      // Nothing runs for the session any more.
      this.model.setStatus('idle')
      this.model.setRateLimit(null)
    }
    this.run.status = this.model.status
  }

  /** Where this conversation's unconfirmed prompts wait: one queue per host
   *  and session, so another session's refused prompt never holds this one. */
  private get outboxKey(): string {
    return conversationOutboxKey(this.hostId, this.target.record?.sessionId ?? this.target.newSession?.sessionId ?? this.model.sessionId)
  }

  /**
   * Delivers queued prompts in order through the outbox's own rule: a send the
   * transport lost stays queued for the next connection; a send the host
   * refused is parked with its error for the person to send again or remove.
   */
  private async drainOutbox(force = false): Promise<void> {
    if (this.phase.kind !== 'ready' && !force) return
    if (this.closed) return
    let rounds = 0
    do {
      rounds += 1
      await this.deps.outbox.drain(this.outboxKey, async (record) => {
        this.model.markDelivery(record.clientPromptId, 'sending')
        this.flush()
        if (!this.watching) this.applyWatch(await this.watch())
        const result = await this.deps.connection.api.prompt(this.context(), {
          prompt: record.payload?.prompt ?? record.text,
          displayPrompt: record.payload?.displayPrompt ?? record.text,
          clientPromptId: record.clientPromptId,
          delivery: record.payload?.delivery === 'steer' || record.payload?.delivery === 'queue' ? record.payload.delivery : undefined,
          imageAttachments: record.payload?.imageAttachments,
          imageAttachmentRefs: record.payload?.imageAttachmentRefs,
          queueAttachments: record.payload?.queueAttachments,
          queueAttachmentContext: record.payload?.queueAttachmentContext,
        })
        this.started = true
        this.model.markDelivery(record.clientPromptId, result.disposition === 'queued' ? 'queued' : 'sent')
      })
      this.syncDeliveryFromOutbox()
      // A prompt enqueued while a drain ran was not in that drain's snapshot.
    } while (rounds < 5 && this.deps.outbox.entriesFor(this.outboxKey).some((entry) => entry.attempts === 0 && entry.lastError === null))
    this.flush()
  }

  private syncDeliveryFromOutbox(): void {
    for (const entry of this.deps.outbox.entriesFor(this.outboxKey)) {
      if (entry.lastError) {
        this.model.markDelivery(entry.clientPromptId, 'failed', entry.lastError)
        if (this.model.status === 'connecting') this.model.setStatus('idle')
      } else if (entry.attempts > 0) {
        this.model.markDelivery(entry.clientPromptId, 'queued')
      }
    }
  }

  private async callWithContext<T>(call: (ctx: ReturnType<typeof conversationContext>) => Promise<T>): Promise<T | null> {
    try {
      return await call(this.context())
    } catch (error) {
      this.model.addNotice(`The host refused the answer: ${(error instanceof Error ? error.message : String(error))}`, 'error')
      this.flush()
      return null
    }
  }

  private afterAnswer(accepted: boolean | null): boolean {
    if (accepted === false) {
      // This client may not answer: it only watches the session.
      this.model.addNotice("You can't answer this request.", 'info')
      this.flush()
    }
    return accepted === true
  }

  /** Uploads are stored per conversation. Before the host has the session,
   *  the conversation is a draft named by the id the session will have. */
  private uploadContext() {
    const ctx = this.context()
    if (this.started) return ctx
    return { ...ctx, session: { ...ctx.session, draftId: ctx.session.sessionId, sessionId: '' } }
  }

  private context() {
    this.run.status = this.model.status
    this.run.organizationId = this.deps.organizationId()
    return conversationContext(this.run, this.settings ?? DEFAULT_RUN_SETTINGS, this.deps.executionPreferences())
  }

  private setPhase(phase: ConversationPhase): void {
    this.phase = phase
    this.deps.onChange({ items: [], order: false, meta: true })
  }

  /**
   * Names a session this device started from its opening prompt, as desktop
   * does (`session-metadata.svelte.ts`): the host writes the name, and the
   * session's provider id must exist to hang it on. Once only, and never over
   * a name the session already has. Silent on failure: the prompt-derived
   * title stays.
   */
  private async nameSession(agentSessionId: string): Promise<void> {
    const prompt = this.openingPrompt
    this.openingPrompt = null
    if (!prompt || this.run.title || !this.deps.autoRenameSessions?.()) return
    const { api } = this.deps.connection
    const metadata = await api.generateSessionMetadata(prompt, this.run.workingDirectory, {
      sessionId: agentSessionId,
      executionPreferences: this.deps.executionPreferences(),
    }).catch(() => null)
    // Renamed by hand, or resumed into another provider thread, meanwhile.
    if (!metadata || this.run.title || this.run.agentSessionId !== agentSessionId) return
    this.run.title = metadata.title
    this.flush(true)
    await api.setSessionTitle(agentSessionId, metadata.title, 'generated', metadata.description).catch(() => undefined)
  }

  private flush(meta = false): void {
    const changes = this.model.takeChanges()
    if (meta) changes.meta = true
    if (changes.items.length || changes.order || changes.meta) this.deps.onChange(changes)
  }
}

function initialRun(target: ConversationTarget, organizationId: string | null, uuid: () => string): ConversationRun {
  const { record, newSession } = target
  const common = { status: 'idle' as const, permissionMode: 'supervised' as const, organizationId }
  if (record) {
    return {
      ...common,
      sessionId: record.sessionId,
      // A saved record names its provider thread; the watch may answer with
      // the Solus id another client already knows it by.
      agentSessionId: record.sessionId,
      provider: record.provider,
      workingDirectory: record.cwd ?? record.projectPath,
      ...savedSessionModel(record.provider, record.model, record.reasoningEffort),
      title: record.customTitle ?? record.title,
    }
  }
  return {
    ...common,
    sessionId: newSession?.sessionId ?? uuid(),
    agentSessionId: null,
    provider: newSession?.provider ?? 'claude-code',
    workingDirectory: newSession?.workingDirectory ?? '',
    preferredModel: null,
    reasoningEffort: 'high',
    contextWindow: null,
    fastMode: false,
    title: null,
  }
}
