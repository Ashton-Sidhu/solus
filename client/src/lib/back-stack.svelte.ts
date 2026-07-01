// Browser/OS "back" closes the topmost open overlay instead of leaving the app.
//
// While any overlay is open we keep exactly one sentinel history entry. Pressing
// back (Android button, iOS back-swipe, desktop back) pops the sentinel; we
// intercept popstate, close the top overlay, and re-arm the sentinel if more
// remain.
//
// remove() (overlay closed by tap/select, not back) deliberately does NOT touch
// history. Calling history.back() there was fragile: when one overlay opens as
// another closes in the same tick, the transient empty stack triggered a back()
// whose async popstate then closed the freshly-opened overlay. Leaving the
// sentinel in place is safe — it's reused by the next overlay, or consumed by the
// next back press (at worst one no-op "dead" back after a tap-close).

interface Entry {
  id: string
  close: () => void
}

class BackStack {
  private entries: Entry[] = []
  private hasSentinel = false

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('popstate', this.onPop)
    }
  }

  push(id: string, close: () => void) {
    this.entries = this.entries.filter((e) => e.id !== id)
    this.entries.push({ id, close })
    if (!this.hasSentinel) {
      history.pushState({ solusBack: true }, '')
      this.hasSentinel = true
    }
  }

  remove(id: string) {
    this.entries = this.entries.filter((e) => e.id !== id)
  }

  private onPop = () => {
    // The browser popped our sentinel entry.
    this.hasSentinel = false
    if (this.entries.length === 0) return
    this.entries.pop()!.close()
    // More overlays still open — re-arm a sentinel so the next back closes them.
    if (this.entries.length > 0) {
      history.pushState({ solusBack: true }, '')
      this.hasSentinel = true
    }
  }
}

export const backStack = new BackStack()

/**
 * Register an overlay with the back-stack. Call at the top level of a
 * component's <script>; while `isOpen()` is true, browser/OS back closes it.
 */
export function registerBackOverlay(id: string, isOpen: () => boolean, close: () => void) {
  $effect(() => {
    if (!isOpen()) return
    backStack.push(id, close)
    return () => backStack.remove(id)
  })
}
