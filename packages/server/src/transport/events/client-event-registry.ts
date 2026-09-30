import type { HostEvent } from '@solus/contracts/host-events'
import { createLogger } from '../../logger'
import { RoomAdmissions } from './room-admissions'

const log = createLogger('server', 'client-event-registry.ts')

export type ClientId = string
export type ClientEventDelivery = (event: HostEvent) => void

/**
 * How a delivery is admitted: `check` runs the audience check; `decided` was
 * checked already (`admits`); `room` runs it once per member of a room and
 * remembers the pass (`RoomAdmissions`).
 */
export type DeliveryAdmission = { kind: 'check' } | { kind: 'decided' } | { kind: 'room'; room: string }

const CHECK: DeliveryAdmission = { kind: 'check' }

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
  readonly rooms = new RoomAdmissions()

  /** `audience` decides per client whether an event may reach it; absent means everyone hears everything. */
  constructor(private readonly audience?: (clientId: ClientId, event: HostEvent) => boolean | Promise<boolean>) {}

  register(clientId: ClientId, deliver: ClientEventDelivery): () => void {
    this.deliveries.set(clientId, deliver)
    return () => {
      if (this.deliveries.get(clientId) !== deliver) return
      this.deliveries.delete(clientId)
      this.rooms.forgetClient(clientId)
    }
  }

  /**
   * `decided` is an audience already decided by `admits`, for an event whose
   * audience cannot be found after its cause: a deleted resource takes its
   * grants with it. `room` checks each member once (`RoomAdmissions`); the pass
   * is recorded in the client's own queue, so event order is unchanged.
   */
  deliver(clientId: ClientId, event: HostEvent, admission: DeliveryAdmission = CHECK): Promise<boolean> {
    if (!this.deliveries.has(clientId)) return Promise.resolve(false)
    const previous = this.queues.get(clientId)
    // No delivery in flight: start at once, so the common case costs no extra turn.
    const next = previous
      ? previous.then(() => this.deliverNow(clientId, event, admission), () => this.deliverNow(clientId, event, admission))
      : this.deliverNow(clientId, event, admission)
    this.queues.set(clientId, next)
    void next.finally(() => {
      if (this.queues.get(clientId) === next) this.queues.delete(clientId)
    })
    return next
  }

  /** Whether the audience admits this event to this client now. A failed check admits nothing. */
  async admits(clientId: ClientId, event: HostEvent): Promise<boolean> {
    if (!this.audience) return true
    try {
      return await this.audience(clientId, event)
    } catch (error) {
      log.warn('host_event_audience_failed', { eventType: event.type, clientId, error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  private async deliverNow(clientId: ClientId, event: HostEvent, admission: DeliveryAdmission): Promise<boolean> {
    // Resolved after the queue's turn: a client that left while waiting hears nothing.
    const delivery = this.deliveries.get(clientId)
    if (!delivery) return false
    try {
      if (!await this.passes(clientId, event, admission)) return false
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

  private async passes(clientId: ClientId, event: HostEvent, admission: DeliveryAdmission): Promise<boolean> {
    if (admission.kind === 'decided' || !this.audience) return true
    if (admission.kind === 'room' && this.rooms.has(admission.room, clientId)) return true
    if (!await this.audience(clientId, event)) return false
    if (admission.kind === 'room') this.rooms.admit(admission.room, clientId)
    return true
  }

  routableClientIds(): readonly ClientId[] {
    return [...this.deliveries.keys()]
  }
}
