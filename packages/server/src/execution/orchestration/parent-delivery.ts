import { formatParentPrompt, type OrchestrationItem } from '@solus/contracts/session-exchange'
import { type PromptDelivery } from '@solus/contracts/types'
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
 *
 * This class owns delivery retries while the host runs. A submission that
 * fails on a known transient error is tried again after a growing delay, a
 * bounded number of times. After the last try the report stays pending in the
 * run ledger, and restart recovery delivers it.
 */

/** Waits before each retry of a failed submission; the count bounds the retries. */
export const DELIVERY_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000] as const

/** Runs `retry` after `delayMs`. Tests inject their own clock. */
export type RetrySchedule = (delayMs: number, retry: () => void) => void

const scheduleRetry: RetrySchedule = (delayMs, retry) => {
  // A pending retry does not keep the host process alive.
  setTimeout(retry, delayMs).unref()
}

const TRANSIENT_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOSPC'])

/** A failure a later attempt can get past: busy or full storage, or a locked
 *  database. */
export function isTransientDeliveryError(error: Error): boolean {
  if ('code' in error && TRANSIENT_CODES.has(String(error.code))) return true
  return /database (table )?is locked|disk I\/O error/i.test(error.message)
}

export interface ParentDeliveryRuntime {
  promptSession(
    sessionId: string,
    prompt: string,
    delivery: PromptDelivery,
    order: { via: 'session-report'; exchangeIds?: string[]; reportExchangeIds?: string[] },
  ): Promise<{ disposition: 'started' | 'steered' | 'queued'; queueId?: string }>
  replaceQueuedPrompt(sessionId: string, queueId: string, text: string, reportExchangeIds?: string[], exchangeIds?: string[]): boolean
  hasQueuedPrompt(sessionId: string, queueId: string): boolean
  cancelQueuedPrompt(sessionId: string, queueId: string): boolean
  trackWork<T>(work: Promise<T>): Promise<T>
}

export interface DeliveryEntry {
  item: OrchestrationItem
  exchangeId: string
  targetSessionId: string
  /** Names a notice so it can be withdrawn while it still waits. Reports have none. */
  noticeKey?: string
  continuationExchangeIds?: string[]
  /** Wait without waking the parent, until a later delivery or `release`. */
  hold?: boolean
}

interface Outbox {
  /** The queued prompt later items merge into, while it still waits. */
  queueId: string
  entries: DeliveryEntry[]
}

export class ParentDelivery {
  /** Parent session → the prompt waiting in its queue. */
  private readonly outboxes = new Map<string, Outbox>()
  /** Parent session → reports held until the parent is woken. */
  private readonly held = new Map<string, DeliveryEntry[]>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(
    private readonly runtime: ParentDeliveryRuntime,
    private readonly recordDelivery: (exchangeIds: string[], state: 'queued' | 'accepted' | 'disposed', queueId?: string) => void,
    private readonly schedule: RetrySchedule = scheduleRetry,
  ) {}

  /** Reattach reports to an existing held queue entry; never enqueue a copy. */
  restore(parentSessionId: string, queueId: string, entries: DeliveryEntry[]): void {
    this.outboxes.set(parentSessionId, { queueId, entries })
  }

  /** Puts an item in front of the parent. `entry` may still be resolving its
   *  facts, and resolves to null when the parent is not to hear it; items
   *  reach the parent in the order they were delivered. */
  deliver(parentSessionId: string, entry: DeliveryEntry | null | Promise<DeliveryEntry | null>): void {
    this.serialize(parentSessionId, async () => {
      const resolved = await entry
      if (!resolved) return
      if (resolved.hold) {
        this.held.set(parentSessionId, [...this.held.get(parentSessionId) ?? [], resolved])
        log.info('session_report_held', { parentSessionId, exchangeId: resolved.exchangeId })
        return
      }
      await this.putOrRetry(parentSessionId, [...this.takeHeld(parentSessionId), resolved], 0)
    })
  }

  /** Wakes the parent with the reports held for it, if any. */
  release(parentSessionId: string): void {
    this.serialize(parentSessionId, async () => {
      const entries = this.takeHeld(parentSessionId)
      if (entries.length) await this.putOrRetry(parentSessionId, entries, 0)
    })
  }

  /** Forgets the reports held for a parent that stopped waiting. */
  dropHeld(parentSessionId: string): void {
    this.serialize(parentSessionId, async () => {
      const dropped = this.takeHeld(parentSessionId)
      this.recordDelivery(reportIds(dropped), 'disposed')
      if (dropped.length) log.info('session_reports_dropped', { parentSessionId, items: dropped.length })
    })
  }

