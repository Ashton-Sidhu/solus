import type { WebContents } from 'electron'
import { nudgeIfIdle } from './screenshot-slot'

const FIRST_DELAY_MS = 250
const MAX_DELAY_MS = 2_000

/** A slow command may be waiting for a frame even when Electron says its window
 * is visible. Ask the guest to paint without showing its window or changing focus. */
export class GuestPaint {
  private readonly waits = new Set<symbol>()
  private timer?: ReturnType<typeof setTimeout>
  private restoreThrottling = false

  constructor(private readonly contents: WebContents) {}

  async whileWaiting<T>(work: () => Promise<T>): Promise<T> {
    const wait = Symbol()
    this.waits.add(wait)
    if (!this.timer) this.schedule(FIRST_DELAY_MS)
    try {
      return await work()
    } finally {
      this.waits.delete(wait)
      if (this.waits.size === 0) this.stop()
    }
  }

  stop(): void {
    this.waits.clear()
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.restoreThrottling) return
    this.restoreThrottling = false
    if (!this.contents.isDestroyed()) this.contents.setBackgroundThrottling(true)
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      if (this.contents.isDestroyed()) {
        this.stop()
        return
      }
      if (!this.restoreThrottling && this.contents.getBackgroundThrottling()) {
        this.contents.setBackgroundThrottling(false)
        this.restoreThrottling = true
      }
      // Share the existing one-copy limit, including across driver reattachments.
      nudgeIfIdle(this.contents, MAX_DELAY_MS, () => this.contents.capturePage())
      this.schedule(Math.min(delayMs * 2, MAX_DELAY_MS))
    }, delayMs)
  }
}
