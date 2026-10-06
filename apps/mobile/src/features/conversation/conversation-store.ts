import type { AgentId, AgentMetadata, PermissionMode, RateLimitInfo, ReasoningEffort, SessionStatus } from '@solus/contracts/types'
import type { SessionQueueSnapshot } from '@solus/contracts/session-queue'
import { Listeners } from '../../lib/listeners'
import { ConversationController, type ConversationDeps, type ConversationPhase, type ConversationTarget } from './conversation-controller'
import type { UploadedAttachment } from './lib/attachments'
import type { AgentCapabilities } from './lib/run-settings'
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
  pendingPlan: Extract<TranscriptItem, { kind: 'plan' }> | null
  /** Plans of sessions this one sent work to, waiting on its decision. */
  agentPlans: readonly AgentPlanAwaiting[]
  /** Uploaded and waiting for the next prompt, and how many are still uploading. */
  attachments: readonly UploadedAttachment[]
  uploading: number
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
  private metaSnapshot: ConversationMeta
  /** Where the reader was, kept across a remount (rotation, a split resize). */
  scrollOffset = 0
  readerAtEnd = true

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
      pendingPlan: model.pendingPlan(),
      agentPlans: model.agentPlans.awaiting(),
      attachments: this.controller.attachments,
      uploading: this.controller.uploading,
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