  /** Takes a notice back out of the parent's waiting prompt. A notice the parent
   *  already read stays read; the report that follows says how it ended. */
  withdraw(parentSessionId: string, noticeKey: string): void {
    this.serialize(parentSessionId, async () => {
      const outbox = this.waitingOutbox(parentSessionId)
      if (!outbox || !outbox.entries.some((entry) => entry.noticeKey === noticeKey)) return
      const entries = outbox.entries.filter((entry) => entry.noticeKey !== noticeKey)
      if (entries.length === 0) {
        if (this.runtime.cancelQueuedPrompt(parentSessionId, outbox.queueId)) this.outboxes.delete(parentSessionId)
      } else if (this.runtime.replaceQueuedPrompt(parentSessionId, outbox.queueId, promptFor(entries), reportIds(entries), continuationIds(entries))) {
        outbox.entries = entries
      }
      log.info('session_notice_withdrawn', { parentSessionId, noticeKey, remaining: entries.length })
    })
  }

  /** Reports that wait in the parent's queue, by the exchange they settle. */
  waitingReports(parentSessionId: string): Array<{ exchangeId: string; targetSessionId: string }> {
    const entries = [...this.held.get(parentSessionId) ?? [], ...this.waitingOutbox(parentSessionId)?.entries ?? []]
    return entries.filter((entry) => entry.item.type === 'report').map(({ exchangeId, targetSessionId }) => ({ exchangeId, targetSessionId }))
  }

  /** Puts `entries`, and schedules the next try when a transient error stops it. */
  private async putOrRetry(parentSessionId: string, entries: DeliveryEntry[], attempt: number): Promise<void> {
    try {
      await this.put(parentSessionId, entries)
    } catch (error) {
      const delayMs = DELIVERY_RETRY_DELAYS_MS[attempt]
      if (delayMs === undefined || !(error instanceof Error) || !isTransientDeliveryError(error)) throw error
      log.warn('session_report_retry_scheduled', { parentSessionId, attempt: attempt + 1, delayMs, error: String(error) })
      this.schedule(delayMs, () => this.serialize(parentSessionId, () => this.putOrRetry(parentSessionId, entries, attempt + 1)))
    }
  }

  /** Merges `entries` into the parent's waiting prompt, or wakes it with them. */
  private async put(parentSessionId: string, entries: DeliveryEntry[]): Promise<void> {
    const last = entries.at(-1)!
    const outbox = this.waitingOutbox(parentSessionId)
    if (outbox) {
      const merged = [...outbox.entries, ...entries]
      if (this.runtime.replaceQueuedPrompt(parentSessionId, outbox.queueId, promptFor(merged), reportIds(merged), continuationIds(merged))) {
        outbox.entries = merged
        this.recordDelivery(reportIds(entries), 'queued', outbox.queueId)
        log.info('session_report_merged', { parentSessionId, exchangeId: last.exchangeId, items: merged.length })
        return
      }
    }
    const result = await this.runtime.promptSession(parentSessionId, promptFor(entries), 'queue', {
      via: 'session-report',
      reportExchangeIds: reportIds(entries),
      exchangeIds: continuationIds(entries),
    })
    log.info('session_report_dispatched', { parentSessionId, exchangeId: last.exchangeId, kind: last.item.type, items: entries.length, disposition: result.disposition })
    this.recordDelivery(reportIds(entries), result.disposition === 'queued' ? 'queued' : 'accepted', result.queueId)
    if (result.disposition === 'queued' && result.queueId) {
      this.outboxes.set(parentSessionId, { queueId: result.queueId, entries })
    } else {
      this.outboxes.delete(parentSessionId)
    }
  }

  private takeHeld(parentSessionId: string): DeliveryEntry[] {
    const entries = this.held.get(parentSessionId) ?? []
    this.held.delete(parentSessionId)
    return entries
  }

  /** The parent's queued prompt, while it still waits to run. */
  private waitingOutbox(parentSessionId: string): Outbox | undefined {
    const outbox = this.outboxes.get(parentSessionId)
    if (!outbox || !this.runtime.hasQueuedPrompt(parentSessionId, outbox.queueId)) return undefined
    return outbox
  }

  private serialize(parentSessionId: string, work: () => Promise<void>): void {
    const previous = this.chains.get(parentSessionId) ?? Promise.resolve()
    const next = previous.then(work).catch((error) => {
      log.warn('session_report_failed', { parentSessionId, error: String(error) })
    })
    this.chains.set(parentSessionId, next)
    void this.runtime.trackWork(next).finally(() => {
      if (this.chains.get(parentSessionId) === next) this.chains.delete(parentSessionId)
    })
  }
}

function promptFor(entries: readonly DeliveryEntry[]): string {
  return formatParentPrompt(entries.map((entry) => entry.item))
}

function reportIds(entries: readonly DeliveryEntry[]): string[] {
  return entries.filter((entry) => entry.item.type === 'report').map((entry) => entry.exchangeId)
}

function continuationIds(entries: readonly DeliveryEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.continuationExchangeIds ?? []))]
}
