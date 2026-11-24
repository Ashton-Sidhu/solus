import type { AgentId, AgentMetadata, PermissionMode, RateLimitInfo, ReasoningEffort, SessionStarterFromHost, SessionStatus } from '@solus/contracts/types'
import type { SessionQueueSnapshot } from '@solus/contracts/session-queue'
import type { WorkPolicy } from '@solus/contracts/host-policies'
import { setupActivityLabel } from '@solus/contracts/setup-card'
import type { SessionCloudReadStatus } from '@solus/client-core/session-cloud-read'
import type { SessionFolder } from '@solus/contracts/codebases'
import { Listeners } from '../../lib/listeners'
import { ConversationController, type ConversationDeps, type ConversationPhase, type ConversationTarget } from './conversation-controller'
import type { UploadedAttachment } from './lib/attachments'
import type { AgentCapabilities } from './lib/run-settings'
import { isHandoffPending } from './lib/provider-handoff'
import type { AgentPlanAwaiting } from './lib/agent-plans'
import type { PendingPermission, PendingQuestion, QueuedPrompt, TranscriptItem } from './lib/transcript-model'

/**
 * React's view of one conversation, in three slices: the row order, each row,
 * and the chrome around them (`ConversationMeta`). A streamed token notifies
 * one row's listeners only, at most once per display frame; the list and
 * the composer do not re-render for text alone.
 */

export interface ConversationMeta {
  phase: ConversationPhase
  status: SessionStatus
  canStopTurn: boolean
  /** Background work of the session runs, held or not. */
  backgroundWorkRunning: boolean
  permissions: readonly PendingPermission[]
  questions: readonly PendingQuestion[]
  rateLimit: RateLimitInfo | null
  queued: readonly QueuedPrompt[]
  queue: SessionQueueSnapshot
  /** Prompts this device holds that the host has not taken yet: the run host stays as it is. */
  hasUnsentPrompts: boolean
  hasOlder: boolean
  historyError: string | null
  loadingOlder: boolean
  /** The agent session on another host that started this one. */
  startedBy: SessionStarterFromHost | null
  pendingPlan: Extract<TranscriptItem, { kind: 'plan' }> | null
  /** The setup step that runs now, as the status pill says it. */
  setupStep: string | null
  /** Plans of sessions this one sent work to, waiting on its decision. */
  agentPlans: readonly AgentPlanAwaiting[]
  /** Uploaded and waiting for the next prompt, and how many are still uploading. */
  attachments: readonly UploadedAttachment[]
  pendingVideos: ConversationController['pendingVideos']
  pendingImages: ConversationController['pendingImages']
  uploading: number
  /** The picked provider differs from the thread's: the next prompt hands off (plans/021). */
  handoffPending: boolean
  /** The host refused a prompt: another host continued the session (`SESSION_DIVERGED`). */
  isSessionDiverged: boolean
  /** The read of the session's copy from Solus Cloud (`ConversationController.readCloudHistory`). */
  cloudRead: SessionCloudReadStatus
  /** A host gave the rows that show, so no copy from the cloud is read. */
  showsHostConversation: boolean
  /** The run host answered that it has no copy of the session. */
  hostHasNoCopy: boolean
  /** The folders the session works in besides its working directory (docs/plans/codebases.md §6). */
  sessionFolders: readonly SessionFolder[]
  /** What the next prompt runs with. */
  run: { workingDirectory: string; title: ConversationController['run']['title']; provider: AgentId; model: string | null; reasoningEffort: ReasoningEffort; fastMode: boolean; permissionMode: PermissionMode; worktreeBaseBranch: string | null; checkoutBranch: string | null; checkoutWorktree: string | null; projectRoot: string; projectDirectory: string; codebaseId: string | null; isCodebasePicked: boolean; worktreeRepositories: readonly string[] | null }
  /** What the next prompt may choose: Auto before the host starts the
   *  session, and the permission modes the agent's host reports. */
  runOptions: {
    canRoute: boolean
    /** A new worktree may still change (`ConversationController.canChooseStart`). */
    canChooseStart: boolean
    autoNeedsKey: boolean
    capabilities: AgentCapabilities
    agents: readonly AgentMetadata[] | null
    /** What the work's policy allows on its host (plans/030 §7): the pickers disable the rest, with the reason. */
    policy: WorkPolicy
  }
}

