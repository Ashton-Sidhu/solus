import type { HostEvent, HostEventMap, HostEventName } from '@solus/contracts/host-events'
import { createLogger, isDebugEnabled } from '../logger'
import type { ClientId } from './client-event-registry'
import { ClientEventRegistry } from './client-event-registry'

const log = createLogger('server', 'host-event-publisher.ts')

export class HostEventPublisher {
  constructor(private readonly clients: ClientEventRegistry) {}

  publish<K extends HostEventName>(
    recipientClientId: ClientId,
    type: K,
    payload: HostEventMap[K],
  ): number

  publish<K extends HostEventName>(
    recipientClientIds: readonly ClientId[],
    type: K,
    payload: HostEventMap[K],
  ): number

  publish<K extends HostEventName>(
    recipient: ClientId | readonly ClientId[],
    type: K,
    payload: HostEventMap[K],
  ): number {
    const recipientClientIds = Array.isArray(recipient) ? recipient : [recipient]
    return this.publishToRecipients(recipientClientIds, type, payload, 'publish')
  }

  broadcast<K extends HostEventName>(type: K, payload: HostEventMap[K]): number {
    return this.publishToRecipients(this.clients.routableClientIds(), type, payload, 'broadcast')
  }

  private publishToRecipients<K extends HostEventName>(
    recipientClientIds: readonly ClientId[],
    type: K,
    payload: HostEventMap[K],
    delivery: 'publish' | 'broadcast',
  ): number {
    const uniqueRecipientClientIds = new Set(recipientClientIds)
    const event: HostEvent<K> = { type, payload, occurredAt: Date.now() }
    let publishedClientCount = 0

    for (const clientId of uniqueRecipientClientIds) {
      if (this.clients.deliver(clientId, event)) publishedClientCount++
    }

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
