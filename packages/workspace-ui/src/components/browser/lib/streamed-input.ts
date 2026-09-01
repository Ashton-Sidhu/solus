import type { BrowserViewport } from '@solus/contracts/browser-types'

/**
 * Input mapping for a streamed surface.
 *
 * A person points at a pixel on the canvas; the guest is emulating a CSS
 * viewport at some other size, scaled to fit the stage. So a pointer is mapped
 * from the surface rectangle to the viewport's own coordinates before it is
 * forwarded — the picture may be a 390px phone shown in a 300px pane, and the
 * guest only understands the 390.
 */

export interface SurfaceRect {
  left: number
  top: number
  width: number
  height: number
}

/** A coordinate in the guest's own CSS viewport, ready to hand to a drive op. */
export interface ViewportPoint {
  x: number
  y: number
}

export interface ViewportRect {
  x: number
  y: number
  width: number
  height: number
}

export interface RegionBrowserUpdate {
  rect: ViewportRect | null
  commit: boolean
}

/**
 * Keep remote box feedback interactive without sending one RPC per pointer
 * event. One update can be in flight; newer browsers replace the queued one.
 * The final commit uses the same lane, so it cannot overtake an older browser
 * and leave a stale highlight behind in the guest.
 */
export class RegionBrowserSender {
  #pending: RegionBrowserUpdate | undefined
  #running: Promise<void> | null = null
  readonly #send: (update: RegionBrowserUpdate) => Promise<void>

  constructor(send: (update: RegionBrowserUpdate) => Promise<void>) {
    this.#send = send
  }

  browser(rect: ViewportRect): Promise<void> {
    return this.#enqueue({ rect, commit: false })
  }

  commit(rect: ViewportRect): Promise<void> {
    return this.#enqueue({ rect, commit: true })
  }

  clear(): Promise<void> {
    return this.#enqueue({ rect: null, commit: false })
  }

  #enqueue(update: RegionBrowserUpdate): Promise<void> {
    // Once a commit is queued, a teardown or late move cannot replace it.
    if (!this.#pending?.commit || update.commit) this.#pending = update
    this.#running ??= this.#drain()
    return this.#running
  }

  async #drain(): Promise<void> {
    while (this.#pending) {
      const update = this.#pending
      this.#pending = undefined
      try {
        await this.#send(update)
      } catch {
        // Browser feedback is best-effort. A later update or final commit must
        // still get a chance after one remote frame failed.
      }
    }
    this.#running = null
  }
}

export function pointToViewport(
  clientX: number,
  clientY: number,
  rect: SurfaceRect,
  viewport: BrowserViewport,
): ViewportPoint {
  const fractionX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
  const fractionY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0
  return {
    x: Math.round(clamp01(fractionX) * viewport.width),
    y: Math.round(clamp01(fractionY) * viewport.height),
  }
}

/**
 * Whether a sampled stroke should keep this point.
 *
 * A pointer reports far more often than a legible stroke needs, and every point
 * kept is one more the mark carries into the prompt. Sampled in the guest's own
 * coordinates rather than the surface's, so a phone showing a 1440px page at a
 * third of scale does not silently sample three times as coarsely as a desktop.
 */
export function keepsStrokePoint(last: ViewportPoint, next: ViewportPoint): boolean {
  return Math.abs(next.x - last.x) + Math.abs(next.y - last.y) >= 3
}

/** The rectangle two drag corners describe, in either drag direction. A user who
 *  drags up and to the left means the same rectangle as one who drags down. */
export function rectFromDrag(from: ViewportPoint, to: ViewportPoint): ViewportRect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  }
}

/** The keys a streamed keyboard sends as key presses rather than inserted text:
 *  everything that is not a single printable character. A lone printable char is
 *  typed into the focused field instead, so accented and shifted characters
 *  arrive as themselves rather than as a synthesized keycode. */
export function isPrintableKey(key: string): boolean {
  return key.length === 1
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
