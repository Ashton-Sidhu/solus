import { agentForProject } from '@solus/contracts/provider-instance-models'
import type { SendOutbox } from '@solus/client-core/send-outbox'
import { INITIAL_HISTORY_TURNS, OLDER_HISTORY_TURNS } from '@solus/client-core/session-history-page'
import type { AgentId, AgentMetadata, PermissionMode, ReasoningEffort, SessionStarterFromHost, SessionRecord, SessionStatus, WatchSessionResult, WireNormalizedEvent } from '@solus/contracts/types'
import { hostStarterOf } from '@solus/contracts/session-starter'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import type { ExecutionPreferences } from '@solus/contracts/settings'
import type { ModelOptions } from '@solus/contracts/settings'
import { isSessionBusyStatus, replaceModelProfiles, REQUEST_NOT_ANSWERABLE_CODE, requestExpiryText } from '@solus/contracts/types'
import { rpcErrorCode } from '@solus/client-core/rpc-error'
import type { WorkPolicy } from '@solus/contracts/host-policies'
import { isPermissionModeAbove, isPolicyRefusalCode, type PolicyRefusalCode } from '@solus/contracts/policy'
import { resourceAllows } from '@solus/contracts/permissions'
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
import type { ClipboardAttachmentRef } from '@solus/client-core/attachment-clipboard'
import { MAX_ATTACHMENT_UPLOAD_COUNT } from '@solus/contracts/rpc'
import { referencedAttachments, refsOnHost } from './lib/pasted-attachments'
import type { AgentPlanAwaiting } from './lib/agent-plans'
import { TranscriptModel, type TranscriptItem } from './lib/transcript-model'
import { isHandoffPending } from './lib/provider-handoff'
import type { QueueAttachment, SessionQueueMutation, SessionQueueSnapshot } from '@solus/contracts/session-queue'
import { parseAgentAuthCommand } from '@solus/contracts/agent-auth'
import { mayWorkLocallyDuringSetup } from '@solus/contracts/setup-card'
import { seatProviderSchema } from '@solus/contracts/seats'
import { AgentAuthFlow } from './agent-auth-flow'
import type { Integration, IntegrationConnectNeeded, IntegrationCustomServerNeeded } from '@solus/contracts/integration-types'
import { Listeners } from '../../lib/listeners'
import { SessionSuggestionsFeed } from './session-suggestions'
import { loweredPermissionMode, workPolicy } from '../policy/lib/policy-view'

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
  /** `noAccess`: the host refused the reader, who has no role on the session
   *  (docs/plans/shared-with-you.md §4.5). */
  | { kind: 'error'; message: string; noAccess?: boolean }

export interface ConversationTarget {
  hostId: string
  /** A saved session to open, or a new one to start in `workingDirectory`.
   *  A record's `role` is the reader's, from the list (docs/plans/access-model.md §2.7). */
  record?: Pick<SessionRecord, 'sessionId' | 'provider' | 'projectPath' | 'cwd' | 'model' | 'reasoningEffort' | 'title' | 'customTitle' | 'role'> & Partial<Pick<SessionRecord, 'organizationId'>>
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

/** An upload in flight. `landed` is the host's copy, or null when it failed. */
interface InFlightUpload {
  readonly landed: Promise<UploadedAttachment | null>
}

export class ConversationController {
  model: TranscriptModel
  phase: ConversationPhase = { kind: 'loading' }
  run: ConversationRun
  loadingOlder = false
  /** The agent session on another host that started this one, from the host's description. */
  startedBy: SessionStarterFromHost | null = null
  /** Uploaded to the host, waiting for the next prompt. */
  attachments: readonly UploadedAttachment[] = []
  /** The text of a prompt that did not go because one of its uploads failed.
   *  The composer takes it back with `takeUnsentText`. */
  unsentText: string | null = null
  /** Uploads in flight that no prompt took yet. */
  private uploads: InFlightUpload[] = []
  /** The last prompt that waits for its uploads or for an earlier prompt. */
  private heldSend: Promise<void> | null = null
  queue: SessionQueueSnapshot = { held: false, entries: [] }
  /** The provider that owns the session's provider thread now; null before a
   *  prompt starts one. `run.provider` is the picked provider: the next prompt
   *  carries it, and the host hands off when the two differ (plans/021). */
  threadProvider: AgentId | null
  /** `/login`, `/design-login`, and `/mcp login|logout`, run here instead of by the agent. */
  readonly auth: AgentAuthFlow
  /** The integrations this session's turn needs the person's connection to (`integration.connectNeeded`), in the order asked. */
  connectNeeded: readonly IntegrationConnectNeeded[] = []
  /** A server that is not in the catalog, until the person adds its address (`integration.customServerNeeded`). */
  customServerNeeded: IntegrationCustomServerNeeded | null = null
  readonly connectNeededChanges = new Listeners()
  /** What guests suggested to this session, for whoever may prompt it to send or dismiss. */
  readonly suggestions: SessionSuggestionsFeed
  /** The host's agents, whether each is installed, and what each can do.
   *  Null until the host answers: unknown, not unavailable. */
  agents: readonly AgentMetadata[] | null = null
  private modelPicked = false
  /** The host reported no TypeSafe key for this person, so Auto cannot route a first prompt. */
  autoNeedsKey = false
  /** Prompts the host refused by policy (plans/030 §6.1), by client prompt id: the bubble offers the one fix. */
  private readonly policyRefusals = new Map<string, PolicyRefusalCode>()
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
  /** A watch sent beside a prompt, until its reply comes. */
  private watchBesidePrompt: Promise<void> | null = null
  /** Counts live events, so a watch reply knows if the stream moved past it. */
  private liveEvents = 0
  private closed = false
  private readonly cleanups: Array<() => void> = []
  /** Saved artifact reads in flight, per transcript: a rebuilt transcript reads again. */
  private readonly artifactReads = new WeakMap<TranscriptModel, Map<string, Promise<void>>>()

