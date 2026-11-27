import { sessionExecutionStatus, type SessionExecution } from '@solus/contracts/session-execution'
import { clearActiveHistoryLoading } from "@t3tools/client-runtime/state/thread-history-merge"
import type { MobileSessionCache } from "../threads/session-cache"
import type { IssueSnapshot } from '@solus/contracts/task-types'
import { startsHistoryTurn, type SessionHistoryPage } from '@solus/contracts/session-history'
import type { SolusAPI } from '@solus/contracts/host-api'
import { agentForProject } from '@solus/contracts/provider-instance-models'
import type { SendOutbox } from '@solus/client-core/send-outbox'
import { sessionFeedHistoryOptions } from '@solus/contracts/session-feed-item'
import { INITIAL_HISTORY_TURNS, OLDER_HISTORY_TURNS, loadSessionHistoryPage, sameHistoryPage } from '@solus/client-core/session-history-page'
import type { AgentId, AgentMetadata, PermissionMode, ReasoningEffort, SessionDescription, SessionMeta, SessionStarterFromHost, SessionRecord, SessionStatus, StatusCardState, WatchSessionResult, GitCheckoutBranchResult, WireNormalizedEvent } from '@solus/contracts/types'
import { hostStarterOf } from '@solus/contracts/session-starter'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import type { BranchRef } from '@solus/contracts/git-types'
import { isChat } from '@solus/contracts/chat'
import type { ModelOptions } from '@solus/contracts/settings'
import { isSessionBusyStatus, replaceModelProfiles, REQUEST_NOT_ANSWERABLE_CODE, requestExpiryText } from '@solus/contracts/types'
import { isTaskFolderPath, type CodebaseMember, type SessionFolder } from '@solus/contracts/codebases'
import { rpcErrorCode, TransportDisconnectedError } from '@solus/client-core/rpc-error'
import type { WorkPolicy } from '@solus/contracts/host-policies'
import { isPermissionModeAbove, isPolicyRefusalCode, type PolicyRefusalCode } from '@solus/contracts/policy'
import { resourceAllows } from '@solus/contracts/permissions'
import type { HostConnection } from '../hosts/host-connections'
import {
  conversationContext,
  implementationMode,
  implementPlanPrompt,
  revisePlanPrompt,
  runProjectRoot,
  sessionFolderContext,
  type ConversationRun,
  type RunSettings,
} from './lib/ipc-context'
import { hostAgents } from './lib/host-agents'
import { attachmentKind } from '@solus/contracts/media-types'
import { queuedMessageAttachments, uploadedMessageAttachments, type MessageAttachment } from './lib/message-attachments'
import { canRouteAuto, newSessionModel, rememberedFastMode, savedSessionModel, selectModel, supportedPermissionMode, supportsFastMode, type AgentCapabilities } from './lib/run-settings'
import { attachmentSizeProblem, composePrompt, uploadAttachment, type AttachmentIo, type PickedFile, type UploadedAttachment } from './lib/attachments'
import { hasHostCapability } from '@solus/client-core/host-capabilities'
import type { ClipboardAttachmentRef } from '@solus/client-core/attachment-clipboard'
import { referencedAttachments, refsOnHost } from './lib/pasted-attachments'
import type { AgentPlanAwaiting } from './lib/agent-plans'
import { TranscriptModel, type TranscriptItem } from './lib/transcript-model'
import { OpenTiming, type OpenPaintSource } from './lib/open-timing'
import { LARGE_SESSION_BYTES } from '../threads/history-prefetch'
import { isHandoffPending } from './lib/provider-handoff'
import type { QueueAttachment, SessionQueueMutation, SessionQueueSnapshot } from '@solus/contracts/session-queue'
import { parseAgentAuthCommand } from '@solus/contracts/agent-auth'
import { mayWorkLocallyDuringSetup } from '@solus/contracts/setup-card'
import { seatProviderSchema } from '@solus/contracts/seats'
import { AgentAuthFlow } from './agent-auth-flow'
import { resourceAttachRequest, type AttachedIntegrationResource, type Integration, type IntegrationConnectNeeded, type IntegrationCustomServerNeeded } from '@solus/contracts/integration-types'
import { resourceAttachments } from './lib/resource-attachments'
import { Listeners } from '../../lib/listeners'
import { SessionSuggestionsFeed } from './session-suggestions'
import { McpTasksFeed, ResourceWatchesFeed } from './session-records-feed'
import { loweredPermissionMode, workPolicy } from '../policy/lib/policy-view'
import { isSessionSyncCard } from '@solus/client-core/session-sync-card'
import { SESSION_DIVERGED } from '@solus/contracts/session-repositories'
import type { SessionRunHosts } from '../threads/session-run-hosts'
import type { CloudHistory } from '../threads/cloud-history'
import type { SessionCloudReadStatus } from '@solus/client-core/session-cloud-read'

/**
 * One open conversation on one host (plan 017 stage 3). It owns the watch,
 * the event subscription, and the transcript model; React reads the model
 * through `ConversationStore` slices.
 *
 * Order (docs/plans/running-turn-open.md): one opening read watches the
 * session, replaying the turn in flight to this client alone, and then reads a
 * history page of the settled turns. Events that arrive before history is in
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
  record?: Pick<SessionRecord, 'sessionId' | 'provider' | 'projectPath' | 'cwd' | 'model' | 'reasoningEffort' | 'title' | 'customTitle' | 'role' | 'execution'> & Partial<Pick<SessionRecord, 'organizationId' | 'projectRoot' | 'codebaseId' | 'size'>>
  newSession?: { sessionId: string; provider: AgentId; workingDirectory: string; attachments?: readonly UploadedAttachment[] }
  /** The host this saved session was open on before the person chose this
   *  one to run its next turn (docs/plans/portable-sessions.md §10). */
  movedFrom?: string
  /** The transcript it showed there. It shows here until this host is current
   *  and reads its own history, so the conversation stays on screen while the
   *  host syncs. */
  carriedTranscript?: TranscriptModel
  /** Only the cloud listed the session (docs/plans/portable-sessions-cloud.md
   *  §5.5): this host may have no copy yet, and then shows no conversation
   *  until it has one. */
  fromCloud?: true
}

export interface ConversationDeps {
  isIOS?: boolean
  /** A new store now owns this closed store's host and session watch. */
  hasReplacement?(): boolean
  accountScope?: string
  sessionCache?: ReturnType<MobileSessionCache["forHost"]>
  connection: HostConnection
  taskApi?(hostId: string): SolusAPI
  outbox: SendOutbox
  /** The person's run settings when the conversation opens. */
  runSettings(): Promise<RunSettings>
  /** Keeps a model's chosen options as the person's own for next time. */
  saveModelOptions?(provider: AgentId, model: string, options: ModelOptions): void
  /** The person's "name new sessions" setting; absent never names one. */
  autoRenameSessions?(): boolean
  organizationId(): string | null
  uuid(): string
  /** Reads and sends picked files; absent where attaching is not offered. */
  attachmentIo?: AttachmentIo
  /** What each host holds of the session's repository: the prompt carries the
   *  newest head, and an open asks a host that is behind to sync. */
  runHosts?: Pick<SessionRunHosts, 'noteMeta' | 'noteTurnSettled' | 'promptFields' | 'opened' | 'prepareNewerCopy'>
  /** The session's read-only copy from Solus Cloud, while no host that holds it shows it. */
  cloudHistory?: Pick<CloudHistory, 'read' | 'isCopy' | 'readOlder'>
  onChange(changes: { items: string[]; order: boolean; meta: boolean }): void
}

/** The events that change what the run or the queue of a conversation shows: its listeners are told at once. */
const RUN_CHANGING_EVENTS: ReadonlySet<WireNormalizedEvent['type']> = new Set(['session_queue', 'provider_switch_applied', 'activity', 'session_codebase'])

/** The outbox queue of one conversation. Forgetting a host removes every
 *  queue under `conversationOutboxPrefix(hostId)`. */
export function conversationOutboxKey(hostId: string, sessionId: string): string {
  return `${hostId}/${sessionId}`
}

export function conversationOutboxPrefix(hostId: string): string {
  return `solus.sendOutbox.v1.${hostId}/`
}

