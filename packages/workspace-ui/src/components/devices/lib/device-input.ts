import type { DeviceInput } from '@solus/contracts/device-types'

/**
 * Pointer and keyboard input for a device surface. Coordinates are normalized
 * against the device screen as drawn (letterboxed inside the element), never
 * against browser viewport presets. Pointer input flushes at once; wheel
 * scrolls are batched per frame. Down, up and cancel are never dropped.
 */

export interface ScreenPoint {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Where a `frameWidth × frameHeight` picture lands inside an element with `object-fit: contain`. */
export function containedRect(element: Rect, frameWidth: number, frameHeight: number): Rect {
  if (frameWidth <= 0 || frameHeight <= 0 || element.width <= 0 || element.height <= 0) return { ...element, width: 0, height: 0 }
  const scale = Math.min(element.width / frameWidth, element.height / frameHeight)
  const width = frameWidth * scale
  const height = frameHeight * scale
  return { x: element.x + (element.width - width) / 2, y: element.y + (element.height - height) / 2, width, height }
}

/** A client point as 0..1 screen coordinates, or null outside the picture. */
export function normalizedPoint(clientX: number, clientY: number, picture: Rect): ScreenPoint | null {
  if (picture.width <= 0 || picture.height <= 0) return null
  const x = (clientX - picture.x) / picture.width
  const y = (clientY - picture.y) / picture.height
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x, y }
}

export interface ScrollFraction {
  deltaX: number
  deltaY: number
}

/** Clamp to the picture, for a drag that leaves it: the gesture continues at the edge. */
export function clampedPoint(clientX: number, clientY: number, picture: Rect): ScreenPoint {
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  return {
    x: picture.width > 0 ? clamp((clientX - picture.x) / picture.width) : 0,
    y: picture.height > 0 ? clamp((clientY - picture.y) / picture.height) : 0,
  }
}

/**
 * Wheel deltas as a fraction of the picture, bounded to one screen. A wheel
 * that reports lines (Firefox) or pages counts 16px a line and the picture a
 * page, as the 3D view does.
 */
export function scrollDelta(deltaX: number, deltaY: number, deltaMode: number, picture: Rect): ScrollFraction {
  const clamp = (value: number) => Math.min(1, Math.max(-1, value))
  const unit = (size: number) => (deltaMode === 1 ? 16 : deltaMode === 2 ? size : 1)
  return {
    deltaX: picture.width > 0 ? clamp((deltaX * unit(picture.width)) / picture.width) : 0,
    deltaY: picture.height > 0 ? clamp((deltaY * unit(picture.height)) / picture.height) : 0,
  }
}

/**
 * Collects input and sends it in order. Wheel scrolls wait for the next frame
 * and add up, so a fast wheel sends one scroll a frame. Pointer movement
 * flushes at once so dragging does not wait for the display clock. One send
 * is in flight at a time. While it is blocked, only the newest consecutive
 * pointer move is kept; press and release events stay in order.
 */
export class DeviceInputBatcher {
  private queue: DeviceInput[] = []
  private scheduled: (() => void) | null = null
  private sending: Promise<void> | null = null

  constructor(
    private readonly send: (inputs: DeviceInput[]) => Promise<void>,
    private readonly schedule: (flush: () => void) => void,
    private readonly onError: (cause: unknown) => void,
  ) {}

  push(input: DeviceInput): void {
    const last = this.queue.at(-1)
    const clamp = (value: number) => Math.min(1, Math.max(-1, value))
    if (input.kind === 'pointer' && input.phase === 'move' && last?.kind === 'pointer' && last.phase === 'move') {
      this.queue[this.queue.length - 1] = input
    } else if (input.kind === 'scroll' && last?.kind === 'scroll') {
      last.deltaX = clamp(last.deltaX + input.deltaX)
      last.deltaY = clamp(last.deltaY + input.deltaY)
    } else {
      this.queue.push(input)
    }
    if (input.kind === 'scroll') {
      if (!this.scheduled) {
        const flush = () => {
          if (this.scheduled !== flush) return
          this.scheduled = null
          this.flush()
        }
        this.scheduled = flush
        this.schedule(flush)
      }
      return
    }
    this.scheduled = null
    this.flush()
  }

  flush(): void {
    if (this.queue.length === 0 || this.sending) return
    const batch = this.queue.splice(0, 64)
    this.sending = Promise.resolve().then(() => this.send(batch)).catch(this.onError).then(() => {
      this.sending = null
      if (!this.scheduled) this.flush()
    })
  }

  /** Wait for everything queued so far to be sent. */
  async drained(): Promise<void> {
    do {
      this.scheduled = null
      this.flush()
      await this.sending
    } while (this.queue.length > 0 || this.sending)
  }
}

/** Keys the surface sends as key events; printable text on Android rides the key field. */
export function keyInput(event: { code: string; key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, phase: 'down' | 'up'): DeviceInput | null {
  if (event.code.length > 32 || event.key.length > 32) return null
  return { kind: 'key', phase, code: event.code, key: event.key, hasModifier: event.metaKey || event.ctrlKey || event.altKey }
}