  /**
   * Read the HTML an `html_path` render saved: the work's body at the version
   * the receipt names, else its revision at that version. Never the work's
   * latest body. A reply for a transcript a reload replaced is dropped.
   */
  ensureArtifact(id: string): Promise<void> {
    const model = this.model
    const reads = this.artifactReads.get(model) ?? new Map<string, Promise<void>>()
    this.artifactReads.set(model, reads)
    const pending = reads.get(id)
    if (pending) return pending
    const item = model.items.get(id)
    if (item?.kind !== 'artifact' || item.html || !item.workId || !item.contentVersion) return Promise.resolve()
    const { workId, contentVersion } = item
    const isCurrent = () => !this.closed && this.model === model
    model.updateArtifact(id, { loading: true, error: undefined })
    this.flush()
    const read = (async () => {
      try {
        const html = await this.savedWorkBody(workId, contentVersion)
        if (!isCurrent()) return
        model.updateArtifact(id, html === null
          ? { loading: false, error: 'This artifact version is no longer available.' }
          : { html, loading: false, error: undefined })
      } catch {
        if (isCurrent()) model.updateArtifact(id, { loading: false, error: 'Could not load this artifact. Try again.' })
      } finally {
        reads.delete(id)
        if (isCurrent()) this.flush()
      }
    })()
    reads.set(id, read)
    return read
  }

  private async savedWorkBody(workId: string, contentVersion: number): Promise<string | null> {
    const api = this.deps.connection.api
    const work = await api.loadWork(workId)
    if (work?.contentVersion === contentVersion) return work.content
    const revisions = await api.loadWorkRevisions(workId)
    const revision = revisions.find((entry) => entry.sourceContentVersion === contentVersion)
    return revision ? (await api.loadWorkRevision(workId, revision.revisionId)).content : null
  }

  constructor(readonly target: ConversationTarget, private readonly deps: ConversationDeps) {
    this.projectPath = target.record?.projectPath ?? ''
    this.run = initialRun(target, deps.organizationId(), deps.uuid)
    this.started = !!target.record
    this.threadProvider = target.record?.provider ?? null
    this.model = new TranscriptModel(this.run.sessionId)
    const { connection } = deps
    this.auth = new AgentAuthFlow({ connection, notice: (text, tone) => {
      this.model.addNotice(text, tone)
      this.flush()
    } })
    this.cleanups.push(() => this.auth.close())
    this.suggestions = new SessionSuggestionsFeed(connection, () => this.run.sessionId, () => this.context())
    this.cleanups.push(() => this.suggestions.close())
    this.cleanups.push(connection.events.subscribe('session.eventReceived', (payload) => {
      if (payload.sessionId === this.run.sessionId) this.receive(payload.event)
    }))
    // One sheet lists every integration the turn asked for, as the group card
    // does on desktop and web; a repeated ask keeps its one row.
    this.cleanups.push(connection.events.subscribe('integration.connectNeeded', (payload) => {
      if (payload.sessionId !== this.run.sessionId) return
      const asked = this.connectNeeded.some((open) => open.integrationId === payload.integrationId)
      this.connectNeeded = asked
        ? this.connectNeeded.map((open) => (open.integrationId === payload.integrationId ? payload : open))
        : [...this.connectNeeded, payload]
      this.connectNeededChanges.notify()
    }))
    this.cleanups.push(connection.events.subscribe('integration.customServerNeeded', (payload) => {
      if (payload.sessionId !== this.run.sessionId) return
      this.customServerNeeded = payload
      this.connectNeededChanges.notify()
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
      if (payload.sessionId !== this.run.sessionId) return
      this.run.title = payload.title
      this.openingPrompt = null
      this.flush(true)
    }))
    // The event carries no person's key, so the person's own status is read again.
    this.cleanups.push(connection.facts.subscribe((key) => {
      if (key !== 'machine' || this.run.agentSessionId) return
      const info = connection.facts.value('machine')
      if (!info) return
      this.agents = info.agents.map((agent) => agentForProject(agent, this.projectPath || this.run.workingDirectory))
      if (!this.modelPicked) Object.assign(this.run, newSessionModel(this.run.provider, this.settings, this.agents.find((agent) => agent.id === this.run.provider)))
      this.settleRun()
      this.flush(true)
    }))
    // The policy follows `host.policyChanged`: work that has not started takes the new ceiling at once.
    connection.facts.ensure('policy')
    this.cleanups.push(connection.facts.subscribe((key) => {
      if (key !== 'policy') return
      if (!this.started) this.run.permissionMode = this.policy.clampMode(this.run.permissionMode)
      this.flush(true)
    }))
    this.cleanups.push(connection.events.subscribe('config.changed', () => {
      void this.loadKeyStatus()
    }))
    this.cleanups.push(connection.onReset(() => { void this.load() }))
    this.cleanups.push(connection.onAccepted(() => { void this.drainOutbox() }))
  }

