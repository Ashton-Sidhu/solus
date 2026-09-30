import { formatParentPrompt, type OrchestrationItem } from '@solus/contracts/session-exchange'
import type { PromptDelivery } from '@solus/contracts/types'
import { createLogger } from '../../logger'

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
 *
 * A task's lead is not woken for each report. Its reports are held until its
 * last open message settles, and then reach it as one prompt
 * (docs/plans/task-conversation.md).
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
  /** Wait without waking the parent, until a later delivery or `release`. */
  hold?: boolean
}

interface Outbox {
  /** The queued prompt later items merge into, while it still waits. */
  queueId: string
  entries: DeliveryEntry[]
}

export class ParentDelivery {
  /** Parent provider thread → the prompt waiting in its queue. */
  private readonly outboxes = new Map<string, Outbox>()
  /** Parent provider thread → reports held until the parent is woken. */
  private readonly held = new Map<string, DeliveryEntry[]>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(private readonly runtime: ParentDeliveryRuntime) {}

  /** Puts an item in front of the parent. `entry` may still be resolving its
   *  facts, and resolves to null when the parent is not to hear it; items
   *  reach the parent in the order they were delivered. */
  deliver(parentAgentSessionId: string, entry: DeliveryEntry | null | Promise<DeliveryEntry | null>): void {
    this.serialize(parentAgentSessionId, async () => {
      const resolved = await entry
      if (!resolved) return
      if (resolved.hold) {
        this.held.set(parentAgentSessionId, [...this.held.get(parentAgentSessionId) ?? [], resolved])
        log.info('session_report_held', { parentAgentSessionId, exchangeId: resolved.exchangeId })
        return
      }
      await this.put(parentAgentSessionId, [...this.takeHeld(parentAgentSessionId), resolved])
    })
  }

  /** Wakes the parent with the reports held for it, if any. */
  release(parentAgentSessionId: string): void {
    this.serialize(parentAgentSessionId, async () => {
      const entries = this.takeHeld(parentAgentSessionId)
      if (entries.length) await this.put(parentAgentSessionId, entries)
    })
  }

  /** Forgets the reports held for a parent that stopped waiting. */
  dropHeld(parentAgentSessionId: string): void {
    this.serialize(parentAgentSessionId, async () => {
      const dropped = this.takeHeld(parentAgentSessionId)
      if (dropped.length) log.info('session_reports_dropped', { parentAgentSessionId, items: dropped.length })
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
    const entries = [...this.held.get(parentAgentSessionId) ?? [], ...this.waitingOutbox(parentAgentSessionId)?.entries ?? []]
    return entries.filter((entry) => entry.item.type === 'report').map(({ exchangeId, targetAgentSessionId }) => ({ exchangeId, targetAgentSessionId }))
  }

  /** Merges `entries` into the parent's waiting prompt, or wakes it with them. */
  private async put(parentAgentSessionId: string, entries: DeliveryEntry[]): Promise<void> {
    const last = entries.at(-1)!
    const outbox = this.waitingOutbox(parentAgentSessionId)
    if (outbox) {
      const parentSessionId = this.runtime.sessionIdFor(parentAgentSessionId)!
      const merged = [...outbox.entries, ...entries]
      if (this.runtime.replaceQueuedPrompt(parentSessionId, outbox.queueId, promptFor(merged))) {
        outbox.entries = merged
        log.info('session_report_merged', { parentAgentSessionId, exchangeId: last.exchangeId, items: merged.length })
        return
      }
    }
    const result = await this.runtime.promptSession(parentAgentSessionId, promptFor(entries), 'queue', {
      via: 'session-report',
      agentSessionId: last.targetAgentSessionId,
      agentMessageId: last.exchangeId,
    })
    log.info('session_report_dispatched', { parentAgentSessionId, exchangeId: last.exchangeId, kind: last.item.type, items: entries.length, disposition: result.disposition })
    if (result.disposition === 'queued' && result.queueId) {
      this.outboxes.set(parentAgentSessionId, { queueId: result.queueId, entries })
    } else {
      this.outboxes.delete(parentAgentSessionId)
    }
  }

  private takeHeld(parentAgentSessionId: string): DeliveryEntry[] {
    const entries = this.held.get(parentAgentSessionId) ?? []
    this.held.delete(parentAgentSessionId)
    return entries
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
