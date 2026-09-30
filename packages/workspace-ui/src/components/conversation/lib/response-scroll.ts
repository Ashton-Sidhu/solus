/** Keep automatic smooth scrolling separate from a reader scrolling away.
 * Browser scrolling stops on direct input; no continuous animation loop is used. */
export function scrollConversationTo(element: HTMLElement, top: number): void {
  element.scrollTo({
    top: Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight)),
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
  })
}

/** How close to the end still counts as reading the end. */
const AT_END_PX = 60
/** Long enough for a newly revealed row or card to measure before following
 *  resumes. */
const HOLD_MS = 160
/** A reader's wheel or touch scroll counts as moving until this long after
 *  its last scroll event. */
const READER_SCROLL_IDLE_MS = 150

/**
 * The one owner of following the end of a conversation. Every automatic move
 * to the end goes through `follow` or `jump`, so there is one place that
 * decides whether the reader is at the end, and no retries fight each other.
 *
 * It never writes while the reader's own wheel or touch scroll is moving:
 * WebKit scrolls off the main thread, and a write there stops the momentum
 * and lands on a stale position.
 */
export function createEndFollow(element: HTMLElement, startAtEnd: boolean) {
  let atEnd = startAtEnd
  let moving = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let heldUntil = 0
  let readerScrollUntil = 0
  const settle = () => {
    moving = false
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = undefined
  }
  const cancel = () => {
    if (moving) element.scrollTo({ top: element.scrollTop, behavior: 'instant' })
    settle()
  }
  const readerScrolled = () => { readerScrollUntil = performance.now() + READER_SCROLL_IDLE_MS }
  const scrolled = () => { if (performance.now() < readerScrollUntil) readerScrolled() }
  const go = (smooth: boolean) => {
    const animate = smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (settleTimer) clearTimeout(settleTimer)
    moving = animate
    element.scrollTo({ top: element.scrollHeight, behavior: animate ? 'smooth' : 'instant' })
    // Fallback for clients without scrollend, including interrupted layout.
    if (animate) settleTimer = setTimeout(settle, 600)
  }
  const inputEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
  const readerEvents = ['wheel', 'touchmove'] as const
  for (const event of inputEvents) element.addEventListener(event, cancel, { passive: true })
  for (const event of readerEvents) element.addEventListener(event, readerScrolled, { passive: true })
  element.addEventListener('scroll', scrolled, { passive: true })
  element.addEventListener('scrollend', settle)
  return {
    get atEnd() { return atEnd },
    get moving() { return moving },
    /** Read where the reader stands after they scrolled. Our own smooth
     *  motion passes through positions short of the end; it does not count. */
    measure() {
      if (!moving) atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < AT_END_PX
    },
    /** Content grew: keep the end in view if the reader is reading it. */
    follow(smooth: boolean) {
      if (!atEnd || performance.now() < heldUntil || performance.now() < readerScrollUntil) return
      go(smooth)
    },
    /** Go to the end and follow it from now on. */
    jump(smooth = false) {
      atEnd = true
      heldUntil = 0
      go(smooth)
    },
    /** Content opens below a row the reader just used; let it open downward. */
    hold() { heldUntil = performance.now() + HOLD_MS },
    /** The view moved to a place of its own; stop following the end. */
    release() {
      atEnd = false
      cancel()
    },
    destroy() {
      cancel()
      for (const event of inputEvents) element.removeEventListener(event, cancel)
      for (const event of readerEvents) element.removeEventListener(event, readerScrolled)
      element.removeEventListener('scroll', scrolled)
      element.removeEventListener('scrollend', settle)
    },
  }
}