  dismissConnectNeeded(): void {
    this.connectNeeded = []
    this.customServerNeeded = null
    this.connectNeededChanges.notify()
  }

  /** The address was added: its row goes on as that server's sign-in. */
  customServerAdded(integration: Pick<Integration, 'id' | 'name'>): void {
    const sessionId = this.customServerNeeded?.sessionId
    this.customServerNeeded = null
    if (sessionId && !this.connectNeeded.some((open) => open.integrationId === integration.id)) {
      this.connectNeeded = [...this.connectNeeded, { integrationId: integration.id, integrationName: integration.name, sessionId }]
    }
    this.connectNeededChanges.notify()
  }

  get hostId(): string {
    return this.target.hostId
  }

  /**
   * Whether the reader may drive this session: prompt it, stop it, and answer
   * its cards (docs/plans/access-model.md §2.7). A new session is the reader's own.
   */
  get mayDrive(): boolean {
    return resourceAllows({ role: this.target.record?.role }, 'drive.prompt')
  }

  /**
   * Whether the reader may answer the agent's cards: what it may run, its
   * questions, and its plans. Its own action, apart from prompting
   * (docs/plans/custom-roles.md §3).
   */
  get mayApprove(): boolean {
    return resourceAllows({ role: this.target.record?.role }, 'drive.approve')
  }

  /** Auto can pick this session's model: nothing has started it yet. */
  get canRoute(): boolean {
    return canRouteAuto({ started: this.started, agentSessionId: this.run.agentSessionId })
  }

  /** What governs this work on its host (plans/030 §7). A saved session keeps its record's organization; new work takes the device's. Nothing is locked until the host answers. */
  get policy(): WorkPolicy {
    return workPolicy(this.deps.connection.facts.value('policy'), this.target.record?.organizationId ?? this.run.organizationId)
  }

  /** The mode "Lower the mode" sets on a prompt the host refused for its mode; null when the refusal was another one. */
  lowerModeFor(clientPromptId: string): PermissionMode | null {
    return this.policyRefusals.get(clientPromptId) === 'PERMISSION_MODE_ABOVE_LIMIT' ? loweredPermissionMode(this.policy, this.run.permissionMode) : null
  }