// A known disk page can save a full network response. Keep the wait bounded on slow storage.
const HISTORY_CACHE_WAIT_MS = 50
const SAVED_OPENING_CACHE_WAIT_MS = 200
// A prefetch is a host read already under way: its blocks make the open's answer small.
const PREFETCH_WAIT_MS = 1_500
const COLD_HISTORY_TURNS = 5
const OPENING_PAGE_TURNS = 2

function fitsOpeningPage(page: SessionHistoryPage): boolean {
  let turns = 0
  for (const message of page.messages) {
    if (startsHistoryTurn(message) && ++turns > OPENING_PAGE_TURNS) return false
  }
  return true
}

interface HistoryPreview {
  resumedWatch?: WatchSessionResult
  acceptsCachedPage?(page: SessionHistoryPage): boolean
  shown: SessionHistoryPage | null
  saved: SessionHistoryPage | null
  timing: OpenTiming | null
  paint(page: SessionHistoryPage | null, source: OpenPaintSource): void
}

interface SendPromptOptions {
  permissionMode?: PermissionMode
  delivery?: 'queue' | 'steer'
  clientPromptId?: string
  pendingMessage?: { messageId: string; commandId: string; createdAt: string }
  onSubmitted?: (clientPromptId: string) => void
  onQueued?: (clientPromptId: string) => void
  onUploadFailed?: () => void
}

type PromptSubmission =
  | { messageId: null; delivered: Promise<void> }
  | { messageId: string; saved: Promise<boolean>; delivered: Promise<void> }

/** An upload in flight. `landed` is the host's copy, or null when it failed. */
interface InFlightUpload {
  readonly id?: string
  readonly file?: PickedFile
  readonly abort?: AbortController
  cancelled?: boolean
  readonly video?: { type: 'file'; id: string; name: string; mimeType: string; sizeBytes: number; fileUri: string }
  readonly preview?: { type: 'image'; id: string; name: string; mimeType: string; sizeBytes: number; previewUri: string }
  readonly landed: Promise<UploadedAttachment | null>
}

export class ConversationController {
  private failedUploads = new Map<string, { file: PickedFile; reason: string }>()

  get failedAttachments() {
    return [...this.failedUploads].map(([id, failure]) => ({ id, ...failure }))
  }

  private taskBinding: { taskId: string; hostId: string } | null = null
  bindTask(taskId: string, hostId: string): void {
    if (this.started) throw new Error('A started session keeps its task.')
    this.taskBinding = { taskId, hostId }
  }

  model: TranscriptModel
  retained = false
  phase: ConversationPhase = { kind: 'loading' }
  run: ConversationRun
  /** The agent session on another host that started this one, from the host's description. */
  startedBy: SessionStarterFromHost | null = null
  /** Uploaded to the host, waiting for the next prompt. */
  attachments: readonly UploadedAttachment[] = []
  /** Uploads in flight that no prompt took yet. */
  private uploads: InFlightUpload[] = []
  /** Plain text shown by the native thread's pending feed until delivery touches the transcript. */
  pendingText: { messageId: string; commandId: string; createdAt: string; text: string } | null = null

  private presentPendingText(): void {
    const pending = this.pendingText
    if (!pending) return
    this.pendingText = null
    this.model.addOptimisticUser(pending.messageId, pending.text, 'sending', [], false, Date.parse(pending.createdAt))
  }

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
  /** The session's MCP tasks and resource watches: its background rows that the host keeps (docs/plans/mcp-first-class.md §11.5, §12.5). */
  readonly mcpTasks: McpTasksFeed
  readonly resourceWatches: ResourceWatchesFeed
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
  get hasStarted(): boolean { return this.started }
  /** The local outbox can show a busy session before there is work to stop on the host. */
  get canStopTurn(): boolean {
    return isSessionBusyStatus(this.hostStatus) && isSessionBusyStatus(this.model.status)
  }
  private started: boolean
  private hostStatus: SessionStatus = 'idle'
  private projectPath: string
  /** The branch picked for a new session's checkout; null until one is
   *  picked, and again when the session goes back to the project's own. */
  checkoutBranch: string | null = null
  /** The branch a pick moved the project's checkout to; null when none did. */
  private projectBranch: string | null = null
  private settings: RunSettings | null = null
  /** Bumps on each (re)load; an answer for an older load is dropped. */
  private loadGeneration = 0
  private openingTurnsLeft = 0
  private openingRead: Promise<void> | null = null
  private openingPage: { saved: SessionHistoryPage; result: Promise<SessionHistoryPage | null> } | null = null
  private held: WireNormalizedEvent[] | null = null
  private bufferedCursor?: string
  private appliedCursor?: string
  /** The prompt that started a new session, until the host names the session from it. */
  private openingPrompt: string | null = null
  private watching = false
  /** A watch sent beside a prompt, until its reply comes. */
  private watchBesidePrompt: Promise<void> | null = null
  /** Counts live events, so a watch reply knows if the stream moved past it. */
  private liveEvents = 0
  private closed = false
  private readonly cleanups: Array<() => void> = []
  /** The transcript another host showed, until this host is current (`ConversationTarget.carriedTranscript`). */
  private carried: TranscriptModel | null
  /** The first load asked the run host to sync when it is behind. */
  private openedOnHost = false
  /** A cloud session this host has no copy of: no history is read until it has one. */
  private awaitsHostCopy = false
  /** "Use the newer copy" asked the host to sync: its history is read again when it is current. */
  private reloadsWhenCurrent = false
  /** The host refused a prompt because another host continued the session (`SESSION_DIVERGED`). */
  isSessionDiverged = false
  /** The read of the session's copy from Solus Cloud (docs/plans/portable-sessions-cloud.md, Phase 5B). */
  cloudRead: SessionCloudReadStatus = { kind: 'idle' }
  /** The run host's own history shows: a copy from the cloud gives way to it. */
  private hasHostHistory = false
  /** Turns this conversation saw end, so a replayed event counts a turn once. */
  private readonly settledTurnIds = new Set<string>()

