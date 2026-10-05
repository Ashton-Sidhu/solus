import type { OrchestrationItem } from '@solus/contracts/session-exchange'
import type { OrchestratedRuntime } from './session-orchestrator'
import { CHILD_INTERRUPTED_BY_RESTART } from './exchange-reports'
import { isOpenExchange, type Exchange } from './exchange'
import type { ExchangeLedger } from './exchange-ledger'
import type { ParentDelivery } from './parent-delivery'

/** Restore queued dependencies and reports before accepting new work. Provider
 * runs with an uncertain outcome are interrupted, never automatically retried. */
export function recoverExchanges(
  runtime: Pick<OrchestratedRuntime, 'queuedExchanges'>,
  ledger: ExchangeLedger,
  delivery: ParentDelivery,
  settle: (exchange: Exchange, outcome: 'interrupted', reply: string) => void,
  deliverReport: (exchange: Exchange, item: OrchestrationItem, hasReport: boolean) => void,
): void {
  const queues = runtime.queuedExchanges()
  const covered = new Set<string>()
  for (const queue of queues) {
    const entries = queue.reportExchangeIds.flatMap((exchangeId) => {
      const exchange = ledger.exchanges.get(exchangeId)
      if (!exchange?.report || !ledger.restoredExchangeIds.has(exchangeId)) return []
      covered.add(exchangeId)
      exchange.deliveryState = 'queued'
      exchange.deliveryQueueId = queue.queueId
      ledger.save(exchange)
      return [{ exchangeId, targetAgentSessionId: exchange.targetAgentSessionId,
        continuationExchangeIds: exchange.parentExchangeIds,
        item: { type: 'report' as const, report: exchange.report } }]
    })
    const sender = entries.length ? ledger.exchanges.get(entries[0]!.exchangeId)?.senderAgentSessionId : undefined
    if (sender) delivery.restore(sender, queue.queueId, entries)
  }
  for (const exchange of ledger.exchanges.values()) {
    if (!ledger.restoredExchangeIds.has(exchange.exchangeId) || !isOpenExchange(exchange)) continue
    const queued = queues.find((queue) => queue.exchangeIds.includes(exchange.exchangeId) && !queue.started)
    if (queued) {
      exchange.state = exchange.state === 'waiting_for_children' ? 'waiting_for_children' : 'queued'
      exchange.request = undefined
      ledger.save(exchange)
    } else if (exchange.state !== 'waiting_for_children' || !ledger.hasChildren(exchange.exchangeId)) {
      exchange.revising = false
      settle(exchange, 'interrupted', CHILD_INTERRUPTED_BY_RESTART)
      covered.add(exchange.exchangeId)
    }
  }
  for (const exchange of ledger.exchanges.values()) {
    if (!ledger.restoredExchangeIds.has(exchange.exchangeId) || covered.has(exchange.exchangeId) || !exchange.report || exchange.deliveryState !== 'pending' && exchange.deliveryState !== 'queued') continue
    deliverReport(exchange, { type: 'report', report: exchange.report }, true)
  }
  ledger.restoredExchangeIds.clear()
}
