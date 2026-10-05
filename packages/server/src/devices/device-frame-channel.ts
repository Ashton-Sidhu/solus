import type { DeviceFrameHeader } from '@solus/contracts/device-types'
import { createLogger } from '../logger'

const log = createLogger('devices', 'device-frame-channel.ts')

/** How the transport reaches one client for device video. */
export interface DeviceFrameDelivery {
  send(header: DeviceFrameHeader, data: Uint8Array): void
  /** Packets the transport has queued for this client and not yet written. */
  buffered(): number
}

/**
 * The binary `device-frame` side channel, server side. Like the browser
 * frame channel, video never rides the typed host-event path; unlike it,
 * packets are H.264 or JPEG with a header naming the device, stream
 * generation and packet kind. Delivery goes only to subscribed clients.
 */
export class DeviceFrameChannel {
  private readonly deliveries = new Map<string, DeviceFrameDelivery>()

  register(clientId: string, delivery: DeviceFrameDelivery): () => void {
    this.deliveries.set(clientId, delivery)
    return () => {
      if (this.deliveries.get(clientId) === delivery) this.deliveries.delete(clientId)
    }
  }

  has(clientId: string): boolean {
    return this.deliveries.has(clientId)
  }

  buffered(clientId: string): number {
    try {
      return this.deliveries.get(clientId)?.buffered() ?? 0
    } catch {
      return 0
    }
  }

  /** Send one packet to one client. False when the client cannot be reached. */
  send(clientId: string, header: DeviceFrameHeader, data: Uint8Array): boolean {
    const delivery = this.deliveries.get(clientId)
    if (!delivery) return false
    try {
      delivery.send(header, data)
      return true
    } catch (error) {
      log.warn('device_frame_delivery_failed', {
        deviceHostId: header.deviceHostId,
        deviceId: header.deviceId,
        clientId,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }
}
