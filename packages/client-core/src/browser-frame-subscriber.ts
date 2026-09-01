import { z } from 'zod'
import type { BrowserFrameHeader } from '@solus/contracts/browser-types'

/**
 * The binary frame side-channel, client side. One per server connection.
 *
 * Frames do not go through `HostEventSubscriber`: they are not typed events,
 * they carry raw JPEG bytes, and they arrive far too often to validate as an
 * event envelope each time. This routes them by page id to whichever streamed
 * surface is showing that page — and a surface subscribes only while it is
 * visible, so a page nobody is watching produces no listeners here and, because
 * the host streams only to subscribers, no frames on the wire either.
 */

export type BrowserFrameListener = (header: BrowserFrameHeader, data: ArrayBuffer) => void

const headerSchema = z.object({ browserPageId: z.string().min(1), seq: z.number() })

/** The bytes as they can arrive over the wire: an ArrayBuffer in the browser, a
 *  typed-array view (a Buffer) in node. Validated to one shape before painting. */
type BrowserFrameBytes = ArrayBuffer | ArrayBufferView

export class BrowserFrameSubscriber {
  private readonly listeners = new Map<string, Set<BrowserFrameListener>>()

  subscribe(browserPageId: string, listener: BrowserFrameListener): () => void {
    let listeners = this.listeners.get(browserPageId)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(browserPageId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(browserPageId)
    }
  }

  /** Both arguments are wire input: the header shape is validated, and the bytes
   *  are normalized to an ArrayBuffer whether the socket delivered an
   *  ArrayBuffer (browser) or a Buffer view (node). */
  receive(header: z.input<typeof headerSchema>, data: BrowserFrameBytes): void {
    const parsed = headerSchema.safeParse(header)
    if (!parsed.success) return
    const buffer = toArrayBuffer(data)
    if (!buffer) return
    const listeners = this.listeners.get(parsed.data.browserPageId)
    if (!listeners) return
    for (const listener of Array.from(listeners)) {
      try {
        listener(parsed.data, buffer)
      } catch (error) {
        console.error('[solus:browser] frame subscriber threw', error)
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}

function toArrayBuffer(data: BrowserFrameBytes): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data
  if (ArrayBuffer.isView(data)) {
    // A view over a (possibly shared) backing buffer: copy the exact bytes into
    // a fresh, non-shared ArrayBuffer that `createImageBitmap` accepts.
    const copy = new Uint8Array(data.byteLength)
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    return copy.buffer
  }
  return null
}
