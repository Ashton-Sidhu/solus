import type { HostEvent, HostEventMap, HostEventName } from '@solus/contracts/host-events'
import { createLogger, isDebugEnabled } from '../../logger'
import type { ShareResource } from '@solus/contracts/sharing'
import type { ClientId, DeliveryAdmission } from './client-event-registry'
import { ClientEventRegistry } from './client-event-registry'
import { RoomAdmissions } from './room-admissions'

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

  /**
   * Decide a broadcast's audience now and deliver it later, to exactly those
   * clients: for an event whose audience is gone once it happens. A deleted
   * work's readers can be found only while its grants still exist.
   */
  async prepareBroadcast<K extends HostEventName>(type: K, payload: HostEventMap[K]): Promise<() => Promise<number>> {
    // SAFETY: `type` and `payload` arrive as one pair `HostEventMap[K]`; the distributive `HostEvent<K>` is the same shape.
    const event = { type, payload, occurredAt: Date.now() } as HostEvent<K>
    const clientIds = this.clients.routableClientIds()
    const admitted = await Promise.all(clientIds.map((clientId) => this.clients.admits(clientId, event)))
    const recipients = clientIds.filter((_clientId, index) => admitted[index])
    return async () => {
      const sent = { ...event, occurredAt: Date.now() }
      const outcomes = await Promise.all(recipients.map((clientId) => this.clients.deliver(clientId, sent, { kind: 'decided' })))
      return outcomes.filter(Boolean).length
    }
  }

  /**
   * Publish to the clients in one resource's room — a session's watchers, a
   * work open live. Each member's first event is checked as `publish` checks
   * it; a pass is remembered until a share list or a task changes
   * (`forgetRoomAdmissions`), so the room's frequent events cost no share read.
   */
  publishToRoom<K extends HostEventName>(room: ShareResource, recipientClientIds: readonly ClientId[], type: K, payload: HostEventMap[K]): Promise<number> {
    return this.publishToRecipients(recipientClientIds, type, payload, 'room', { kind: 'room', room: RoomAdmissions.key(room) })
  }

  /** Access may have changed: every room member is checked again on its next event. */
  forgetRoomAdmissions(): void {
    this.clients.rooms.forgetAll()
  }

  private async publishToRecipients<K extends HostEventName>(
    recipientClientIds: readonly ClientId[],
    type: K,
    payload: HostEventMap[K],
    delivery: 'publish' | 'broadcast' | 'room',
    admission: DeliveryAdmission = { kind: 'check' },
  ): Promise<number> {
    const uniqueRecipientClientIds = new Set(recipientClientIds)
    // SAFETY: `type` and `payload` arrive as one pair `HostEventMap[K]`; the distributive `HostEvent<K>` is the same shape.
    const event = { type, payload, occurredAt: Date.now() } as HostEvent<K>
    const outcomes = await Promise.all([...uniqueRecipientClientIds].map((clientId) => this.clients.deliver(clientId, event, admission)))
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
