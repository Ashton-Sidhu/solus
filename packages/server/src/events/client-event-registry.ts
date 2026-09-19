import type { HostEvent } from '@solus/contracts/host-events'
import { createLogger } from '../logger'

const log = createLogger('server', 'client-event-registry.ts')

export type ClientId = string
export type ClientEventDelivery = (event: HostEvent) => void

/**
 * Stable client-id to transport-delivery registry. Socket details stay in the transport.
 *
 * The audience check reads the share list, which is a database read, so a
 * delivery is asynchronous. Events to one client are handed over in the order
 * they were published: each delivery waits for the one before it on that
 * client, so a check that takes longer never lets a later event overtake.
 */
export class ClientEventRegistry {
  private readonly deliveries = new Map<ClientId, ClientEventDelivery>()
  private readonly queues = new Map<ClientId, Promise<unknown>>()

  /** `audience` decides per client whether an event may reach it; absent means everyone hears everything. */
  constructor(private readonly audience?: (clientId: ClientId, event: HostEvent) => boolean | Promise<boolean>) {}

  register(clientId: ClientId, deliver: ClientEventDelivery): () => void {
    this.deliveries.set(clientId, deliver)
    return () => {
      if (this.deliveries.get(clientId) === deliver) this.deliveries.delete(clientId)
    }
  }

  deliver(clientId: ClientId, event: HostEvent): Promise<boolean> {
    if (!this.deliveries.has(clientId)) return Promise.resolve(false)
    const previous = this.queues.get(clientId)
    // No delivery in flight: start at once, so the common case costs no extra turn.
    const next = previous
      ? previous.then(() => this.deliverNow(clientId, event), () => this.deliverNow(clientId, event))
      : this.deliverNow(clientId, event)
    this.queues.set(clientId, next)
    void next.finally(() => {
      if (this.queues.get(clientId) === next) this.queues.delete(clientId)
    })
    return next
  }

  private async deliverNow(clientId: ClientId, event: HostEvent): Promise<boolean> {
    // Resolved after the queue's turn: a client that left while waiting hears nothing.
    const delivery = this.deliveries.get(clientId)
    if (!delivery) return false
    try {
      if (this.audience && !await this.audience(clientId, event)) return false
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
