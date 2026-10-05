import type { DeviceInput } from '@solus/contracts/device-types'

/**
 * Pointer and keyboard input for a device surface. Coordinates are normalized
 * against the device screen as drawn (letterboxed inside the element), never
 * against browser viewport presets. Moves are batched per frame; down, up and
 * cancel flush at once and are never dropped.
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

/** Wheel deltas in pixels as a fraction of the picture, bounded to one screen. */
export function scrollDelta(deltaX: number, deltaY: number, picture: Rect): ScrollFraction {
  const clamp = (value: number) => Math.min(1, Math.max(-1, value))
  return {
    deltaX: picture.width > 0 ? clamp(deltaX / picture.width) : 0,
    deltaY: picture.height > 0 ? clamp(deltaY / picture.height) : 0,
  }
}

/**
 * Collects input and sends it in order. Moves wait for the next frame and
 * collapse to the latest; anything else flushes the queue at once. One send
 * is in flight at a time, so batches arrive in order.
 */
export class DeviceInputBatcher {
  private queue: DeviceInput[] = []
  private scheduled = false
  private sending: Promise<void> = Promise.resolve()

  constructor(
    private readonly send: (inputs: DeviceInput[]) => Promise<void>,
    private readonly schedule: (flush: () => void) => void,
    private readonly onError: (cause: unknown) => void,
  ) {}

  push(input: DeviceInput): void {
    const last = this.queue.at(-1)
    if (input.kind === 'pointer' && input.phase === 'move' && last?.kind === 'pointer' && last.phase === 'move') {
      this.queue[this.queue.length - 1] = input
    } else {
      this.queue.push(input)
    }
    if (input.kind === 'pointer' && input.phase === 'move') {
      if (!this.scheduled) {
        this.scheduled = true
        this.schedule(() => {
          this.scheduled = false
          this.flush()
        })
      }
      return
    }
    this.flush()
  }

  flush(): void {
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0, 64)
    this.sending = this.sending.then(() => this.send(batch)).catch(this.onError)
    if (this.queue.length > 0) this.flush()
  }

  /** Wait for everything queued so far to be sent. */
  async drained(): Promise<void> {
    this.flush()
    await this.sending
  }
}

/** Keys the surface sends as key events; printable text on Android rides the key field. */
export function keyInput(event: { code: string; key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, phase: 'down' | 'up'): DeviceInput | null {
  if (event.code.length > 32 || event.key.length > 32) return null
  return { kind: 'key', phase, code: event.code, key: event.key, hasModifier: event.metaKey || event.ctrlKey || event.altKey }
}
