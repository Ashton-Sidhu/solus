import { isLaptopDisplay, MOBILE_QUERY } from './viewport'
import { ZOOM_FACTOR_DEFAULT } from '../../../shared/zoom'

// Layout: collapse secondary panels (sidebar, TOC rail)
const COMPACT_QUERY = '(max-width: 1100px)'
// Input: primary pointer is imprecise (phone, tablet)
const TOUCH_QUERY = '(pointer: coarse)'
// Input: any connected pointer is precise (iPad + Magic Keyboard, touch laptop with trackpad)
const FINE_POINTER_QUERY = '(any-pointer: fine)'

class RuntimeStore {
  isMobileViewport = $state(globalThis.window?.matchMedia(MOBILE_QUERY).matches ?? false)
  // Stays false until settings reports the boot zoom factor; there is no honest
  // answer before then, and pill geometry is the only reader.
  isLaptopDisplay = $state(false)
  isCompactViewport = $state(globalThis.window?.matchMedia(COMPACT_QUERY).matches ?? false)
  isTouchDevice = $state(globalThis.window?.matchMedia(TOUCH_QUERY).matches ?? false)
  hasKeyboardPointer = $state(globalThis.window?.matchMedia(FINE_POINTER_QUERY).matches ?? true)
  // Not reactive: only `refreshLaptopDisplay` reads it. null means settings has
  // not booted yet, which is what makes the first push identifiable.
  private zoomFactor: number | null = null

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
    window.addEventListener('resize', () => this.refreshLaptopDisplay())

    listen(MOBILE_QUERY, (v) => this.isMobileViewport = v)
    listen(COMPACT_QUERY, (v) => this.isCompactViewport = v)
    listen(TOUCH_QUERY, (v) => this.isTouchDevice = v)
    listen(FINE_POINTER_QUERY, (v) => this.hasKeyboardPointer = v)
  }

  /**
   * Settings owns the zoom factor and pushes it here — once at boot, then on
   * every change. Only the boot push recomputes. A later push arrives before
   * Chromium has applied the new factor, so `screen.width` still carries the old
   * one and the product would be wrong by a step — long enough to flip the
   * branch and resize the pill for a frame. Every zoom change resizes the
   * viewport, so the resize listener does the real work.
   */
  setZoomFactor(zoomFactor: number): void {
    const isBootPush = this.zoomFactor === null
    this.zoomFactor = zoomFactor
    if (isBootPush) this.refreshLaptopDisplay()
  }

  private refreshLaptopDisplay(): void {
    const next = isLaptopDisplay(globalThis.screen?.width, this.zoomFactor ?? ZOOM_FACTOR_DEFAULT)
    if (next === this.isLaptopDisplay) return
    this.isLaptopDisplay = next
    document.documentElement.classList.toggle('is-laptop-display', next)
  }
}

export const runtime = new RuntimeStore()
