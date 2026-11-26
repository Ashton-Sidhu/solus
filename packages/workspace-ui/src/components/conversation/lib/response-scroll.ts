import { afterPaint } from '../../../lib/after-paint'

/** Keep automatic smooth scrolling separate from a reader scrolling away.
 * Browser scrolling stops on direct input; no continuous animation loop is used. */
export function scrollConversationTo(element: HTMLElement, top: number): void {
  element.scrollTo({
    top: Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight)),
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
  })
}

/** A view that never holds still (a streaming reply moves the end every
 *  frame) stops settling after this many frames; following takes over. */
const SETTLE_MAX_FRAMES = 60

/**
 * Row heights start as estimates, and highlighted code, images, and diagrams
 * measure frames after the first jump. Writes `target` each frame until the
 * scroll holds it for two frames, the frame budget runs out, the caller
 * cancels, or there is no target.
 */
export function settleScroll(
  element: HTMLElement,
  target: () => number | undefined,
  isCancelled: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    let stableFrames = 0
    let frames = 0
    const reconcile = () => {
      const top = target()
      frames += 1
      if (isCancelled() || top === undefined || frames > SETTLE_MAX_FRAMES) return resolve()
      const clamped = Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight))
      if (Math.abs(element.scrollTop - clamped) > 1) {
        stableFrames = 0
        element.scrollTop = clamped
      } else if (++stableFrames >= 2) return resolve()
      requestAnimationFrame(reconcile)
    }
    requestAnimationFrame(reconcile)
  })
}

/** The gap above a turn the reader just sent, once it is at the top. */
const NEW_TURN_TOP_GAP_PX = 16

/**
 * The least height of a turn the reader just sent: the view under the
 * floating band and the composer. At the end of the conversation the turn
 * then starts at the top of the view, and its reply fills the room below
 * without moving the view. The composer inset stays a CSS variable, so the
 * room follows the composer as it folds.
 */
export function newTurnMinHeight(viewHeight: number, bandHeight: number): string {
  return `max(0px, calc(${viewHeight - bandHeight - NEW_TURN_TOP_GAP_PX}px - var(--solus-composer-inset, 0px)))`
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
  let isGlideAfterPaintPending = false
  let isDestroyed = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let heldUntil = 0
  let readerScrollUntil = 0
  // Content that grew during a glide. A second smooth scroll would restart
  // the browser's easing from rest, and the glide would stutter, so the view
  // glides on to the new end once this glide stops.
  let isFollowQueued = false
  const settle = () => {
    moving = false
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = undefined
  }
  const cancel = () => {
    isFollowQueued = false
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
    if (animate) settleTimer = setTimeout(glideEnded, 600)
  }
  const jump = (smooth = false) => {
    atEnd = true
    heldUntil = 0
    go(smooth)
  }
  const inputEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
  const readerEvents = ['wheel', 'touchmove'] as const
  for (const event of inputEvents) element.addEventListener(event, cancel, { passive: true })
  for (const event of readerEvents) element.addEventListener(event, readerScrolled, { passive: true })
  element.addEventListener('scroll', scrolled, { passive: true })
  const glideEnded = () => {
    settle()
    if (!isFollowQueued) return
    isFollowQueued = false
    if (atEnd && performance.now() >= readerScrollUntil) go(true)
  }
  element.addEventListener('scrollend', glideEnded)
  return {
    get atEnd() { return atEnd },
    get moving() { return moving },
    /** Read where the reader stands after they scrolled. Our own smooth
     *  motion passes through positions short of the end; it does not count. */
    measure() {
      if (!moving) atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < AT_END_PX
    },
    /** Content grew: keep the end in view if the reader is reading it. A
     *  glide under way finishes first and then glides on to the new end. */
    follow(smooth: boolean) {
      if (isGlideAfterPaintPending || !atEnd || performance.now() < heldUntil || performance.now() < readerScrollUntil) return
      if (moving) isFollowQueued = true
      else go(smooth)
    },
    /** Go to the end and follow it from now on. */
    jump,
    /** A sent prompt: its rows first paint where they land, below the view,
     *  and then the view glides up to them. Smooth scrolling runs on time, so
     *  a glide started before a slow first paint shows up half done, and the
     *  message seems to appear in the middle of the view. */
    glideAfterPaint() {
      isGlideAfterPaintPending = true
      void afterPaint().then(() => {
        isGlideAfterPaintPending = false
        if (!isDestroyed) jump(true)
      })
    },
    /** Content opens below a row the reader just used; let it open downward. */
    hold() { heldUntil = performance.now() + HOLD_MS },
    /** The view moved to a place of its own; stop following the end. */
    release() {
      atEnd = false
      cancel()
    },
    destroy() {
      isDestroyed = true
      cancel()
      for (const event of inputEvents) element.removeEventListener(event, cancel)
      for (const event of readerEvents) element.removeEventListener(event, readerScrolled)
      element.removeEventListener('scroll', scrolled)
      element.removeEventListener('scrollend', glideEnded)
    },
  }
}