export class ConversationStore {
  readonly controller: ConversationController
  readonly order = new Listeners()
  readonly meta = new Listeners()
  private readonly feedListeners = new Set<(ids: readonly string[]) => void>()
  private readonly itemListeners = new Map<string, Set<() => void>>()
  private readonly quoteListeners = new Set<(text: string) => void>()
  private readonly remarkListeners = new Set<(remarks: readonly string[]) => void>()
  private readonly hostChoiceListeners = new Set<() => void>()
  private metaSnapshot: ConversationMeta
  private readonly pendingItemIds = new Set<string>()
  private itemFrame: number | null = null
  /** Where the reader was, kept across a remount (rotation, a split resize). */
  scrollOffset = 0
  readerAtEnd = true
  readonly closedMcpApps = new Set<string>()
  readonly mcpAppHeights = new Map<string, number>()
  /** The context each app gave the agent, as the person can read it, by activity. */
  readonly mcpAppContexts = new Map<string, string>()
  /**
   * The one saved app docked above the composer in picture-in-picture
   * (docs/plans/mcp-first-class.md §14.2), by activity. Its card in the feed
   * shows a line in its place.
   */
  mcpAppPip: { readonly activityId: string; readonly title: string } | null = null
  readonly mcpAppPipChanges = new Listeners()

  constructor(target: ConversationTarget, deps: Omit<ConversationDeps, 'onChange'>, private readonly frames = {
    request: (callback: () => void): number => requestAnimationFrame(callback),
    cancel: (frame: number): void => cancelAnimationFrame(frame),
  }) {
    this.controller = new ConversationController(target, {
      ...deps,
      onChange: (changes) => {
        if (changes.order) {
          this.cancelItemFrame()
          this.pendingItemIds.clear()
          // A rebuilt model may reuse ids for different content; every row re-reads.
          for (const listeners of this.itemListeners.values()) for (const listener of Array.from(listeners)) listener()
          this.order.notify()
        } else {
          for (const id of changes.items) {
            const item = this.item(id)
            if (this.itemListeners.has(id) || (this.feedListeners.size && (item?.kind === 'assistant' || item?.kind === 'user' || item?.kind === 'tool'))) this.pendingItemIds.add(id)
            if (item?.kind !== 'tool' || !item.children) continue
            for (const childId of item.children.takeChanges().items) {
              const childKey = `${id}\0${childId}`
              if (this.itemListeners.has(childKey)) this.pendingItemIds.add(childKey)
            }
          }
          // Status and request changes show at once. Text bursts notify each
          // row once per frame, using the latest item, without dropping events.
          if (changes.meta) this.notifyItems()
          else if (this.pendingItemIds.size > 0 && this.itemFrame === null) {
            this.itemFrame = this.frames.request(() => this.notifyItems())
          }
        }
        if (changes.meta || changes.order) {
          this.metaSnapshot = this.readMeta()
          this.meta.notify()
        }
      },
    })
    this.metaSnapshot = this.readMeta()
  }

  /** Docks one app; the app docked before goes back to its card. Null gives the docked app back. */
  setMcpAppPip(next: { readonly activityId: string; readonly title: string } | null): void {
    if (next?.activityId === this.mcpAppPip?.activityId) return
    this.mcpAppPip = next
    this.mcpAppPipChanges.notify()
  }

  private cancelItemFrame(): void {
    if (this.itemFrame === null) return
    this.frames.cancel(this.itemFrame)
    this.itemFrame = null
  }

  private notifyItems(): void {
    this.cancelItemFrame()
    const ids = [...this.pendingItemIds]
    this.pendingItemIds.clear()
    if (ids.length) for (const listener of this.feedListeners) listener(ids)
    for (const id of ids) for (const listener of Array.from(this.itemListeners.get(id) ?? [])) listener()
  }

  /** A timeline receives one batch per frame. Mounted cards still observe their own items. */
  subscribeFeedItems(listener: (ids: readonly string[]) => void): () => void {
    this.feedListeners.add(listener)
    return () => { this.feedListeners.delete(listener) }
  }

