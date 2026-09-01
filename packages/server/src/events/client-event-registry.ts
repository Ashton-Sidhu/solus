import type { HostEvent } from '@solus/contracts/host-events'
import { createLogger } from '../logger'

const log = createLogger('server', 'client-event-registry.ts')

export type ClientId = string
export type ClientEventDelivery = (event: HostEvent) => void

/** Stable client-id to transport-delivery registry. Socket details stay in the transport. */
export class ClientEventRegistry {
  private readonly deliveries = new Map<ClientId, ClientEventDelivery>()

  register(clientId: ClientId, deliver: ClientEventDelivery): () => void {
    this.deliveries.set(clientId, deliver)
    return () => {
      if (this.deliveries.get(clientId) === deliver) this.deliveries.delete(clientId)
    }
  }

  deliver(clientId: ClientId, event: HostEvent): boolean {
    const delivery = this.deliveries.get(clientId)
    if (!delivery) return false
    try {
      delivery(event)
      return true
    } catch (error) {
      log.warn('host_event_delivery_failed', {
        eventType: event.type,
        clientId,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  routableClientIds(): readonly ClientId[] {
    return [...this.deliveries.keys()]
  }
}
