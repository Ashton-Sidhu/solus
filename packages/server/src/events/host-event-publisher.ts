import type { HostEvent, HostEventMap, HostEventName } from '@solus/contracts/host-events'
import { createLogger, isDebugEnabled } from '../logger'
import type { ClientId } from './client-event-registry'
import { ClientEventRegistry } from './client-event-registry'

const log = createLogger('server', 'host-event-publisher.ts')

/**
 * Hands one event to its recipients. A publish is queued on each client the
 * moment it is called, so publish order is delivery order per client; the
 * returned count settles once every recipient's audience check has run.
 */
export class HostEventPublisher {
  constructor(private readonly clients: ClientEventRegistry) {}

  publish<K extends HostEventName>(
    recipientClientId: ClientId,
    type: K,
    payload: HostEventMap[K],
  ): Promise<number>

  publish<K extends HostEventName>(
    recipientClientIds: readonly ClientId[],
    type: K,
    payload: HostEventMap[K],
  ): Promise<number>

  publish<K extends HostEventName>(
    recipient: ClientId | readonly ClientId[],
    type: K,
    payload: HostEventMap[K],
  ): Promise<number> {
    const recipientClientIds = Array.isArray(recipient) ? recipient : [recipient]
    return this.publishToRecipients(recipientClientIds, type, payload, 'publish')
  }

  broadcast<K extends HostEventName>(type: K, payload: HostEventMap[K]): Promise<number> {
    return this.publishToRecipients(this.clients.routableClientIds(), type, payload, 'broadcast')
  }

  private async publishToRecipients<K extends HostEventName>(
    recipientClientIds: readonly ClientId[],
    type: K,
    payload: HostEventMap[K],
    delivery: 'publish' | 'broadcast',
  ): Promise<number> {
    const uniqueRecipientClientIds = new Set(recipientClientIds)
    const event: HostEvent<K> = { type, payload, occurredAt: Date.now() }
    const outcomes = await Promise.all([...uniqueRecipientClientIds].map((clientId) => this.clients.deliver(clientId, event)))
    const publishedClientCount = outcomes.filter(Boolean).length

    if (isDebugEnabled()) {
      log.debug('host_event_published', {
        eventType: type,
        delivery,
        requestedClientCount: uniqueRecipientClientIds.size,
        publishedClientCount,
      })
    }
    return publishedClientCount
  }
}
