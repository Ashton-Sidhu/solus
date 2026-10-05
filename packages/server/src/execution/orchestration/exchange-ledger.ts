import { createHash, randomUUID } from 'node:crypto'
import { formatSessionReport, parseOrchestrationItems, type SessionReport } from '@solus/contracts/session-exchange'
import { SessionExchangeStore } from '../../data/sessions/session-exchange-store'
import { isOpenExchange, type Exchange } from './exchange'

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
 * dependencies. Timers and provider permission callbacks remain in memory. */
export class ExchangeLedger {
  readonly exchanges = new Map<string, Exchange>()
  readonly restoredExchangeIds = new Set<string>()

  constructor(private readonly store?: SessionExchangeStore) {
    for (const record of store?.load() ?? []) {
      this.restoredExchangeIds.add(record.exchangeId)
      const { version: _version, outputsText, reportText, ...fields } = record
      this.exchanges.set(record.exchangeId, {
        ...fields, outputs: reportFrom(outputsText)?.outputs ?? [], report: reportFrom(reportText),
        notices: [], revising: false,
      })
    }
  }

  save(exchange: Exchange): void {
    this.store?.save({
      version: 1, exchangeId: exchange.exchangeId, kind: exchange.kind,
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
    })
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
}
