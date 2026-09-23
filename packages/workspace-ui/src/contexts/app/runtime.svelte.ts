import { isLaptopDisplay, isMobileLayout, MOBILE_QUERY } from './viewport'
import { ZOOM_FACTOR_DEFAULT } from '@solus/contracts/zoom'

// Input: primary pointer is imprecise (phone, tablet)
const TOUCH_QUERY = '(pointer: coarse)'
// Input: any connected pointer is precise (iPad + Magic Keyboard, touch laptop with trackpad)
const FINE_POINTER_QUERY = '(any-pointer: fine)'

/**
 * How long the window has to stay blurred before it counts as left.
 *
 * `document.hasFocus()` is false for any handoff out of the document — a native
 * menu, a webview, devtools, the composer's own refocus after a prompt — and
 * those come back within a frame or two. Reported raw, each one is an away/back
 * pair that every subscriber acts on: the checks cadence report, server
 * discovery, the needs-review count. Only the falling edge waits. Coming back is
 * the user actually there, and is published at once.
 */
const AWAY_SETTLE_MS = 1_000

class RuntimeStore {
  isMobileViewport = $state(isMobileLayout(
    globalThis.window?.innerWidth,
    globalThis.screen?.width,
    globalThis.screen?.height,
    globalThis.window?.matchMedia(TOUCH_QUERY).matches ?? false,
  ))
  // Stays false until settings reports the boot zoom factor; there is no honest
  // answer before then.
  isLaptopDisplay = $state(false)
  isTouchDevice = $state(globalThis.window?.matchMedia(TOUCH_QUERY).matches ?? false)
  hasKeyboardPointer = $state(globalThis.window?.matchMedia(FINE_POINTER_QUERY).matches ?? true)
  /** The window is on screen and has focus: someone is looking at it. */
  isWindowForeground = $state(isWindowForeground())
  // Not reactive: only `refreshLaptopDisplay` reads it. null means settings has
  // not booted yet, which is what makes the first push identifiable.
  private zoomFactor: number | null = null
  // A blur waiting to be believed. Cleared by a focus that arrives first.
  private awaySettleTimer: number | null = null

  // Focus suppression: true on phones/tablets without keyboard, false for desktop and iPad+keyboard
  get shouldSuppressFocus(): boolean {
    return this.isTouchDevice && !this.hasKeyboardPointer
  }

  constructor() {
    if (!globalThis.window) return

    const listen = (query: string, setter: (v: boolean) => void) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', (e) => setter(e.matches))
    }

    // A zoom change resizes the viewport, so this also covers the case the
    // window never moves monitors.
    window.addEventListener('resize', () => {
      this.refreshMobileViewport()
      this.refreshLaptopDisplay()
    })

    listen(MOBILE_QUERY, () => this.refreshMobileViewport())
    listen(TOUCH_QUERY, (v) => {
      this.isTouchDevice = v
      this.refreshMobileViewport()
    })
    listen(FINE_POINTER_QUERY, (v) => this.hasKeyboardPointer = v)

    const refreshWindowForeground = () => {
      if (this.awaySettleTimer !== null) {
        window.clearTimeout(this.awaySettleTimer)
        this.awaySettleTimer = null
      }
      const next = isWindowForeground()
      if (next === this.isWindowForeground) return
      if (next) {
        this.isWindowForeground = true
        return
      }
      this.awaySettleTimer = window.setTimeout(() => {
        this.awaySettleTimer = null
        // Ask again rather than trusting the event: focus may have returned to a
        // part of the document that raises no event we listen to.
        if (!isWindowForeground()) this.isWindowForeground = false
      }, AWAY_SETTLE_MS)
    }
    window.addEventListener('focus', refreshWindowForeground)
    window.addEventListener('blur', refreshWindowForeground)
    document.addEventListener('visibilitychange', refreshWindowForeground)
  }

  /**
   * Settings owns the zoom factor and pushes it here — once at boot, then on
   * every change. Only the boot push recomputes. A later push arrives before
   * Chromium has applied the new factor, so `screen.width` still carries the old
   * one and the product would be wrong by a step — long enough to flip the
   * responsive branch for a frame. Every zoom change resizes the
   * viewport, so the resize listener does the real work.
   */
  setZoomFactor(zoomFactor: number): void {
    const isBootPush = this.zoomFactor === null
    this.zoomFactor = zoomFactor
    if (isBootPush) this.refreshLaptopDisplay()
  }

  private refreshMobileViewport(): void {
    const next = isMobileLayout(
      window.innerWidth,
      globalThis.screen?.width,
      globalThis.screen?.height,
      window.matchMedia(TOUCH_QUERY).matches,
    )
    if (next !== this.isMobileViewport) this.isMobileViewport = next
  }

  private refreshLaptopDisplay(): void {
    const next = isLaptopDisplay(globalThis.screen?.width, this.zoomFactor ?? ZOOM_FACTOR_DEFAULT)
    if (next === this.isLaptopDisplay) return
    this.isLaptopDisplay = next
    document.documentElement.classList.toggle('is-laptop-display', next)
  }
}

function isWindowForeground(): boolean {
  const doc = globalThis.document
  return doc?.visibilityState === 'visible' && doc.hasFocus()
}

export const runtime = new RuntimeStore()