  /** Lowers the mode to the policy's ceiling and sends the refused prompt again. */
  async lowerModeAndRetry(clientPromptId: string): Promise<void> {
    const mode = this.lowerModeFor(clientPromptId)
    if (!mode) return
    this.updateRun({ permissionMode: mode })
    await this.retry(clientPromptId)
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
      void this.deps.connection.api.setSessionReadState(this.run.sessionId, Date.now()).catch(() => undefined)
      // Every load, reconnects included: a change missed while away is read again.
      if (this.started) void this.suggestions.refresh()
      this.flush(true)
      void this.drainOutbox()
    } catch (error) {
      if (generation !== this.loadGeneration) return
      this.held = null
      if (error instanceof Error && rpcErrorCode(error) === 'FORBIDDEN') {
        this.setPhase({ kind: 'error', message: error.message, noAccess: true })
        return
      }
      this.setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** The person's run settings, applied once: new work runs in their
   *  default mode and model, as on desktop; a live run's own settings replace
   *  them when the watch answers. A saved session that recorded no model takes
   *  the default too, never Auto: Auto routes only a session's first prompt. */
  private async applyRunSettingsOnce(): Promise<void> {
    if (this.settings) return
    this.settings = await this.deps.runSettings()
    // New work starts at the default, lowered to the policy's ceiling; a locked default wins.
    this.run.permissionMode = this.started ? this.settings.defaultPermissionMode : this.policy.defaultMode(this.settings.defaultPermissionMode)
    if (!this.target.record) Object.assign(this.run, newSessionModel(this.run.provider, this.settings, this.agents?.find((agent) => agent.id === this.run.provider)))
    else if (!this.run.preferredModel) Object.assign(this.run, newSessionModel(this.run.provider, this.defaultsWithoutAuto(this.run.provider), this.agents?.find((agent) => agent.id === this.run.provider), false))
    else this.run.fastMode = rememberedFastMode(this.run.provider, this.run.preferredModel, this.settings)
    this.settleRun()
  }

  /**
   * The model picker opened: the host downloads the published model list if it
   * last asked more than five minutes ago (`docs/model-profiles.md`), so a
   * model released today shows. A host that found a new list sends
   * `host.modelProfilesChanged` before its answer, and the host's facts read
   * the agents again, so the picker gets the new models. An older host does
   * not know the check; the list in effect stays.
   */
  async checkForNewModels(): Promise<void> {
    const { connection } = this.deps
    const status = await connection.api.modelProfilesCheck().catch(() => null)
    if (!status || this.closed) return
    replaceModelProfiles(status.profiles)
    const agents = await hostAgents(connection)
    if (!agents || this.closed) return
    this.agents = agents.map((agent) => agentForProject(agent, this.projectPath || this.run.workingDirectory))
    this.flush(true)
  }

  /** What the host's agents offer, and whether Auto can route here. A host
   *  that cannot answer leaves every choice open, as the desktop does. */
  private async loadRunOptions(generation: number): Promise<void> {
    const [agents, typeSafe] = await Promise.all([
      hostAgents(this.deps.connection),
      this.canRoute ? this.deps.connection.api.typeSafeKeyStatus().catch(() => null) : null,
    ])
    if (generation !== this.loadGeneration || this.closed) return
    if (agents) {
      this.agents = agents.map((agent) => agentForProject(agent, this.projectPath || this.run.workingDirectory))
      if (!this.target.record && !this.modelPicked && !this.run.agentSessionId) Object.assign(this.run, newSessionModel(this.run.provider, this.settings, this.agents.find((agent) => agent.id === this.run.provider)))
    }
    // An older host does not report the key; unknown is not missing, as on desktop.
    if (typeSafe) this.autoNeedsKey = typeSafe.source === null
    this.settleRun()
    this.flush(true)
  }

  private async loadKeyStatus(): Promise<void> {
    const typeSafe = await this.deps.connection.api.typeSafeKeyStatus().catch(() => null)
    if (!typeSafe || this.closed) return
    this.autoNeedsKey = typeSafe.source === null
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
      Object.assign(this.run, newSessionModel(this.run.provider, this.defaultsWithoutAuto(this.run.provider), this.agents?.find((agent) => agent.id === this.run.provider), false))
    }
    if (!supportsFastMode(this.run.provider, this.run.preferredModel, this.agents?.find((agent) => agent.id === this.run.provider))) this.run.fastMode = false
  }

  /** The person's defaults with Auto left out for one agent. */
  private defaultsWithoutAuto(provider: AgentId): RunSettings | null {
    return this.settings?.defaultModels?.[provider] === AUTO_MODEL_ID
      ? { ...this.settings, defaultModels: { ...this.settings.defaultModels, [provider]: '' } } : this.settings
  }

  /** The first history page as a fresh model, or null when a newer load began.
   *  A session that no prompt started has no history. A new session that a
   *  prompt started has history, so a reset reads it again. */
  private async readHistory(generation: number): Promise<TranscriptModel | null> {
    if (!this.started) return new TranscriptModel(this.run.sessionId)
    const api = this.deps.connection.api
    const description = await api.describeSession(this.run.sessionId).catch(() => null)
    if (generation !== this.loadGeneration) return null
    this.startedBy = hostStarterOf(description?.meta?.startedBy)
    const lineage = description?.lineage
    if (lineage) {
      this.run.agentSessionId = lineage.active.providerSessionId ?? null
      this.followThread(lineage.active.provider)
    }
    const page = await api.loadSessionPage({ ...this.historySource, turnLimit: INITIAL_HISTORY_TURNS })
    if (generation !== this.loadGeneration) return null
    if (page.messages.at(-1)?.loginRefused) this.offerSignInAgain()
    return TranscriptModel.fromHistory(this.run.sessionId, page)
  }