  subscribeItem(id: string, listener: () => void): () => void {
    let listeners = this.itemListeners.get(id)
    if (!listeners) {
      listeners = new Set()
      this.itemListeners.set(id, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.itemListeners.delete(id)
    }
  }

  /** "Quote in reply" from a message's selection menu: the composer adds the text to its draft. */
  quoteInReply = (text: string): void => {
    for (const listener of Array.from(this.quoteListeners)) listener(text)
  }

  onQuoteInReply(listener: (text: string) => void): () => void {
    this.quoteListeners.add(listener)
    return () => { this.quoteListeners.delete(listener) }
  }

  /** A question closed without an answer: the composer adds what the user typed for it to its draft. */
  returnRemarksToDraft = (remarks: readonly string[]): void => {
    for (const listener of Array.from(this.remarkListeners)) listener(remarks)
  }

  onRemarksReturned(listener: (remarks: readonly string[]) => void): () => void {
    this.remarkListeners.add(listener)
    return () => { this.remarkListeners.delete(listener) }
  }

  /** "Choose a host" on a failed sync card: the thread opens its host choice. */
  requestHostChoice = (): void => {
    for (const listener of Array.from(this.hostChoiceListeners)) listener()
  }

  onHostChoiceRequested(listener: () => void): () => void {
    this.hostChoiceListeners.add(listener)
    return () => { this.hostChoiceListeners.delete(listener) }
  }

  orderSnapshot = (): readonly string[] => this.controller.model.order

  item(id: string): TranscriptItem | undefined {
    return this.controller.model.items.get(id)
  }

  metaSnapshotOf = (): ConversationMeta => this.metaSnapshot

  private readMeta(): ConversationMeta {
    const { model } = this.controller
    return {
      phase: this.controller.phase,
      status: model.status,
      canStopTurn: this.controller.canStopTurn,
      backgroundWorkRunning: model.backgroundWorkRunning,
      permissions: model.permissions,
      questions: model.questions,
      rateLimit: model.rateLimit,
      queued: model.queued,
      queue: this.controller.queue,
      hasUnsentPrompts: this.controller.hasUnsentPrompts,
      hasOlder: model.history.hasMoreHistory,
      historyError: model.history.error,
      loadingOlder: model.history.loading,
      startedBy: this.controller.startedBy,
      pendingPlan: model.pendingPlan(),
      setupStep: setupActivityLabel(model.activeSetupCard()),
      agentPlans: model.agentPlans.awaiting(),
      attachments: this.controller.attachments,
      pendingImages: this.controller.pendingImages,
      pendingVideos: this.controller.pendingVideos,
      uploading: this.controller.uploading,
      handoffPending: isHandoffPending(this.controller.threadProvider, this.controller.run.provider),
      isSessionDiverged: this.controller.isSessionDiverged,
      cloudRead: this.controller.cloudRead,
      showsHostConversation: this.controller.showsHostConversation,
      hostHasNoCopy: this.controller.hostHasNoCopy,
      sessionFolders: model.sessionFolders,
      run: {
        workingDirectory: this.controller.run.workingDirectory,
        title: this.controller.run.title,
        provider: this.controller.run.provider,
        model: this.controller.run.preferredModel,
        reasoningEffort: this.controller.run.reasoningEffort,
        fastMode: this.controller.run.fastMode,
        permissionMode: this.controller.run.permissionMode,
        worktreeBaseBranch: this.controller.run.worktreeBaseBranch ?? null,
        checkoutBranch: this.controller.checkoutBranch,
        checkoutWorktree: this.controller.checkoutWorktree,
        projectRoot: this.controller.projectRoot,
        projectDirectory: this.controller.projectDirectory,
        codebaseId: this.controller.run.codebaseId ?? null,
        isCodebasePicked: this.controller.isCodebasePicked,
        worktreeRepositories: this.controller.run.worktreeRepositories ?? null,
      },
      runOptions: {
        canRoute: this.controller.canRoute,
        canChooseStart: this.controller.canChooseStart,
        autoNeedsKey: this.controller.autoNeedsKey,
        capabilities: this.controller.capabilitiesOf(this.controller.run.provider),
        agents: this.controller.agents,
        policy: this.controller.policy,
      },
    }
  }

  close(): void {
    this.cancelItemFrame()
    this.pendingItemIds.clear()
    this.controller.close()
    this.itemListeners.clear()
    this.feedListeners.clear()
  }
}

/** The id a sheet route over a conversation (Settings, Queue, Agents) reopens it by. */
export function conversationIdOf(store: ConversationStore): string {
  const { record, newSession } = store.controller.target
  return record?.sessionId ?? newSession?.sessionId ?? store.controller.run.sessionId
}
