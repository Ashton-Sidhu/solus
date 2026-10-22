import type { AgentId, AgentMetadata, PermissionMode, RateLimitInfo, ReasoningEffort, SessionOrigin, SessionStatus } from '@solus/contracts/types'
import type { SessionQueueSnapshot } from '@solus/contracts/session-queue'
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
 * one row's listeners only; the list and the composer do not re-render.
 */

export interface ConversationMeta {
  phase: ConversationPhase
  status: SessionStatus
  permissions: readonly PendingPermission[]
  questions: readonly PendingQuestion[]
  rateLimit: RateLimitInfo | null
  queued: readonly QueuedPrompt[]
  queue: SessionQueueSnapshot
  hasOlder: boolean
  loadingOlder: boolean
  /** The agent session on another host that started this one. */
  startedBy: SessionOrigin | null
  pendingPlan: Extract<TranscriptItem, { kind: 'plan' }> | null
  /** Plans of sessions this one sent work to, waiting on its decision. */
  agentPlans: readonly AgentPlanAwaiting[]
  /** Uploaded and waiting for the next prompt, and how many are still uploading. */
  attachments: readonly UploadedAttachment[]
  uploading: number
  /** The picked provider differs from the thread's: the next prompt hands off (plans/021). */
  handoffPending: boolean
  /** What the next prompt runs with. */
  run: { provider: AgentId; model: string | null; reasoningEffort: ReasoningEffort; fastMode: boolean; permissionMode: PermissionMode }
  /** What the next prompt may choose: Auto before the host starts the
   *  session, and the permission modes the agent's host reports. */
  runOptions: { canRoute: boolean; autoNeedsKey: boolean; capabilities: AgentCapabilities; agents: readonly AgentMetadata[] | null }
}

export class ConversationStore {
  readonly controller: ConversationController
  readonly order = new Listeners()
  readonly meta = new Listeners()
  private readonly itemListeners = new Map<string, Set<() => void>>()
  private readonly quoteListeners = new Set<(text: string) => void>()
  private readonly remarkListeners = new Set<(remarks: readonly string[]) => void>()
  private metaSnapshot: ConversationMeta
  /** Where the reader was, kept across a remount (rotation, a split resize). */
  scrollOffset = 0
  readerAtEnd = true
  readonly closedMcpApps = new Set<string>()
  readonly mcpAppHeights = new Map<string, number>()

  constructor(target: ConversationTarget, deps: Omit<ConversationDeps, 'onChange'>) {
    this.controller = new ConversationController(target, {
      ...deps,
      onChange: (changes) => {
        if (changes.order) {
          // A rebuilt model may reuse ids for different content; every row re-reads.
          for (const listeners of this.itemListeners.values()) for (const listener of Array.from(listeners)) listener()
          this.order.notify()
        } else {
          for (const id of changes.items) for (const listener of Array.from(this.itemListeners.get(id) ?? [])) listener()
          for (const id of changes.items) {
            const item = this.item(id)
            if (item?.kind !== 'tool' || !item.children) continue
            for (const childId of item.children.takeChanges().items) {
              for (const listener of Array.from(this.itemListeners.get(`${id}\0${childId}`) ?? [])) listener()
            }
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
      permissions: model.permissions,
      questions: model.questions,
      rateLimit: model.rateLimit,
      queued: model.queued,
      queue: this.controller.queue,
      hasOlder: model.olderCursor !== null,
      loadingOlder: this.controller.loadingOlder,
      startedBy: this.controller.startedBy,
      pendingPlan: model.pendingPlan(),
      agentPlans: model.agentPlans.awaiting(),
      attachments: this.controller.attachments,
      uploading: this.controller.uploading,
      handoffPending: isHandoffPending(this.controller.threadProvider, this.controller.run.provider),
      run: {
        provider: this.controller.run.provider,
        model: this.controller.run.preferredModel,
        reasoningEffort: this.controller.run.reasoningEffort,
        fastMode: this.controller.run.fastMode,
        permissionMode: this.controller.run.permissionMode,
      },
      runOptions: {
        canRoute: this.controller.canRoute,
        autoNeedsKey: this.controller.autoNeedsKey,
        capabilities: this.controller.capabilitiesOf(this.controller.run.provider),
        agents: this.controller.agents,
      },
    }
  }

  close(): void {
    this.controller.close()
    this.itemListeners.clear()
  }
}

/** The id a sheet route over a conversation (Settings, Queue, Agents) reopens it by. */
export function conversationIdOf(store: ConversationStore): string {
  const { record, newSession } = store.controller.target
  return record?.sessionId ?? newSession?.sessionId ?? store.controller.run.sessionId
}