  /** The provider refused the last turn's login, live or in loaded history: the sheet offers sign-in again. */
  private offerSignInAgain(): void {
    const provider = seatProviderSchema.safeParse(this.threadProvider ?? this.run.provider)
    if (provider.success) this.auth.noteLoginRefused(provider.data)
  }

  /** Where this conversation's history is read: its thread's provider, in its folder.
   *  A provider subagent's history is read through the same parent. */
  get historySource() {
    return {
      sessionId: this.run.sessionId,
      projectPath: this.projectPath || this.run.workingDirectory || undefined,
      provider: this.threadProvider ?? this.run.provider,
    }
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
        ...this.historySource,
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
    if (this.run.provider === 'codex' && /^\/compact(?:\s|$)/.test(prompt)) return this.compact(prompt)
    const authCommand = parseAgentAuthCommand(prompt, this.run.provider)
    if (authCommand) return this.auth.run(authCommand, this.run.workingDirectory)
    // The prompt takes the uploads still in flight: it shows now and goes when they land.
    const waiting = this.uploads
    const attachments = this.attachments
    if (!prompt && attachments.length === 0 && waiting.length === 0) return
    const clientPromptId = this.deps.uuid()
    const busy = isSessionBusyStatus(this.model.status)
    const statusBefore = this.model.status
    if (options.permissionMode) this.run.permissionMode = options.permissionMode
    this.attachments = []
    this.uploads = []
    if (!this.started && !this.run.agentSessionId && prompt && this.openingPrompt === null) this.openingPrompt = prompt
    this.model.addOptimisticUser(clientPromptId, prompt, 'sending', uploadedMessageAttachments(attachments))
    if (!busy && !this.queue.entries.length && !this.queue.held) this.model.setStatus('connecting')
    this.flush(true)
    // A later prompt waits behind one that waits, so the host gets them in order.
    const before = this.heldSend
    let release = () => {}
    if (waiting.length > 0 || before) {
      const held = new Promise<void>((resolve) => { release = resolve })
      this.heldSend = held
      void held.then(() => { if (this.heldSend === held) this.heldSend = null })
    }
    try {
      await before
      const ready = await this.landedAttachments(clientPromptId, prompt, attachments, waiting, statusBefore)
      if (!ready) return
      await this.enqueuePrompt(clientPromptId, prompt, ready, busy, options.delivery)
    } finally {
      release()
    }
    await this.drainOutbox(true)
  }

  /** The prompt's files once the uploads it took land, or null when it will
   *  not go. Then nothing reaches the host: the text and the files that did
   *  land go back to the composer, and a notice says why. */
  private async landedAttachments(
    clientPromptId: string,
    prompt: string,
    attachments: readonly UploadedAttachment[],
    waiting: readonly InFlightUpload[],
    statusBefore: SessionStatus,
  ): Promise<readonly UploadedAttachment[] | null> {
    if (waiting.length === 0) return attachments
    const landed = await Promise.all(waiting.map((upload) => upload.landed))
    const uploaded = landed.filter((attachment): attachment is UploadedAttachment => attachment !== null)
    const all = [...attachments, ...uploaded]
    if (this.closed) return null
    if (uploaded.length < landed.length) {
      this.model.dropOptimisticUser(clientPromptId)
      if (this.openingPrompt === prompt) this.openingPrompt = null
      if (this.model.status === 'connecting') this.model.setStatus(statusBefore)
      this.attachments = [...all, ...this.attachments]
      this.unsentText = prompt
      this.model.addNotice('The message was not sent because an attachment did not upload.', 'error')
      this.flush(true)
      return null
    }
    this.model.setOptimisticAttachments(clientPromptId, uploadedMessageAttachments(all))
    this.flush(true)
    return all
  }

  private async enqueuePrompt(
    clientPromptId: string,
    prompt: string,
    attachments: readonly UploadedAttachment[],
    busy: boolean,
    delivery: 'queue' | 'steer' | undefined,
  ): Promise<void> {
    const hostReadsImageRefs = attachments.some((attachment) => attachment.kind === 'image')
      && hasHostCapability(await this.deps.connection.facts.when('capabilities'), 'promptImageRefs')
    const composed = composePrompt(prompt, attachments, hostReadsImageRefs)
    this.deps.outbox.enqueue(this.outboxKey, {
      clientPromptId,
      sessionId: this.run.sessionId,
      text: prompt,
      enqueuedAt: Date.now(),
      payload: { ...composed, displayPrompt: prompt, delivery: this.queue.entries.length ? 'queue' : busy ? delivery ?? 'steer' : undefined,
        queueAttachments: attachments.map((attachment) => ({ id: attachment.id, type: attachment.kind, name: attachment.name,
          hostPath: attachment.hostPath, mimeType: attachment.mimeType, size: attachment.size })),
        queueAttachmentContext: attachments.filter((attachment) => attachment.kind === 'file').map((attachment) => `[Attached file: ${attachment.hostPath}]`).join('\n'),
      },
    })
  }