  constructor(readonly target: ConversationTarget, private readonly deps: ConversationDeps) {
    this.attachments = target.newSession?.attachments ?? []
    this.projectPath = target.record?.projectPath ?? ''
    this.run = initialRun(target, deps.organizationId(), deps.uuid)
    this.started = !!target.record
    this.threadProvider = target.record?.provider ?? null
    this.carried = target.record ? target.carriedTranscript ?? null : null
    this.model = this.carried ?? new TranscriptModel(this.run.sessionId)
    if (target.record?.execution) this.applyExecution(target.record.execution)
    // A copy from the cloud that the person carried to this host by a pick.
    if (this.carried && deps.cloudHistory?.isCopy(this.carried)) this.cloudRead = { kind: 'ready' }
    const { connection } = deps
    this.auth = new AgentAuthFlow({ connection, notice: (text, tone) => {
      this.model.addNotice(text, tone)
      this.flush()
    } })
    this.cleanups.push(() => this.auth.close())
    this.suggestions = new SessionSuggestionsFeed(connection, () => this.run.sessionId, () => this.context())
    this.cleanups.push(() => this.suggestions.close())
    this.mcpTasks = new McpTasksFeed(connection, () => this.run.sessionId)
    this.resourceWatches = new ResourceWatchesFeed(connection, () => this.run.sessionId)
    this.cleanups.push(() => this.mcpTasks.close(), () => this.resourceWatches.close())
    this.cleanups.push(connection.events.subscribe('session.eventReceived', (payload) => {
      if (payload.sessionId !== this.run.sessionId) return
      this.receive(payload.event)
      if (payload.cursor) {
        if (this.held) this.bufferedCursor = payload.cursor
        else this.appliedCursor = payload.cursor
      }
    }))
    // One sheet lists every integration the turn asked for, as the group card
    // does on desktop and web; a repeated ask keeps its one row.
    this.cleanups.push(connection.events.subscribe('integration.connectNeeded', (payload) => {
      if (payload.sessionId === this.run.sessionId) this.askToConnect(payload)
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
    this.cleanups.push(connection.events.subscribe('session.executionChanged', (payload) => {
      if (payload.sessionId !== this.run.sessionId || payload.toolId || !this.applyExecution(payload.execution)) return
      this.flush(true)
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
      if (key !== 'machine') return
      const info = connection.facts.value('machine')
      if (!info) return
      this.agents = info.agents.map((agent) => agentForProject(agent, this.agentProject))
      if (!this.run.agentSessionId) {
        if (!this.modelPicked) Object.assign(this.run, newSessionModel(this.run.provider, this.settings, this.agents.find((agent) => agent.id === this.run.provider)))
        this.settleRun()
      }
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
    this.cleanups.push(connection.onReset(() => { if (!this.retained) void this.load(true) }))
    this.cleanups.push(connection.onAccepted(() => {
      // The host is back after its read failed while the cloud read showed: its history replaces the copy.
      if (this.phase.kind === 'error' && this.cloudRead.kind !== 'idle') void this.load()
      void this.drainOutbox()
    }))
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

  /** A host gave the rows that show: this host's history, or a transcript carried from another host. */
  get showsHostConversation(): boolean {
    return this.hasHostHistory || (this.carried !== null && !this.deps.cloudHistory?.isCopy(this.carried))
  }

  /** The run host answered that it has no copy of the session. */
  get hostHasNoCopy(): boolean {
    return this.awaitsHostCopy
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

  /** Whether the reader may change the session's record: its title, links,
   *  and the watches on its pull requests (docs/plans/pr-watch.md). */
  get mayEdit(): boolean {
    return resourceAllows({ role: this.target.record?.role }, 'edit')
  }

  /** Auto can pick this session's model: nothing has started it yet. */
  get canRoute(): boolean {
    return canRouteAuto({ started: this.started, agentSessionId: this.run.agentSessionId })
  }

  /** A new worktree can be chosen until the first prompt starts the
   *  session, and never for a chat, which has no project. */
  get canChooseStart(): boolean {
    return this.canRoute && !isChat(this.run.workingDirectory)
  }

  /** The folder that names the project's agent settings. The path of a task
   *  folder names no project, so its session gives the root of its record. */
  private get agentProject(): string {
    return (isTaskFolderPath(this.run.workingDirectory) && this.run.projectRoot) || this.projectPath || this.run.workingDirectory
  }

  /** The project folder of the run: its checkout's repository, or the member that a task folder stands in for. */
  get projectRoot(): string {
    return runProjectRoot(this.run)
  }

  /** The person chose the codebase of the new session, "No codebase" included. */
  isCodebasePicked = false

  /** The new session starts with this codebase, or with none when null
   *  (docs/plans/codebases.md decision 5). */
  chooseCodebase(codebaseId: string | null): void {
    if (!this.canRoute) return
    this.isCodebasePicked = true
    // "No codebase" also tells the host to make none for the session (decision 13).
    this.run.noCodebase = codebaseId === null
    this.startWithCodebase(codebaseId)
    this.flush(true)
  }

  /** Follow the codebase of the folder when no valid choice is set. */
  followFolderCodebase(codebaseId: string | null, isPickRemoved = false): void {
    if (!this.canRoute) return
    if (this.isCodebasePicked && !isPickRemoved) return
    if (!this.isCodebasePicked && (this.run.codebaseId ?? null) === codebaseId) return
    this.isCodebasePicked = false
    this.startWithCodebase(codebaseId)
    this.flush(true)
  }

  /** A different codebase has different members, so the repository choice of
   *  the new worktree starts again. */
  private startWithCodebase(codebaseId: string | null): void {
    if ((this.run.codebaseId ?? null) === codebaseId) return
    this.run.codebaseId = codebaseId
    this.run.worktreeRepositories = null
  }

  /** The members that get a worktree with the new worktree session, as member
   *  paths. Null is the default set, which the host chooses. */
  chooseWorktreeRepositories(repositories: readonly string[] | null): void {
    if (!this.canChooseStart) return
    this.run.worktreeRepositories = repositories
    this.flush(true)
  }

  /** The new session starts in a new worktree from `baseBranch`, or in the
   *  project's checkout when null. As in T3, both start from the project
   *  folder: a worktree another branch pick named is left. */
  chooseWorktreeBase(baseBranch: string | null): void {
    if (!this.canChooseStart || (this.run.worktreeBaseBranch ?? null) === baseBranch) return
    this.run.worktreeBaseBranch = baseBranch
    this.run.workingDirectory = this.projectDirectory
    this.checkoutBranch = this.projectBranch
    this.flush(true)
  }

  /** The new session starts in the project's checkout on `branch` (T3's
   *  current-checkout branch picker). The host reads the refs again, then
   *  checks the branch out in the project or names the worktree that already
   *  has it; the draft works in the folder the host names. Returns the
   *  host's refusal, or null. */
  async chooseCheckoutBranch(branch: Pick<BranchRef, 'name' | 'remoteOnly'>, options?: { create: boolean; cwd: string }): Promise<string | null> {
    if (!this.canChooseStart) return 'The session has started.'
    const project = this.projectDirectory
    let result: GitCheckoutBranchResult
    try {
      const ctx = options ? this.context() : this.projectCheckoutContext()
      if (options && ctx.session.workingDirectory !== options.cwd) return 'The checkout has changed.'
      result = await this.deps.connection.api.gitCheckoutBranch(ctx, branch.name, { remoteOnly: branch.remoteOnly, ...(options?.create && { create: true }) })
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    if (!result.success) return result.error || "Couldn't switch the branch."
    // An older host names no folder: its switch is always in the project.
    const workingDirectory = result.workingDirectory ?? options?.cwd ?? project
    const picked = result.gitContext?.branch ?? branch.name
    if (workingDirectory === project) this.projectBranch = picked
    if (this.canChooseStart) {
      this.checkoutBranch = picked
      this.run.worktreeBaseBranch = null
      this.run.workingDirectory = workingDirectory
    }
    this.flush(true)
    return null
  }

  /** The other worktree a new session works in after a branch pick; null in
   *  the project's own checkout (T3's "Current worktree"). */
  get checkoutWorktree(): string | null {
    return this.run.workingDirectory === this.projectDirectory ? null : this.run.workingDirectory
  }

  /** The folder a new session was opened for. */
  get projectDirectory(): string {
    return this.target.newSession?.workingDirectory ?? this.run.workingDirectory
  }

  /** The context of a call about the project's own checkout, not the folder
   *  the draft works in now. */
  private projectCheckoutContext() {
    const ctx = this.context()
    const project = this.projectDirectory
    return { ...ctx, session: { ...ctx.session, workingDirectory: project, projectPath: runProjectRoot({ workingDirectory: project, projectRoot: this.run.projectRoot }) } }
  }

  /** The project's branches, the bases a new worktree can start from. No
   *  fetch first: the list is what the checkout has now, and it is fast. As
   *  in T3, they are read in the project's own checkout, wherever the draft
   *  works now, so its badges and current branch describe that checkout. */
  async branches(): Promise<{ branches: BranchRef[]; currentBranch: string | null }> {
    const [branches, identity] = await Promise.all([
      this.deps.connection.api.worktreeBranches(this.projectCheckoutContext(), { skipFetch: true }),
      this.deps.connection.api.gitIdentity(this.projectDirectory).catch(() => null),
    ])
    return { branches, currentBranch: identity?.branch ?? null }
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
  async load(resume = false): Promise<void> {
    if (this.closed) return
    this.openingTurnsLeft = 0
    this.openingRead = null
    this.openingPage = null
    const generation = ++this.loadGeneration
    const afterEvent = resume && this.phase.kind === 'ready' ? this.appliedCursor : undefined
    this.appliedCursor = undefined
    this.bufferedCursor = undefined
    if (afterEvent) {
      this.held = []
      this.setPhase({ kind: 'loading' })
      // A new socket can retain the same live turn. Keep the open rows (including
      // older pages) only after the host confirms it can replay the exact suffix.
      const watched = await this.deps.connection.api.watchSession({
        sessionId: this.run.sessionId, attachRuntime: true, afterEvent,
      }).catch(() => null)
      if (this.closed || generation !== this.loadGeneration) return
      if (watched?.resumed) {
        this.watching = true
        this.applyWatch(watched)
        const held = this.held
        this.held = null
        for (const event of held) this.receive(event)
        this.appliedCursor = this.bufferedCursor ?? afterEvent
        this.bufferedCursor = undefined
        this.setPhase({ kind: 'ready' })
        this.flush(true)
        void this.suggestions.refresh()
        void this.mcpTasks.refresh()
        void this.resourceWatches.refresh()
        void this.refreshSessionFolders()
        void this.drainOutbox()
        return
      }
    }
    this.bufferedCursor = undefined
    let receivedHistory = false
    const preview: HistoryPreview = {
      shown: null,
      saved: null,
      timing: generation === 1 && this.target.record ? OpenTiming.start(this.hostId, this.run.sessionId) : null,
      paint: (page: SessionHistoryPage | null, source: OpenPaintSource) => {
        if (!page || this.closed || generation !== this.loadGeneration || receivedHistory || (this.phase.kind === 'error' && this.phase.noAccess) || this.model.order.length) return
        this.model = preview.timing ? preview.timing.build(() => TranscriptModel.fromHistory(this.run.sessionId, page)) : TranscriptModel.fromHistory(this.run.sessionId, page)
        preview.shown = page
        preview.timing?.shown(source)
        this.flush(true)
      },
    }
    const cache = this.target.record && !this.target.movedFrom && !this.target.fromCloud ? this.deps.sessionCache : undefined
    // A prefetch under way is the saved page: the open paints its answer.
    const prefetched = cache?.prefetching(this.run.sessionId) ?? false
    const cached = cache?.history(this.run.sessionId).catch(() => null)
    void cached?.then(page => {
      preview.saved = page
      if (page) preview.timing?.savedPageRead(prefetched)
      if (!preview.shown && page && preview.acceptsCachedPage?.(page) !== false) preview.paint(page, prefetched ? 'prefetch' : 'saved')
    })
    this.held = []
    this.watching = false
    this.setPhase({ kind: 'loading' })
    try {
      const history = this.readHistory(generation, cached, preview)
      const settings = this.applyRunSettingsOnce()
      this.runOptionsLoaded = settings.then(() => {
        if (!this.closed && generation === this.loadGeneration) return this.loadRunOptions(generation)
      })
      // A history read does not use composer defaults. Start both on open.
      void this.runOptionsLoaded.catch(() => {})
      const model = await history
      if (!model) return
      receivedHistory = true
      this.keepUnsentPrompts(model)
      // The folders are not in the history: the list shows until the host answers again.
      model.sessionFolders = this.model.sessionFolders
      this.model = model
      // The host's own history replaces a copy from the cloud.
      if (!this.awaitsHostCopy && model !== this.carried) {
        this.hasHostHistory = true
        this.cloudRead = { kind: 'idle' }
      }
      const held = this.held ?? []
      this.held = null
      // The page leaves out the running turn; the watch replayed it into `held`.
      for (const event of held) this.receive(event)
      this.appliedCursor = this.bufferedCursor
      this.bufferedCursor = undefined
      preview.timing?.shown('host')

      // Show the history now. Joining the live session can take another
      // network round trip and must not hold back rows already read.
      this.flush(this.openingTurnsLeft > 0)
      if (generation !== this.loadGeneration || this.closed) return
      const [watched] = await Promise.all([preview.resumedWatch ?? this.watch(), settings])
      if (generation !== this.loadGeneration) return
      this.applyWatch(watched)
      this.setPhase({ kind: 'ready' })
      void this.deps.connection.api.setSessionReadState(this.run.sessionId, Date.now()).catch(() => undefined)
      // Every load, reconnects included: a change missed while away is read again.
      if (this.started) {
        void this.suggestions.refresh()
        void this.mcpTasks.refresh()
        void this.resourceWatches.refresh()
        void this.refreshSessionFolders()
      }
      this.flush(true)
      if (this.started && !this.openedOnHost) {
        this.openedOnHost = true
        void this.prepareRunHost()
      }
      void this.drainOutbox()
    } catch (error) {
      if (generation !== this.loadGeneration) return
      this.held = null
      if (error instanceof Error && ['FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED'].includes(rpcErrorCode(error) ?? '')) {
        void this.deps.sessionCache?.saveHistory(this.run.sessionId, null)
        this.model = TranscriptModel.fromHistory(this.run.sessionId, { messages: [], before: null })
        this.flush(true)
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
    this.agents = agents.map((agent) => agentForProject(agent, this.agentProject))
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
      this.agents = agents.map((agent) => agentForProject(agent, this.agentProject))
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
  private async readHistory(generation: number, cached: Promise<SessionHistoryPage | null> | undefined, preview: HistoryPreview): Promise<TranscriptModel | null> {
    if (!this.started) return new TranscriptModel(this.run.sessionId)
    const api = this.deps.connection.api
    const timing = preview.timing
    const historyApi = timing ? {
      loadSessionPage: (request: Parameters<typeof api.loadSessionPage>[0]) => {
        timing.requestSent()
        return api.loadSessionPage(request).finally(() => timing.answered())
      },
    } : api
    // A reload's page travels while the session is described. A lineage that moves
    // the thread to another provider reads the page again from that provider.
    const hasSavedPage = cached && this.deps.sessionCache?.hasHistoryKey(this.run.sessionId)
    const largeOpening = this.deps.isIOS && generation === 1 && cached !== undefined && (this.target.record?.size ?? 0) >= LARGE_SESSION_BYTES
    let turnLimit = INITIAL_HISTORY_TURNS
    if (largeOpening && hasSavedPage !== undefined) turnLimit = OPENING_PAGE_TURNS
    else if (generation === 1 && hasSavedPage === false) turnLimit = COLD_HISTORY_TURNS
    if (largeOpening && turnLimit === OPENING_PAGE_TURNS) {
      const deadline = performance.now() + SAVED_OPENING_CACHE_WAIT_MS
      preview.acceptsCachedPage = page => (hasSavedPage && performance.now() <= deadline) ||
        fitsOpeningPage(page)
    }
    const connectionGeneration = this.deps.connection.state.sessionGeneration
    const firstSource = this.historySource
    const acceptWatch = (watched: WatchSessionResult) => {
      if (this.closed) {
        if (!this.deps.hasReplacement?.() && connectionGeneration === this.deps.connection.state.sessionGeneration) {
          void api.unwatchSession(this.run.sessionId).catch(() => undefined)
        }
        return
      }
      if (generation === this.loadGeneration) {
        this.watching = true
        preview.resumedWatch = watched
      }
    }
    // Every open is one request: the page, the description, and the watch. A
    // reload after a reset is one too, so its page and its replay describe one
    // moment (docs/plans/running-turn-open.md). A saved page paints at once; its
    // blocks make the answer that confirms it small.
    const opens = !this.target.movedFrom && !this.target.fromCloud
    let openingDescription: SessionDescription | undefined
    const cacheWaitMs = largeOpening ? SAVED_OPENING_CACHE_WAIT_MS
      : this.deps.sessionCache?.prefetching(this.run.sessionId) ? PREFETCH_WAIT_MS : HISTORY_CACHE_WAIT_MS
    const firstPage = this.target.movedFrom || this.target.fromCloud ? null
      : loadSessionHistoryPage(historyApi, { ...firstSource, turnLimit, ...sessionFeedHistoryOptions, knownHistoryBlocks: [], ...(opens && { openSession: true }) },
        hasSavedPage && cached ? () => cached : undefined, cacheWaitMs,
        {
          cachedTurnLimit: largeOpening ? page => {
            // Older installs can have a full page. Validate that window when disk supplied it in time.
            if (!fitsOpeningPage(page)) turnLimit = INITIAL_HISTORY_TURNS
            if (turnLimit === OPENING_PAGE_TURNS && page.before && page.historyRevision && !this.closed && generation === this.loadGeneration) {
              const before = page.before
              // Start the confirmation first. Read ahead by one page while the native list lands.
              const result = Promise.resolve().then(() => api.loadSessionPage({
                ...firstSource, before, turnLimit: OPENING_PAGE_TURNS, ...sessionFeedHistoryOptions,
              })).catch(() => null)
              this.openingPage = { saved: page, result }
            }
            return turnLimit
          } : undefined,
          onOpened: opens ? opened => {
            openingDescription = opened.openingDescription
            if (opened.resumedWatch) acceptWatch(opened.resumedWatch)
          } : undefined,
        })
    let waitingForDescription = true
    // If the source is already known, the authoritative read below paints this page.
    // An open's answer can name another provider: that page is not painted.
    void firstPage?.then(page => {
      const active = openingDescription?.lineage?.active
      if (waitingForDescription && (!active || active.provider === firstSource.provider)) preview.paint(page, 'host')
    }).catch(() => {})
    // An old host can ignore openSession. A stale provider can also reject the speculative page.
    // In either case resolve the lineage before deciding which page to use.
    const opened = opens ? await firstPage?.then(() => openingDescription, () => undefined) : undefined
    const description = opened ?? await api.describeSession(this.run.sessionId).catch(() => null)
    waitingForDescription = false
    if (generation !== this.loadGeneration) return null
    this.startedBy = hostStarterOf(description?.meta?.startedBy)
    this.deps.runHosts?.noteMeta(this.hostId, description?.meta)
    this.followHostCopy(description?.meta ?? null)
    const lineage = description?.lineage
    if (lineage) {
      this.run.agentSessionId = lineage.active.providerSessionId ?? null
      this.followThread(lineage.active.provider)
    }
    if (this.carried) return this.carried
    // A copy from the cloud stays until the host has its own.
    if (this.awaitsHostCopy) return this.deps.cloudHistory?.isCopy(this.model) ? this.model : new TranscriptModel(this.run.sessionId)
    const source = this.historySource
    const page = await (firstPage && source.provider === firstSource.provider && source.projectPath === firstSource.projectPath
      ? firstPage
      : api.loadSessionPage({ ...source, turnLimit, ...sessionFeedHistoryOptions }))
    if (generation !== this.loadGeneration) return null
    if (this.openingPage && (source.provider !== firstSource.provider || source.projectPath !== firstSource.projectPath ||
        !sameHistoryPage(this.openingPage.saved, page))) this.openingPage = null
    if (page.before) this.openingTurnsLeft = INITIAL_HISTORY_TURNS - turnLimit
    if (page.messages.at(-1)?.loginRefused) this.offerSignInAgain()
    if (!preview.saved || preview.saved.historyRevision !== page.historyRevision || !sameHistoryPage(preview.saved, page)) void this.deps.sessionCache?.saveHistory(this.run.sessionId, page)
    if (preview.shown && sameHistoryPage(preview.shown, page)) return this.model
    return timing ? timing.build(() => TranscriptModel.fromHistory(this.run.sessionId, page)) : TranscriptModel.fromHistory(this.run.sessionId, page)
  }

  /**
   * What this host answered of its copy. A host that has the session keeps it
   * in its own folder, not the one the host it came from used. A cloud
   * session it has no copy of reads no history until it has one.
   */
  private followHostCopy(meta: Pick<SessionMeta, 'cwd' | 'projectPath'> | null): void {
    const { movedFrom, fromCloud } = this.target
    this.awaitsHostCopy = !!fromCloud && !meta
    if (!(movedFrom || fromCloud) || !meta?.cwd) return
    this.run.workingDirectory = meta.cwd
    this.projectPath = meta.projectPath
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

  async readToolInput(key: string): Promise<string> {
    const inputs = await this.deps.connection.api.loadSessionToolInputs({ ...this.historySource, keys: [key] })
    const input = inputs.find(entry => entry.key === key)
    if (!input) throw new Error('The host no longer has the full tool input.')
    return input.toolInput
  }

  get canFillOpeningHistory(): boolean {
    return !this.closed && this.held === null && this.phase.kind !== 'error' && this.openingTurnsLeft > 0 && !!this.model.olderCursor && !this.model.history.loading
  }

  get hasOpeningPage(): boolean {
    return this.openingPage !== null
  }

  readonly fillOpeningHistory = async (beforeInsert: () => Promise<void> = () => Promise.resolve()): Promise<void> => {
    if (!this.canFillOpeningHistory || this.openingRead) return
    const turns = Math.min(OPENING_PAGE_TURNS, this.openingTurnsLeft)
    this.openingTurnsLeft -= turns
    const read = this.readOlder(turns, undefined, beforeInsert)
    this.openingRead = read
    try {
      await read
    } finally {
      if (this.openingRead === read) this.openingRead = null
    }
  }

  async loadOlder(throughEntryId?: string): Promise<void> {
    this.openingTurnsLeft = 0
    const generation = this.loadGeneration
    if (this.openingRead) await this.openingRead
    if (!this.closed && generation === this.loadGeneration) await this.readOlder(OLDER_HISTORY_TURNS, throughEntryId)
  }

  private async readOlder(turnLimit: number, throughEntryId?: string, beforeInsert?: () => Promise<void>): Promise<void> {
    const cursor = this.model.olderCursor
    // A copy from the cloud reads its older turns there, with no host.
    const isCloudRead = this.deps.cloudHistory?.isCopy(this.model) === true
    if (!cursor || this.model.history.loading || (this.phase.kind !== 'ready' && !isCloudRead && !beforeInsert)) return
    const generation = this.loadGeneration
    const model = this.model
    if (!beforeInsert) {
      model.history = { ...model.history, loading: true, error: null }
      this.flush(true)
    }
    try {
      if (isCloudRead) {
        await this.deps.cloudHistory?.readOlder(model, throughEntryId)
      } else {
        const prepared = beforeInsert && this.openingPage?.saved.before === cursor ? this.openingPage.result : undefined
        this.openingPage = null
        const earlier = prepared ? await prepared : null
        if (this.closed || generation !== this.loadGeneration || this.model !== model) return
        const page = earlier ?? await this.deps.connection.api.loadSessionPage({
          ...this.historySource,
          turnLimit, ...sessionFeedHistoryOptions,
          before: cursor,
          ...(throughEntryId && { throughEntryId }),
        })
        if (beforeInsert) await beforeInsert()
        if (!this.closed && generation === this.loadGeneration && model === this.model && model.olderCursor === cursor) {
          if (page.before === cursor) throw new Error('The host returned the same history cursor.')
          model.prependHistory(page)
        }
      }
    } catch (error) {
      if (!this.closed && generation === this.loadGeneration && model === this.model && model.olderCursor === cursor) {
        this.openingTurnsLeft = 0
        model.history = { ...model.history, error: error instanceof Error ? error.message : 'Could not load earlier turns.' }
      }
    } finally {
      if (!beforeInsert) model.history = clearActiveHistoryLoading(cursor, model.history)
      if (!this.closed && generation === this.loadGeneration && this.model === model) this.flush(true)
    }
  }

  /**
   * No host that holds the session shows it: the conversation shows the
   * session's read-only copy from Solus Cloud, read again on each call
   * (docs/plans/portable-sessions-cloud.md, Phase 5B). The run host's history
   * replaces it when it loads; a prompt still goes to the run host.
   */
  async readCloudHistory(): Promise<void> {
    const history = this.deps.cloudHistory
    if (!history || !this.started || this.showsHostConversation || this.cloudRead.kind === 'loading' || this.closed) return
    this.cloudRead = { kind: 'loading' }
    this.flush(true)
    try {
      const model = await history.read(this.run.sessionId, this.threadProvider ?? this.run.provider)
      if (this.closed || this.showsHostConversation) return
      this.keepUnsentPrompts(model)
      this.model = model
      this.cloudRead = { kind: 'ready' }
    } catch (error) {
      if (this.closed || this.showsHostConversation) return
      this.cloudRead = { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    this.flush(true)
  }

  /** Prompts not yet confirmed stay visible in a new model: a rebuild, or a copy from the cloud. */
  private keepUnsentPrompts(model: TranscriptModel): void {
    for (const record of this.deps.outbox.entriesFor(this.outboxKey, this.deps.accountScope)) {
      model.addOptimisticUser(record.clientPromptId, record.text, record.lastError ? 'failed' : 'queued', queuedMessageAttachments(record.payload))
      if (record.lastError) model.markDelivery(record.clientPromptId, 'failed', record.lastError)
    }
  }

  /** Sends one prompt. Its id is made once and kept in the outbox until the
   *  host confirms it, so any retry is the same message to the host. While a
   *  turn runs, `delivery` chooses queue or steer; a waiting queue always queues.
   *  A sign-in command never reaches the agent: it runs here. */
  async send(text: string, options: SendPromptOptions = {}): Promise<void> {
    await this.submit(text, options).delivered
  }

  /** Expose the local save separately so the composer can anchor before host delivery. */
  submit(text: string, options: SendPromptOptions = {}): PromptSubmission {
    const prompt = text.trim()
    if (this.run.provider === 'codex' && /^\/compact(?:\s|$)/.test(prompt)) return { messageId: null, delivered: this.compact(prompt) }
    const authCommand = parseAgentAuthCommand(prompt, this.run.provider)
    if (authCommand) return { messageId: null, delivered: this.auth.run(authCommand, this.run.workingDirectory) }
    for (const id of this.failedUploads.keys()) void this.retryAttachment(id)
    // The prompt takes the uploads still in flight: it shows now and goes when they land.
    const waiting = this.uploads
    const attachments = this.attachments
    if (!prompt && attachments.length === 0 && waiting.length === 0) return { messageId: null, delivered: Promise.resolve() }
    const clientPromptId = options.pendingMessage?.messageId ?? options.clientPromptId ?? this.deps.uuid()
    const busy = isSessionBusyStatus(this.model.status)
    const statusBefore = this.model.status
    if (options.permissionMode) this.run.permissionMode = options.permissionMode
    this.attachments = []
    this.uploads = []
    if (!this.started && !this.run.agentSessionId && prompt && this.openingPrompt === null) this.openingPrompt = prompt
    this.presentPendingText()
    const waitsForTurn = busy || this.queue.entries.length > 0 || this.queue.held
    if (options.pendingMessage && !waitsForTurn && !attachments.length && !waiting.length) {
      this.pendingText = { ...options.pendingMessage, text: prompt }
    } else {
      this.model.addOptimisticUser(clientPromptId, prompt, 'sending', [...uploadedMessageAttachments(attachments),
        ...waiting.flatMap(({ video, preview }): MessageAttachment[] => {
          if (video) return [{ kind: 'local-video', key: video.id, name: video.name, uri: video.fileUri, mimeType: video.mimeType }]
          return preview ? [{ kind: 'local-image', key: preview.id, name: preview.name, uri: preview.previewUri, mimeType: preview.mimeType }] : []
        }),
      ], waitsForTurn)
    }
    if (!waitsForTurn) {
      this.model.setStatus('connecting')
      this.model.setProviderStartup({ provider: this.run.provider, phase: 'starting' })
    }
    this.flush(true)
    options.onSubmitted?.(clientPromptId)
    // A later prompt waits behind one that waits, so the host gets them in order.
    const before = this.heldSend
    let release = () => {}
    if (waiting.length > 0 || before) {
      const held = new Promise<void>((resolve) => { release = resolve })
      this.heldSend = held
      void held.then(() => { if (this.heldSend === held) this.heldSend = null })
    }
    const save = async () => {
      try {
        await before
        let ready = await this.landedAttachments(clientPromptId, prompt, attachments, waiting, statusBefore)
        if (!ready) {
          options.onUploadFailed?.()
          return false
        }
        try {
          const kept = [...ready]
          ready = kept
          for (const [index, file] of kept.entries()) {
            if (!file.pending) continue
            try {
              kept[index] = await file.pending.keep()
            } catch (error) {
              if (file.localUri && !this.closed) {
                const reason = error instanceof Error ? error.message : String(error)
                this.failedUploads.set(file.id, {
                  file: { uri: file.localUri, name: file.name, mimeType: file.mimeType, size: file.size },
                  reason,
                })
                ready = kept.filter(attachment => attachment.id !== file.id)
                void file.pending.discard().catch(() => {})
              }
              throw error
            }
          }
          this.model.setOptimisticAttachments(clientPromptId, uploadedMessageAttachments(kept))
          await this.enqueuePrompt(clientPromptId, prompt, ready, busy, options.delivery)
        } catch (error) {
          if (this.pendingText?.messageId === clientPromptId) this.pendingText = null
          this.model.dropOptimisticUser(clientPromptId)
          this.attachments = [...ready, ...this.attachments]
          if (this.openingPrompt === prompt) this.openingPrompt = null
          if (this.model.status === 'connecting') this.model.setStatus(statusBefore)
          this.flush(true)
          throw error
        }
        options.onQueued?.(clientPromptId)
        return true
      } finally {
        release()
      }
    }
    const saved = save()
    return {
      messageId: clientPromptId,
      saved,
      delivered: saved.then(async (queued) => { if (queued) await this.drainOutbox(true) }),
    }
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
    const saved = this.deps.outbox.enqueue(this.outboxKey, {
      clientPromptId,
      sessionId: this.run.sessionId,
      text: prompt,
      enqueuedAt: Date.now(),
      accountScope: this.deps.accountScope,
      payload: { ...composed, issueId: this.taskBinding?.taskId, taskHostId: this.taskBinding?.hostId, displayPrompt: prompt, delivery: this.queue.entries.length ? 'queue' : busy ? delivery ?? 'steer' : undefined,
        queueAttachments: attachments.map((attachment) => ({ id: attachment.id, type: attachment.kind, name: attachment.name,
          hostPath: attachment.hostPath, mimeType: attachment.mimeType, size: attachment.size })),
        queueAttachmentContext: attachments.filter((attachment) => attachment.kind === 'file').map((attachment) => `[Attached file: ${attachment.hostPath}]`).join('\n'),
      },
    })
    if (!saved) throw new Error('Could not save the prompt to the local outbox.')
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

  get pendingVideos() {
    return this.uploads.flatMap(upload => upload.video ? [upload.video] : [])
  }

  get pendingImages() {
    return this.uploads.flatMap(upload => upload.preview ? [upload.preview] : [])
  }

  /** Preserve this draft's files when the project picker opens a new checkout. */
  filesForDraftCheckout(hostId: string): { uploaded: readonly UploadedAttachment[]; picked: PickedFile[] } {
    const picked = this.uploads.map(upload => {
      if (!upload.file) throw new Error('Wait for the host resource to finish attaching before changing the checkout.')
      return upload.file
    })
    picked.push(...this.failedAttachments.map(({ file }) => file))
    const uploaded = hostId === this.hostId ? this.attachments.filter(file => !file.pending) : []
    const landed = this.attachments.filter(file => !uploaded.includes(file)).map(file => {
      if (!file.localUri) throw new Error(`Remove ${file.name} before switching hosts. Its only copy is on this host.`)
      return { name: file.name, uri: file.localUri, size: file.size, mimeType: file.mimeType }
    })
    return { uploaded, picked: [...landed, ...picked] }
  }

  /** Uploads picked files to the host now, so the prompt can name them. A
   *  prompt sent before they land takes them and waits for them. */
  async attach(files: readonly PickedFile[]): Promise<void> {
    await this.attachFiles(files)
  }

  async retryAttachment(id: string): Promise<void> {
    const failed = this.failedUploads.get(id)
    if (!failed || !this.mayDrive || this.closed) return
    this.failedUploads.delete(id)
    await this.attachFiles([failed.file], id)
  }

  private async attachFiles(files: readonly PickedFile[], retryId?: string): Promise<void> {
    const io = this.deps.attachmentIo
    if (!io || files.length === 0) return
    const problem = attachmentSizeProblem(files)
    if (problem) {
      this.model.addNotice(problem, 'error')
      this.flush()
      return
    }
    let previous: Promise<unknown> = Promise.resolve()
    const uploads = files.map((file) => {
      const before = previous
      const landed = Promise.resolve().then(() => this.uploadOne(file, io, upload, before))
      const media = attachmentKind(file)
      const id = retryId ?? this.deps.uuid()
      const upload: InFlightUpload = { id, file, landed, abort: new AbortController(), ...(media.type === 'image' && {
        preview: { type: 'image', id, name: file.name, mimeType: media.mimeType, sizeBytes: file.size ?? 0, previewUri: file.uri },
      }), ...(media.isVideo && {
        video: { type: 'file', id, name: file.name, mimeType: media.mimeType, sizeBytes: file.size ?? 0, fileUri: file.uri },
      }) }
      previous = landed
      return upload
    })
    this.uploads = [...this.uploads, ...uploads]
    this.flush(true)
    await previous
  }

  /** One upload, in order. It joins the composer's attachments unless a sent
   *  prompt took it; then that prompt gets it from `landed`. */
  private async uploadOne(file: PickedFile, io: AttachmentIo, upload: InFlightUpload, before: Promise<unknown>): Promise<UploadedAttachment | null> {
    let uploaded: UploadedAttachment | undefined
    try {
      if (upload.cancelled) {
        await before
        return null
      }
      const fact = this.deps.connection.facts.get('capabilities')
      const capabilities = fact.state === 'ready' ? fact.value : undefined
      const checkAccess = this.attachmentAccessCheck()
      uploaded = await uploadAttachment(file, {
        api: this.deps.connection.api,
        ctx: this.uploadContext(),
        serverUrl: this.deps.connection.transport.serverUrl,
        io,
        hostId: this.hostId,
        signal: upload.abort?.signal,
        checkAccess,
        stage: true,
        streamImages: hasHostCapability(capabilities, 'attachStreamUpload') && hasHostCapability(capabilities, 'promptImageRefs'),
        uuid: () => upload.id!,
      })
      await before
      if (upload.cancelled) {
        void uploaded.pending?.discard().catch(() => {})
        return null
      }
      checkAccess()
      if (this.uploads.includes(upload)) this.attachments = [...this.attachments, uploaded]
      return uploaded
    } catch (error) {
      await before
      void uploaded?.pending?.discard().catch(() => {})
      if (!upload.cancelled && !this.closed && upload.id) {
        const reason = error instanceof Error ? error.message : String(error)
        this.failedUploads.set(upload.id, { file, reason })
        this.model.addNotice(`${file.name} was not attached: ${reason}`, 'error')
      }
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
    // An image without its bytes reaches the agent only as a ref the host reads.
    if (refs.some((ref) => ref.type === 'image')
      && !hasHostCapability(await this.deps.connection.facts.when('capabilities'), 'promptImageRefs')) return false
    if (this.closed) return false
    this.attachments = [...this.attachments, ...referencedAttachments(refs, this.deps.uuid)]
    this.flush(true)
    return true
  }

  /**
   * Shows the connect sheet for one integration, as a turn's
   * `integration.connectNeeded` does; the person chose it from the MCP prompt
   * sheet (docs/plans/mcp-first-class.md §10). A repeated ask keeps its one row.
   */
  askToConnect(request: IntegrationConnectNeeded): void {
    const asked = this.connectNeeded.some((open) => open.integrationId === request.integrationId)
    this.connectNeeded = asked
      ? this.connectNeeded.map((open) => (open.integrationId === request.integrationId ? request : open))
      : [...this.connectNeeded, request]
    this.connectNeededChanges.notify()
  }

  /**
   * Has the host read an MCP resource into this conversation's attachments
   * (docs/plans/mcp-first-class.md §11.3). It counts as an upload until the
   * host answers, so a prompt sent meanwhile waits for it; a failed read says
   * why in a notice.
   */
  attachResource(resource: AttachedIntegrationResource): void {
    const name = resource.title ?? resource.name
    const landed: Promise<UploadedAttachment | null> = Promise.resolve().then(async () => {
      try {
        const read = resourceAttachments(await this.deps.connection.api.integrationResourceAttach(this.uploadContext(), resourceAttachRequest(resource)))
        if (!this.closed && this.uploads.includes(upload)) this.attachments = [...this.attachments, ...read]
        return read[0] ?? null
      } catch (error) {
        this.model.addNotice(`Could not read ${name}: ${error instanceof Error ? error.message : String(error)}`, 'error')
        return null
      } finally {
        this.uploads = this.uploads.filter((each) => each !== upload)
        this.flush(true)
      }
    })
    const upload: InFlightUpload = { landed }
    this.uploads = [...this.uploads, upload]
    this.flush(true)
  }

  /** Takes an attachment off the next prompt and releases any staged bytes. */
  removeAttachment(id: string): void {
    this.failedUploads.delete(id)
    const pending = this.uploads.find(upload => upload.id === id)
    if (pending) {
      pending.cancelled = true
      pending.abort?.abort()
      this.uploads = this.uploads.filter(upload => upload !== pending)
    }
    void this.attachments.find(file => file.id === id)?.pending?.discard().catch(() => {})
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
    const previous = this.queue
    const snapshot = await this.deps.connection.api.sessionQueueChange(this.context(), mutation)
    if (this.closed || this.queue !== previous) return
    this.queue = snapshot
    this.model.setQueued(snapshot.entries.filter(entry => entry.kind !== 'provider_switch'))
    this.flush(true)
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

  async uploadPickedFiles(files: readonly PickedFile[]): Promise<(QueueAttachment & { hostPath: string })[]> {
    const io = this.deps.attachmentIo
    if (!io) throw new Error('File uploads are unavailable.')
    const problem = attachmentSizeProblem(files)
    if (problem) throw new Error(problem)
    const checkAccess = this.attachmentAccessCheck()
    const capabilities = this.deps.connection.facts.value('capabilities')
    const streamImages = hasHostCapability(capabilities, 'attachStreamUpload') && hasHostCapability(capabilities, 'promptImageRefs')
    const result: (QueueAttachment & { hostPath: string })[] = []
    for (const file of files) {
      const attachment = await uploadAttachment(file, { api: this.deps.connection.api, ctx: this.uploadContext(),
        serverUrl: this.deps.connection.transport.serverUrl, hostId: this.hostId, io, checkAccess, streamImages, uuid: this.deps.uuid })
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
    this.openingPage = null
    for (const upload of this.uploads) upload.abort?.abort()
    for (const file of this.attachments) void file.pending?.discard().catch(() => {})
    this.failedUploads.clear()
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
    this.followSessionCodebase(event)
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
    if (event.type === 'turn_settled' && !this.settledTurnIds.has(event.turnId)) {
      this.settledTurnIds.add(event.turnId)
      this.deps.runHosts?.noteTurnSettled(this.hostId, this.run.sessionId)
    }
    const changedLegacyStatus = event.type === 'status_change' && !this.executionRevision && event.status !== this.hostStatus
    if (changedLegacyStatus) this.hostStatus = event.status
    // A host status update can arrive before the prompt echo. It owns no transcript row.
    if (event.type !== 'status_change') this.presentPendingText()
    this.model.apply(event)
    this.run.status = this.model.status
    this.flush(changedLegacyStatus || RUN_CHANGING_EVENTS.has(event.type))
    if (event.type === 'status_card') this.followStatusCard(event.card)
  }

  /** The host gave the session a codebase, or made one (docs/plans/codebases.md decision 13): the next prompt names it. */
  private followSessionCodebase(event: WireNormalizedEvent): void {
    if (event.type !== 'session_codebase') return
    this.run.codebaseId = event.codebaseId
    this.run.noCodebase = false
  }

  /** A sync card that ends makes this host current; a refused prompt's card says the session diverged. */
  private followStatusCard(card: StatusCardState): void {
    if (card.status === 'done' && isSessionSyncCard(card, this.run.sessionId)) this.adoptHostHistory()
    if (card.promptRefusalCode === SESSION_DIVERGED) this.noteSessionDiverged()
  }

  private noteSessionDiverged(): void {
    if (this.isSessionDiverged) return
    this.isSessionDiverged = true
    this.flush(true)
  }

  /**
   * "Use the newer copy" after a refused push (design answer 3.4): this host
   * syncs to the cloud head, then reads its history again. Its own turns stay
   * in its Git history and provider files.
   */
  async takeNewerCopy(): Promise<void> {
    this.reloadsWhenCurrent = true
    const result = await this.deps.runHosts?.prepareNewerCopy(this.run.sessionId, this.hostId)
    if (result?.state === 'current') this.adoptHostHistory()
  }

  private async watch(): Promise<WatchSessionResult> {
    const watched = await this.deps.connection.api.watchSession({
      sessionId: this.run.sessionId,
      attachRuntime: true,
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

  private executionRevision = 0

  private applyExecution(execution: SessionExecution): boolean {
    if (execution.revision <= this.executionRevision) return false
    this.executionRevision = execution.revision
    this.hostStatus = sessionExecutionStatus(execution)
    this.model.setStatus(this.hostStatus)
    return true
  }

  private applyWatch(watched: WatchSessionResult): void {
    if (watched.execution) this.applyExecution(watched.execution)
    for (const question of watched.pendingQuestions ?? []) {
      this.model.apply({ type: 'question_request', questionId: question.questionId, questions: question.questions, responseMode: question.responseMode, kind: question.kind, ...(question.hostLink && { hostLink: question.hostLink }), ...(question.cloudMachine && { cloudMachine: question.cloudMachine }) })
    }
    const runtime = watched.runtime
    if (runtime) {
      if (!this.executionRevision) {
        this.hostStatus = runtime.status
        this.model.setStatus(this.hostStatus)
      }
      this.model.setRateLimit(runtime.rateLimitInfo)
      this.model.setBackgroundWorkRunning(!!runtime.backgroundWorkRunning, runtime.backgroundTaskIds, runtime.backgroundTasks)
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
    } else if (this.run.agentSessionId && !this.executionRevision) {
      // Nothing runs for the session any more.
      this.hostStatus = 'idle'
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
        const taskId = record.payload?.issueId
        const taskHostId = record.payload?.taskHostId
        const isRemoteTask = !!taskHostId && taskHostId !== this.target.hostId
        const taskApi = taskId && taskHostId ? isRemoteTask ? this.deps.taskApi?.(taskHostId) : this.deps.connection.api : null
        if (taskId && !taskApi) throw new Error('The task host is unavailable.')
        let taskSnapshot: IssueSnapshot | undefined
        if (taskId && taskApi && !this.started) {
          const prepared = await taskApi.issuesPrepareForSession({ issueId: taskId, includeSnapshot: isRemoteTask })
          if (!prepared.task) throw new Error('The task is unavailable. Open it again before starting this session.')
          taskSnapshot = prepared.snapshot ?? undefined
        } else if (taskId && taskApi && isRemoteTask) taskSnapshot = await taskApi.issuesSnapshot(taskId)
        if (this.closed) throw new TransportDisconnectedError()
        const result = await this.deps.connection.api.prompt(ctx, {
          // The newest head this device knows, from reads that already
          // happened: a host that is behind syncs before the turn (plan §7.1).
          ...this.deps.runHosts?.promptFields(this.run.sessionId, this.hostId),
          issueId: taskId, taskSnapshot,
          prompt: record.payload?.prompt ?? record.text,
          displayPrompt: record.payload?.displayPrompt ?? record.text,
          clientPromptId: record.clientPromptId,
          delivery: record.payload?.delivery === 'steer' || record.payload?.delivery === 'queue' ? record.payload.delivery : undefined,
          imageAttachments: record.payload?.imageAttachments,
          imageAttachmentRefs: record.payload?.imageAttachmentRefs,
          queueAttachments: record.payload?.queueAttachments,
          queueAttachmentContext: record.payload?.queueAttachmentContext,
        }).catch((error: unknown) => {
          // The bubble shows the host's words; a policy refusal also keeps its code for the one fix it offers.
          const code = error instanceof Error ? rpcErrorCode(error) : null
          if (code && isPolicyRefusalCode(code)) this.policyRefusals.set(record.clientPromptId, code)
          if (code === SESSION_DIVERGED) this.noteSessionDiverged()
          throw error
        })
        if (taskId && taskApi && isRemoteTask) await taskApi.issuesLinkSession(taskId, this.run.sessionId, 'working', taskHostId === this.target.hostId ? null : { serverId: this.target.hostId, provider: this.run.provider, projectRoot: this.run.workingDirectory })
        this.started = true
        // The worktree is made once, by the prompt that started the session.
        this.run.worktreeBaseBranch = null
        this.run.worktreeRepositories = null
        // The first prompt starts the thread on the provider it carried.
        this.threadProvider ??= ctx.session.provider
        if (this.pendingText?.messageId === record.clientPromptId) this.presentPendingText()
        this.model.markDelivery(record.clientPromptId, result.disposition === 'queued' ? 'queued' : 'sent')
      }, this.deps.accountScope)
      this.syncDeliveryFromOutbox()
      // A prompt enqueued while a drain ran was not in that drain's snapshot.
    } while (rounds < 5 && this.deps.outbox.entriesFor(this.outboxKey, this.deps.accountScope).some((entry) => entry.attempts === 0 && entry.lastError === null))
    // The host control reads whether a prompt still waits (`hasUnsentPrompts`).
    this.flush(true)
  }

  /** Prompts this device holds that the host has not taken yet. */
  get hasUnsentPrompts(): boolean {
    return this.deps.outbox.entriesFor(this.outboxKey, this.deps.accountScope).length > 0
  }

  /**
   * The conversation opened on this host: when another host has a newer turn,
   * or the person just chose this host, this host starts a sync now, so the
   * next prompt does not wait for it (plan §10). A host that is current already
   * shows its own history.
   */
  private async prepareRunHost(): Promise<void> {
    const result = await this.deps.runHosts?.opened(this.run.sessionId, this.hostId, this.target.movedFrom ?? null)
    if (result?.state === 'current') this.adoptHostHistory()
  }

  /** This host is current: the carried transcript, the empty cloud
   *  conversation, or the refused copy gives way to the host's own history,
   *  read in the folder where the host keeps the session. */
  private adoptHostHistory(): void {
    if ((!this.carried && !this.awaitsHostCopy && !this.reloadsWhenCurrent) || this.closed) return
    this.carried = null
    if (this.reloadsWhenCurrent) {
      this.reloadsWhenCurrent = false
      this.isSessionDiverged = false
    }
    void this.load()
  }

  private syncDeliveryFromOutbox(): void {
    for (const entry of this.deps.outbox.entriesFor(this.outboxKey, this.deps.accountScope)) {
      if ((entry.lastError || entry.attempts) && this.pendingText?.messageId === entry.clientPromptId) this.presentPendingText()
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

  private attachmentAccessCheck(): () => void {
    const { sessionGeneration } = this.deps.connection.state
    const { serverUrl } = this.deps.connection.transport
    const organizationId = this.deps.organizationId()
    return () => {
      if (this.closed || !this.mayDrive || organizationId !== this.deps.organizationId()
        || serverUrl !== this.deps.connection.transport.serverUrl
        || sessionGeneration !== this.deps.connection.state.sessionGeneration) {
        throw new Error('The session connection changed before the attachment could upload.')
      }
    }
  }

  /** The folders the session works in besides its working directory (`session_folders`). */
  get sessionFolders(): readonly SessionFolder[] {
    return this.model.sessionFolders
  }

  /** The session works in a task folder: each repository of it is the session's own worktree (docs/plans/codebases.md §7). */
  get worksInTaskFolder(): boolean {
    return isTaskFolderPath(this.run.workingDirectory)
  }

  /** Read the folders again. The event gives each later change. An older host has no folders. */
  async refreshSessionFolders(): Promise<void> {
    if (!this.started) return
    const sessionId = this.run.sessionId
    try {
      this.applySessionFolders(sessionId, await this.deps.connection.api.sessionFolders(sessionId))
    } catch {
      // The list stays as the last event gave it.
    }
  }

  /** A person attaches a folder: no card (docs/plans/codebases.md §6). An observed folder becomes a granted one. */
  async attachFolder(path: string): Promise<void> {
    await this.changeSessionFolders((api, sessionId) => api.sessionAttachFolder(sessionId, path))
  }

  async detachFolder(path: string): Promise<void> {
    await this.changeSessionFolders((api, sessionId) => api.sessionDetachFolder(sessionId, path))
  }

  /** A worktree of one more repository, on the branch of the session. The host accepts only a path from `worktreeCandidates`. */
  async addRepositoryWorktree(repositoryPath: string): Promise<void> {
    await this.changeSessionFolders((api, sessionId) => api.sessionAddRepositoryWorktree(sessionId, repositoryPath))
  }

  /** The repositories that can get a worktree in the task folder of the session. Empty for a session that is not in one. */
  worktreeCandidates(): Promise<CodebaseMember[]> {
    return this.deps.connection.api.sessionWorktreeCandidates(this.run.sessionId)
  }

  /** "Track with Git" for a plain session folder. The host then sends the folders again with the state `git`. */
  async trackFolderWithGit(path: string): Promise<void> {
    if (!this.mayDrive) throw new Error('You cannot change this session.')
    await this.deps.connection.api.gitInitRepository(path)
    await this.refreshSessionFolders()
  }

  private async changeSessionFolders(change: (api: SolusAPI, sessionId: string) => Promise<SessionFolder[]>): Promise<void> {
    if (!this.started || !this.mayDrive) throw new Error('You cannot change the folders of this session.')
    const sessionId = this.run.sessionId
    this.applySessionFolders(sessionId, await change(this.deps.connection.api, sessionId))
  }

  private applySessionFolders(sessionId: string, folders: SessionFolder[]): void {
    if (this.closed || this.run.sessionId !== sessionId) return
    this.model.sessionFolders = folders
    this.flush(true)
  }

  /** The context of a Git call about one session folder. */
  folderContext(folder: Pick<SessionFolder, 'path' | 'repositoryPath'>) {
    return sessionFolderContext(this.context(), folder)
  }

  readTurnDiff = (index: number) => this.deps.connection.api.diff(this.context(), { scope: { kind: 'turn', index } })

  context() {
    this.run.status = this.model.status
    this.run.organizationId = this.deps.organizationId()
    return conversationContext(this.run)
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
    const metadata = await api.generateSessionMetadata(prompt, this.run.workingDirectory, { sessionId: agentSessionId }).catch(() => null)
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
      projectRoot: record.projectRoot ?? null,
      codebaseId: record.codebaseId ?? null,
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
