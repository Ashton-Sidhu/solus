import {
  ackOutboxOps,
  applyOutboxOps,
  listOutboxOps,
  markOutboxOpsFailed,
} from '../../outbox/outbox-store'
import type { SolusServer } from '../server'

/**
 * The host outbox over RPC (ADR-0007). `outboxList`/`outboxAck` face this host
 * as the *recorder*; `outboxApply` faces it as the *owner*. The draining client
 * connects the two: list here, apply on the owner host, ack back here — and
 * report permanent failures so they dead-letter instead of redelivering.
 */
export function registerOutboxHandlers(server: SolusServer): void {
  server.register('outboxList', () => listOutboxOps())

  server.register('outboxAck', (args) => {
    const [appliedIds, failures] = args
    ackOutboxOps(appliedIds)
    markOutboxOpsFailed(failures ?? [])
  })

  server.register('outboxApply', (args) => {
    const [ops] = args
    return applyOutboxOps(ops)
  })
}