  /** Runs the host command and leaves refused requests visible in the transcript. */
  private async compact(prompt: string): Promise<void> {
    try {
      if (prompt !== '/compact') this.model.addNotice('Use /compact without arguments.', 'info')
      else if (!this.run.agentSessionId) this.model.addNotice('Send a first message before you compact this session.', 'info')
      else await this.deps.connection.api.compactSession(this.context())
    } catch (error) {
      this.model.addNotice(`Could not compact this session: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
    this.flush()
  }

  /** Uploads not yet taken by a prompt. */
  get uploading(): number {
    return this.uploads.length
  }

  /** The composer takes back the text of a prompt that did not go. */
  takeUnsentText(): string | null {
    const text = this.unsentText
    this.unsentText = null
    this.flush(true)
    return text
  }

  /** Uploads picked files to the host now, so the prompt can name them. A
   *  prompt sent before they land takes them and waits for them. */
  async attach(files: readonly PickedFile[]): Promise<void> {
    const io = this.deps.attachmentIo
    if (!io || files.length === 0) return
    const problem = attachmentLimitProblem(files, this.attachments.length + this.uploading)
    if (problem) {
      this.model.addNotice(problem, 'error')
      this.flush()
      return
    }
    let previous: Promise<unknown> = Promise.resolve()
    const uploads = files.map((file) => {
      const landed = previous.then(() => this.uploadOne(file, io, upload))
      const upload: InFlightUpload = { landed }
      previous = landed
      return upload
    })
    this.uploads = [...this.uploads, ...uploads]
    this.flush(true)
    await previous
  }

  /** One upload, in order. It joins the composer's attachments unless a sent
   *  prompt took it; then that prompt gets it from `landed`. */
  private async uploadOne(file: PickedFile, io: AttachmentIo, upload: InFlightUpload): Promise<UploadedAttachment | null> {
    try {
      const uploaded = await uploadAttachment(file, {
        api: this.deps.connection.api,
        ctx: this.uploadContext(),
        serverUrl: this.deps.connection.transport.serverUrl,
        io,
        uuid: this.deps.uuid,
      })
      if (!this.closed && this.uploads.includes(upload)) this.attachments = [...this.attachments, uploaded]
      return uploaded
    } catch (error) {
      this.model.addNotice(`${file.name} was not attached: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return null
    } finally {
      this.uploads = this.uploads.filter((each) => each !== upload)
      this.flush(true)
    }
  }

  /**
   * Attaches files this session's host already holds, named by a copy made in
   * another Solus client. Nothing uploads. Answers false when they cannot join
   * the prompt this way, so the paste falls back to uploading its bytes.
   */
  async attachHostFiles(refs: readonly ClipboardAttachmentRef[]): Promise<boolean> {
    if (!refsOnHost(refs, this.hostId)) return false
    if (refs.length + this.attachments.length + this.uploading > MAX_ATTACHMENT_UPLOAD_COUNT) return false
    // An image without its bytes reaches the agent only as a ref the host reads.
    if (refs.some((ref) => ref.type === 'image')
      && !hasHostCapability(await this.deps.connection.facts.when('capabilities'), 'promptImageRefs')) return false
    if (this.closed) return false
    this.attachments = [...this.attachments, ...referencedAttachments(refs, this.deps.uuid)]
    this.flush(true)
    return true
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

  /** The host retains the failed prompt; a retry keeps its original branch.
   *  While the host still makes the worktree, working locally stops it and
   *  starts the same prompt in the project folder. */
  async recoverWorktreeSetup(id: string, workLocally: boolean): Promise<void> {
    const item = this.model.items.get(id)
    if (!this.mayDrive || item?.kind !== 'setup') return
    if (workLocally && mayWorkLocallyDuringSetup(item.card)) {
      try {
        await this.deps.connection.api.continueSetupLocally(this.run.sessionId)
      } catch (error) {
        this.model.addNotice(`Could not work locally: ${(error instanceof Error ? error.message : String(error))}`, 'error')
        this.flush()
      }
      return
    }
    if (item.card.status !== 'error' || item.card.recovery !== 'worktree') return
    await this.callWithContext((ctx) => {
      ctx.session.worktreeBaseBranch = workLocally ? null : item.card.worktreeBaseBranch ?? null
      return this.deps.connection.api.retry(ctx, { prompt: '' })
    })
  }

  /** The `remove` decision on a failed or waiting prompt. */
  discard(clientPromptId: string): void {
    this.policyRefusals.delete(clientPromptId)
    this.deps.outbox.remove(this.outboxKey, clientPromptId)
    this.model.markDelivery(clientPromptId, 'failed', 'Not sent.')
    this.flush()
  }

  /**
   * The run settings for the next prompt. The current turn keeps its options.
   */
  updateRun(change: { model?: string; reasoningEffort?: ReasoningEffort; permissionMode?: PermissionMode; fastMode?: boolean }): boolean {
    // The pickers disable what the policy refuses; the host refuses it too. Lowering is always allowed.
    if (change.permissionMode !== undefined && isPermissionModeAbove(change.permissionMode, this.policy.ceiling()?.value)) return false
    if (change.model !== undefined && change.model !== AUTO_MODEL_ID && this.policy.modelDenial(this.run.provider, change.model)) return false
    if (change.model !== undefined) this.modelPicked = true
    if (change.model !== undefined) Object.assign(this.run, selectModel(this.run.provider, change.model, this.settings, this.agents?.find((agent) => agent.id === this.run.provider)))
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

  /**
   * Picks the agent the next prompt runs on, with its default model. Only this
   * composer changes: the host hands the session off when that prompt arrives
   * (plans/021), so a pick back undoes nothing and a parked rate-limited
   * prompt and its card stay.
   */
  pickProvider(provider: Exclude<AgentId, 'opencode'>): void {
    if (provider === this.run.provider || this.policy.providerDenial(provider)) return
    this.run.provider = provider
    Object.assign(this.run, newSessionModel(provider, this.defaultsWithoutAuto(provider), this.agents?.find((agent) => agent.id === provider), false))
    this.settleRun()
    this.flush(true)
  }

  /** The host names the thread's provider (its lineage, a handoff from any
   *  client). A composer that had not picked another provider follows it, with
   *  the model the handoff named or that agent's default. */
  private followThread(provider: AgentId, model?: string): void {
    const follows = this.threadProvider === null || this.run.provider === this.threadProvider
    this.threadProvider = provider
    if (!follows || this.run.provider === provider) return
    this.run.provider = provider
    Object.assign(this.run, model ? selectModel(provider, model, this.settings, this.agents?.find((agent) => agent.id === provider)) : newSessionModel(provider, this.defaultsWithoutAuto(provider), this.agents?.find((agent) => agent.id === provider), false))
    this.settleRun()
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

  /** Ends only what the agent left running; its finished turn is untouched. */
  async stopBackgroundWork(): Promise<void> {
    try {
      if (await this.deps.connection.api.stopBackgroundTasks(this.run.sessionId)) return
      this.model.addNotice('The background task could not be stopped', 'error')
    } catch (error) {
      this.model.addNotice(`Could not stop: ${(error instanceof Error ? error.message : String(error))}`, 'error')
    }
    this.flush()
  }

  /** `feedback` goes with a denial to the agent that asked. */
  async answerPermission(questionId: string, optionId: string, feedback?: string): Promise<boolean> {
    const accepted = await this.callWithContext((ctx) =>
      this.answerOrExpire(questionId, this.deps.connection.api.respondPermission(ctx, this.run.sessionId, questionId, optionId, undefined, feedback)))
    return this.afterAnswer(accepted)
  }

  async answerQuestion(questionId: string, answers: Record<string, string>): Promise<boolean> {
    const accepted = await this.callWithContext((ctx) =>
      this.answerOrExpire(questionId, this.deps.connection.api.respondQuestion(ctx, this.run.sessionId, questionId, answers)))
    return this.afterAnswer(accepted)
  }

  /** Answers a `request_secret` card: one value per secret, null for each declined one. The values go only to the host. */
  async answerSecretRequest(questionId: string, values: (string | null)[]): Promise<boolean> {
    const accepted = await this.callWithContext(() =>
      this.answerOrExpire(questionId, this.deps.connection.api.secretRequestAnswer(this.run.sessionId, questionId, values)))
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
    const sessionId = this.run.sessionId
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
    this.flush()
    const mode = this.policy.clampMode(implementationMode(this.policy.defaultMode(settings.defaultPermissionMode)))
    await this.send(implementPlanPrompt({ ...plan, sessionId }, note), { permissionMode: mode })
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
    this.liveEvents += 1
    if (this.held) {
      this.held.push(event)
      return
    }
    if (event.type === 'session_init') {
      this.run.agentSessionId = event.sessionId
      void this.nameSession(event.sessionId)
    }
    if (event.type === 'error' && event.kind === 'auth') this.offerSignInAgain()
    // The provider changed its own mode (Claude leaving plan mode): the next prompt keeps it.
    if (event.type === 'permission_mode_changed') this.run.permissionMode = event.permissionMode
    if (event.type === 'session_queue') {
      this.queue = { held: event.held, entries: event.entries }
      this.model.setQueued(event.entries.filter((entry) => entry.kind !== 'provider_switch'))
    }
    // The host handed the thread to another provider when a prompt asked for it.
    if (event.type === 'activity' && event.activity.kind === 'agent_switched') this.followThread(event.activity.provider, event.activity.model)
    // An older host's queued switch ran (a client that still queues one).
    if (event.type === 'provider_switch_applied') {
      this.threadProvider = event.provider
      this.run.provider = event.provider
      this.run.preferredModel = event.modelConfig.modelId
      this.run.reasoningEffort = event.modelConfig.reasoningEffort
      this.run.contextWindow = event.modelConfig.contextWindow
      if (event.result) this.run.agentSessionId = event.result.restoredSessionId ?? null
    }
    this.model.apply(event)
    this.run.status = this.model.status
    this.flush(event.type === 'session_queue' || event.type === 'provider_switch_applied' || event.type === 'activity')
  }

  private async watch(): Promise<WatchSessionResult> {
    const watched = await this.deps.connection.api.watchSession({
      sessionId: this.run.sessionId,
      attachRuntime: !!this.run.agentSessionId,
    })
    this.watching = true
    return watched
  }

  /**
   * Watches without holding the prompt that goes next: the host makes the
   * sender a watcher before the prompt runs, as on desktop (`promptTab`). The
   * prompt carries the run settings this conversation has; the reply applies
   * when it comes. A reply for an older load is dropped, as in `load`, and so
   * is a reply that live events passed: they are newer than its snapshot. A
   * failed watch leaves `watching` false, so the next send tries again.
   */
  private watchBeside(): void {
    if (this.watchBesidePrompt) return
    const generation = this.loadGeneration
    const eventsAtSend = this.liveEvents
    this.watchBesidePrompt = this.watch().then((watched) => {
      if (generation !== this.loadGeneration || this.closed || this.liveEvents !== eventsAtSend) return
      this.applyWatch(watched)
      this.flush(true)
    }, () => undefined).finally(() => { this.watchBesidePrompt = null })
  }

  private applyWatch(watched: WatchSessionResult): void {
    for (const question of watched.pendingQuestions ?? []) {
      this.model.apply({ type: 'question_request', questionId: question.questionId, questions: question.questions, responseMode: question.responseMode, kind: question.kind })
    }
    const runtime = watched.runtime
    if (runtime) {
      this.model.setStatus(runtime.status)
      this.model.setRateLimit(runtime.rateLimitInfo)
      this.model.setBackgroundWorkRunning(!!runtime.backgroundWorkRunning)
      this.queue = { held: runtime.queuedPrompts.some((entry) => entry.held), entries: runtime.queuedPrompts }
      this.model.setQueued(runtime.queuedPrompts.map((queued) => ({ queueId: queued.queueId, text: queued.text, clientPromptId: queued.clientPromptId })))
      // A pick waiting for a send keeps its own model.
      if (runtime.modelConfig && !isHandoffPending(this.threadProvider, this.run.provider)) {
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
      this.model.setBackgroundWorkRunning(false)
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
        if (!this.watching) this.watchBeside()
        const ctx = this.context()
        this.policyRefusals.delete(record.clientPromptId)
        const result = await this.deps.connection.api.prompt(ctx, {
          prompt: record.payload?.prompt ?? record.text,
          displayPrompt: record.payload?.displayPrompt ?? record.text,
          clientPromptId: record.clientPromptId,
          delivery: record.payload?.delivery === 'steer' || record.payload?.delivery === 'queue' ? record.payload.delivery : undefined,
          imageAttachments: record.payload?.imageAttachments,
          imageAttachmentRefs: record.payload?.imageAttachmentRefs,
          queueAttachments: record.payload?.queueAttachments,
          queueAttachmentContext: record.payload?.queueAttachmentContext, isLead: this.run.lead && !this.started ? true : undefined,
        }).catch((error: unknown) => {
          // The bubble shows the host's words; a policy refusal also keeps its code for the one fix it offers.
          const code = error instanceof Error ? rpcErrorCode(error) : null
          if (code && isPolicyRefusalCode(code)) this.policyRefusals.set(record.clientPromptId, code)
          throw error
        })
        this.started = true
        // The first prompt starts the thread on the provider it carried.
        this.threadProvider ??= ctx.session.provider
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
    await api.setSessionTitle(this.run.sessionId, metadata.title, 'generated', metadata.description).catch(() => undefined)
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
