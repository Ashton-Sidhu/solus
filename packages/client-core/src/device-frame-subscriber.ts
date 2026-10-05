import { z } from 'zod'
import { DEVICE_ORIENTATIONS, MAX_DEVICE_FRAME_BYTES, type DeviceFrameHeader } from '@solus/contracts/device-types'

/**
 * The binary `device-frame` channel, client side. One per server connection.
 *
 * Packets are H.264 access units, decoder configuration or JPEG images with a
 * header naming the device (docs/plans/native-devices.md, D2). They are routed
 * by device host and device id to the visible surface showing that device; a
 * hidden surface unsubscribes, so nothing here decodes for it.
 */

export type DeviceFrameListener = (header: DeviceFrameHeader, data: Uint8Array) => void

const headerSchema = z.object({
  deviceHostId: z.string().min(1).max(128),
  deviceId: z.string().min(1).max(256),
  streamGeneration: z.number(),
  seq: z.number(),
  kind: z.enum(['config', 'key', 'delta', 'jpeg', 'screen', 'ended']),
  codec: z.string().max(64).optional(),
  format: z.enum(['avcc', 'annexb']).optional(),
  timestamp: z.number().optional(),
  screen: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
    orientation: z.enum(DEVICE_ORIENTATIONS),
    screenId: z.number().optional(),
  }).optional(),
  screenGeneration: z.number().optional(),
  detail: z.string().max(500).optional(),
})

type DeviceFrameBytes = ArrayBuffer | ArrayBufferView

const keyOf = (deviceHostId: string, deviceId: string) => `${deviceHostId}\u0000${deviceId}`

export class DeviceFrameSubscriber {
  private readonly listeners = new Map<string, Set<DeviceFrameListener>>()

  subscribe(deviceHostId: string, deviceId: string, listener: DeviceFrameListener): () => void {
    const key = keyOf(deviceHostId, deviceId)
    let listeners = this.listeners.get(key)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(key, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(key)
    }
  }

  /** Wire input: the header is validated and the bytes bounded before any listener runs. */
  receive(header: z.input<typeof headerSchema>, data: DeviceFrameBytes): void {
    const parsed = headerSchema.safeParse(header)
    if (!parsed.success) return
    const bytes = toBytes(data)
    if (!bytes || bytes.byteLength > MAX_DEVICE_FRAME_BYTES) return
    const listeners = this.listeners.get(keyOf(parsed.data.deviceHostId, parsed.data.deviceId))
    if (!listeners) return
    for (const listener of Array.from(listeners)) {
      try {
        listener(parsed.data, bytes)
      } catch (error) {
        console.error('[solus:devices] frame listener threw', error)
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}

function toBytes(data: DeviceFrameBytes): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    // Copy out of a possibly shared backing buffer (a node Buffer view).
    const copy = new Uint8Array(data.byteLength)
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    return copy
  }
  return null
}
