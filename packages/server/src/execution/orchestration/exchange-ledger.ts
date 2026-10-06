import { createHash, randomUUID } from 'node:crypto'
import { formatSessionReport, parseOrchestrationItems, type SessionReport } from '@solus/contracts/session-exchange'
import type { DeliveryState, RunLedger, SavedExchange } from '../../data/sessions/run-ledger'
import { applyExchangeEvent, isOpenExchange, type Exchange, type ExchangeEvent } from './exchange'

export interface ExchangeIdentity {
  exchangeId: string
  fingerprint?: string
  existing?: Exchange
}

function reportFrom(text: string | undefined): SessionReport | undefined {
  if (!text) return undefined
  const item = parseOrchestrationItems(text)?.[0]
  if (item?.type !== 'report') throw new Error('Invalid saved session report.')
  return item.report
}

/** Stored receipts are the source for retries, restart recovery, and request
 * dependencies. Timers and provider permission callbacks remain in memory.
 *
 * The ledger owns every durable change to an exchange. A command writes the
 * changed record first and changes memory only when the write succeeds, so a
 * failed write never leaves memory ahead of disk. */
export class ExchangeLedger {
  readonly exchanges = new Map<string, Exchange>()
  readonly restoredExchangeIds = new Set<string>()

  constructor(private readonly store?: RunLedger) {
    for (const record of store?.loadExchanges() ?? []) {
      this.restoredExchangeIds.add(record.exchangeId)
      const { outputsText, reportText, reply, ...fields } = record
      const report = reportFrom(reportText)
      // The report text keeps a bounded reply; the full one is saved apart.
      if (report && reply !== undefined) report.reply = reply
      this.exchanges.set(record.exchangeId, {
        ...fields, outputs: reportFrom(outputsText)?.outputs ?? [], report,
        notices: [], revising: false,
      })
    }
    // A queued prompt that carries reports took over their delivery in its own
    // committed transaction. Memory follows it.
    store?.onReportsQueued((exchangeIds, queueId) => {
      for (const exchangeId of exchangeIds) {
        const exchange = this.exchanges.get(exchangeId)
        if (!exchange) continue
        exchange.deliveryState = 'queued'
        exchange.deliveryQueueId = queueId
      }
    })
  }

  /** Adds a new exchange once its record is written. */
  open(exchange: Exchange): void {
    this.store?.saveExchanges([record(exchange)])
    this.exchanges.set(exchange.exchangeId, exchange)
  }

  /** Changes one exchange through `change`, which returns false to make no
   *  change. The draft is written first; memory takes it only on success. */
  update(exchange: Exchange, change: (draft: Exchange) => boolean | void): boolean {
    const draft = draftOf(exchange)
    if (change(draft) === false) return false
    this.commit([[exchange, draft]])
    return true
  }

  /** Applies one lifecycle event; false when it does not apply. */
  apply(exchange: Exchange, event: ExchangeEvent): boolean {
    return this.update(exchange, (draft) => applyExchangeEvent(draft, event))
  }

  /** Moves report delivery forward for every named exchange in one write. A
   *  disposed report stays disposed; an accepted one can only be disposed. */
  markDelivery(exchangeIds: readonly string[], state: Exclude<DeliveryState, 'pending'>, queueId?: string): void {
    const changes: Array<[Exchange, Exchange]> = []
    for (const exchangeId of exchangeIds) {
      const exchange = this.exchanges.get(exchangeId)
      if (!exchange || exchange.deliveryState === 'disposed') continue
      if (exchange.deliveryState === 'accepted' && state !== 'disposed') continue
      const deliveryQueueId = state === 'queued' ? queueId : undefined
      if (exchange.deliveryState === state && exchange.deliveryQueueId === deliveryQueueId) continue
      const draft = draftOf(exchange)
      draft.deliveryState = state
      draft.deliveryQueueId = deliveryQueueId
      changes.push([exchange, draft])
    }
    if (changes.length) this.commit(changes)
  }

  /** A retry key belongs to the stable calling session. Wait duration is not
   * part of the request: a retry may choose to wait for the same work. */
  identify(senderSessionId: string | undefined, requestId: string | undefined, content: string): ExchangeIdentity {
    if (!requestId) return { exchangeId: randomUUID() }
    if (!senderSessionId) throw new Error('A request_id requires an initialized calling session.')
    const exchangeId = createHash('sha256').update(JSON.stringify([senderSessionId, requestId])).digest('hex')
    const fingerprint = createHash('sha256').update(content).digest('hex')
    const existing = this.exchanges.get(exchangeId)
    if (existing && existing.fingerprint !== fingerprint) throw new Error('request_id was already used for different work.')
    return { exchangeId, fingerprint, existing }
  }

  isAncestor(parentExchangeIds: readonly string[], targetSessionId: string | undefined): boolean {
    const pending = [...parentExchangeIds]
    const seen = new Set<string>()
    for (const exchangeId of pending) {
      if (seen.has(exchangeId)) continue
      seen.add(exchangeId)
      const exchange = this.exchanges.get(exchangeId)
      if (!exchange || !isOpenExchange(exchange)) continue
      if (exchange.senderSessionId === targetSessionId) return true
      pending.push(...exchange.parentExchangeIds ?? [])
    }
    return false
  }

  hasChildren(parentExchangeId: string): boolean {
    for (const exchange of this.exchanges.values()) {
      if (!exchange.notify || !exchange.parentExchangeIds?.includes(parentExchangeId)) continue
      if (isOpenExchange(exchange) || exchange.deliveryState === 'pending' || exchange.deliveryState === 'queued') return true
    }
    return false
  }

  read(senderSessionId: string, exchangeId: string): Exchange | undefined {
    const exchange = this.exchanges.get(exchangeId)
    return exchange?.senderSessionId === senderSessionId ? exchange : undefined
  }

  private commit(changes: ReadonlyArray<readonly [Exchange, Exchange]>): void {
    this.store?.saveExchanges(changes.map(([, draft]) => record(draft)))
    for (const [exchange, draft] of changes) {
      const { wait: _wait, ...fields } = draft
      Object.assign(exchange, fields)
    }
  }
}

/** A copy a command may change freely. The waiting tool call is not copied:
 *  it stays with the live exchange. */
function draftOf(exchange: Exchange): Exchange {
  const { wait: _wait, ...fields } = exchange
  return { ...fields, outputs: [...exchange.outputs], notices: [...exchange.notices] }
}

function record(exchange: Exchange): SavedExchange {
  return {
    exchangeId: exchange.exchangeId, kind: exchange.kind,
    senderSessionId: exchange.senderSessionId, senderAgentSessionId: exchange.senderAgentSessionId,
    targetSessionId: exchange.targetSessionId, targetAgentSessionId: exchange.targetAgentSessionId,
    provider: exchange.provider, notify: exchange.notify, state: exchange.state, runId: exchange.runId,
    parentExchangeIds: exchange.parentExchangeIds ?? [], fingerprint: exchange.fingerprint,
    disposition: exchange.disposition, dispatchedAt: exchange.dispatchedAt, settledAt: exchange.settledAt,
    outcome: exchange.outcome, deliveryState: exchange.deliveryState, deliveryQueueId: exchange.deliveryQueueId,
    outputsText: formatSessionReport({
      messageId: exchange.exchangeId, agentSessionId: exchange.targetAgentSessionId,
      status: exchange.outcome ?? 'completed', outputs: exchange.outputs, reply: '',
    }),
    reportText: exchange.report ? formatSessionReport(exchange.report) : undefined,
    reply: exchange.report?.reply,
  }
}
