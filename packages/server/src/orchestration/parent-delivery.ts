import { formatParentPrompt, type OrchestrationItem } from '@solus/contracts/session-exchange'
import type { PromptDelivery } from '@solus/contracts/types'
import { createLogger } from '../logger'

const log = createLogger('orchestration', 'parent-delivery.ts')

/**
 * Everything the orchestrator puts in front of a parent's model: reports when a
 * child's turn ends and notices when a child needs a person or is blocked.
 *
 * An idle parent is woken at once. Items that arrive while the parent is busy
 * merge into the one prompt already waiting in its queue, so it wakes once for
 * all of them. A notice that goes stale before the parent reads it — the
 * question was answered, the limit ended — is taken out of that prompt again,
 * so a parent never acts on something that is already over. Delivery to one
 * parent is serialized, so a merge never races the prompt it merges into.
 */

export interface ParentDeliveryRuntime {
  sessionIdFor(id: string): string | undefined
  promptSession(
    agentSessionId: string,
    prompt: string,
    delivery: PromptDelivery,
    order: { via: 'session-report'; agentSessionId: string; agentMessageId: string },
  ): Promise<{ disposition: 'started' | 'steered' | 'queued'; queueId?: string }>
  replaceQueuedPrompt(sessionId: string, queueId: string, text: string): boolean
  hasQueuedPrompt(sessionId: string, queueId: string): boolean
  cancelQueuedPrompt(agentSessionId: string, queueId: string): boolean
  trackWork<T>(work: Promise<T>): Promise<T>
}

export interface DeliveryEntry {
  item: OrchestrationItem
  exchangeId: string
  targetAgentSessionId: string
  /** Names a notice so it can be withdrawn while it still waits. Reports have none. */
  noticeKey?: string
}

interface Outbox {
  /** The queued prompt later items merge into, while it still waits. */
  queueId: string
  entries: DeliveryEntry[]
}

export class ParentDelivery {
  /** Parent provider thread → the prompt waiting in its queue. */
  private readonly outboxes = new Map<string, Outbox>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(private readonly runtime: ParentDeliveryRuntime) {}

  /** Puts an item in front of the parent. `entry` may still be resolving its
   *  facts; items reach the parent in the order they were delivered. */
  deliver(parentAgentSessionId: string, entry: DeliveryEntry | Promise<DeliveryEntry>): void {
    this.serialize(parentAgentSessionId, async () => {
      const resolved = await entry
      const outbox = this.waitingOutbox(parentAgentSessionId)
      if (outbox) {
        const parentSessionId = this.runtime.sessionIdFor(parentAgentSessionId)!
        const entries = [...outbox.entries, resolved]
        if (this.runtime.replaceQueuedPrompt(parentSessionId, outbox.queueId, promptFor(entries))) {
          outbox.entries = entries
          log.info('session_report_merged', { parentAgentSessionId, exchangeId: resolved.exchangeId, items: entries.length })
          return
        }
      }
      const result = await this.runtime.promptSession(parentAgentSessionId, promptFor([resolved]), 'queue', {
        via: 'session-report',
        agentSessionId: resolved.targetAgentSessionId,
        agentMessageId: resolved.exchangeId,
      })
      log.info('session_report_dispatched', { parentAgentSessionId, exchangeId: resolved.exchangeId, kind: resolved.item.type, disposition: result.disposition })
      if (result.disposition === 'queued' && result.queueId) {
        this.outboxes.set(parentAgentSessionId, { queueId: result.queueId, entries: [resolved] })
      } else {
        this.outboxes.delete(parentAgentSessionId)
      }
    })
  }

  /** Takes a notice back out of the parent's waiting prompt. A notice the parent
   *  already read stays read; the report that follows says how it ended. */
  withdraw(parentAgentSessionId: string, noticeKey: string): void {
    this.serialize(parentAgentSessionId, async () => {
      const outbox = this.waitingOutbox(parentAgentSessionId)
      if (!outbox || !outbox.entries.some((entry) => entry.noticeKey === noticeKey)) return
      const entries = outbox.entries.filter((entry) => entry.noticeKey !== noticeKey)
      if (entries.length === 0) {
        if (this.runtime.cancelQueuedPrompt(parentAgentSessionId, outbox.queueId)) this.outboxes.delete(parentAgentSessionId)
      } else if (this.runtime.replaceQueuedPrompt(this.runtime.sessionIdFor(parentAgentSessionId)!, outbox.queueId, promptFor(entries))) {
        outbox.entries = entries
      }
      log.info('session_notice_withdrawn', { parentAgentSessionId, noticeKey, remaining: entries.length })
    })
  }

  /** Reports that wait in the parent's queue, by the exchange they settle. */
  waitingReports(parentAgentSessionId: string): Array<{ exchangeId: string; targetAgentSessionId: string }> {
    const outbox = this.waitingOutbox(parentAgentSessionId)
    return outbox
      ? outbox.entries.filter((entry) => entry.item.type === 'report').map(({ exchangeId, targetAgentSessionId }) => ({ exchangeId, targetAgentSessionId }))
      : []
  }

  /** The parent's queued prompt, while it still waits to run. */
  private waitingOutbox(parentAgentSessionId: string): Outbox | undefined {
    const outbox = this.outboxes.get(parentAgentSessionId)
    const parentSessionId = this.runtime.sessionIdFor(parentAgentSessionId)
    if (!outbox || !parentSessionId || !this.runtime.hasQueuedPrompt(parentSessionId, outbox.queueId)) return undefined
    return outbox
  }

  private serialize(parentAgentSessionId: string, work: () => Promise<void>): void {
    const previous = this.chains.get(parentAgentSessionId) ?? Promise.resolve()
    const next = previous.then(work).catch((error) => {
      log.warn('session_report_failed', { parentAgentSessionId, error: String(error) })
    })
    this.chains.set(parentAgentSessionId, next)
    void this.runtime.trackWork(next).finally(() => {
      if (this.chains.get(parentAgentSessionId) === next) this.chains.delete(parentAgentSessionId)
    })
  }
}

function promptFor(entries: readonly DeliveryEntry[]): string {
  return formatParentPrompt(entries.map((entry) => entry.item))
}
