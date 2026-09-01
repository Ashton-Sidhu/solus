import type { BrowserFrameHeader } from '@solus/contracts/browser-types'
import { createLogger } from '../logger'

const log = createLogger('browser', 'browser-frame-channel.ts')

/** How the transport delivers one frame to one client: the header as a plain
 *  object, the JPEG as raw bytes. Socket.IO ships the bytes as a binary wire
 *  frame; the header rides beside them. */
export type BrowserFrameDelivery = (header: BrowserFrameHeader, data: Uint8Array) => void

/**
 * The binary frame side-channel, server side.
 *
 * This is deliberately *not* the host-event path. Frames are JPEG bytes at
 * whatever rate a page repaints; routing them through the typed-event envelope
 * would base64 them into JSON and validate every one against the event schema —
 * the exact wire cost the side-channel exists to avoid. So the transport
 * registers a per-client delivery here, and the registry publishes only to the
 * clients actually watching a page. A page nobody watches produces no frames at
 * the source, so this channel is quiet by construction rather than by filtering.
 */
export class BrowserFrameChannel {
  private readonly deliveries = new Map<string, BrowserFrameDelivery>()

  /** The transport registers how to reach one client. Mirrors the host-event
   *  registry: registered on a client's first socket, released on its expiry. */
  register(clientId: string, deliver: BrowserFrameDelivery): () => void {
    this.deliveries.set(clientId, deliver)
    return () => {
      if (this.deliveries.get(clientId) === deliver) this.deliveries.delete(clientId)
    }
  }

  /** Send one frame to exactly the clients watching its page. Never a broadcast:
   *  a frame is only ever wanted by the panes showing that page. */
  publish(clientIds: Iterable<string>, header: BrowserFrameHeader, data: Uint8Array): void {
    for (const clientId of clientIds) {
      const deliver = this.deliveries.get(clientId)
      if (!deliver) continue
      try {
        deliver(header, data)
      } catch (error) {
        log.warn('browser_frame_delivery_failed', {
          browserPageId: header.browserPageId,
          clientId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
