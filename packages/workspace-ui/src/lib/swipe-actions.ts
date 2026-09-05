// Swipe left on a list row to reveal the actions beneath it.
//
// The gesture is one-directional because a rightward drag belongs to the
// mobile shell's back navigation. The host owns `open`, so a list can keep one
// revealed row at a time.

export interface SwipeActionsParams {
  /** Total width of the revealed controls. */
  revealWidth: number
  open: boolean
  onRevealChange: (revealed: boolean) => void
  /** A full swipe is optional. Omit it when the user must choose a control. */
  onFullSwipe?: () => void
  enabled?: boolean
}

/** Movement (px) before a drag commits to "this is a swipe along our axis".
 *  Shared with the client's dismiss gesture: one number, so a swipe feels the
 *  same wherever the thumb starts it. */
export const SWIPE_DIRECTION_LOCK_PX = 8
/** A deliberate swipe of one quarter of the tray opens or closes it. */
export const SWIPE_REVEAL_COMMIT_RATIO = 0.25
export const SWIPE_FULL_COMMIT_RATIO = 0.62
const SETTLE = 'transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)'

export type SwipeRelease = 'closed' | 'revealed' | 'full'

/** The release rule is pure so the thresholds are testable without a browser. */
export function swipeRelease(
  exposedWidth: number,
  revealWidth: number,
  rowWidth: number,
  canFullSwipe: boolean,
  wasRevealed: boolean,
): SwipeRelease {
  if (!wasRevealed && canFullSwipe && exposedWidth > rowWidth * SWIPE_FULL_COMMIT_RATIO) {
    return 'full'
  }
  const commitDistance = revealWidth * SWIPE_REVEAL_COMMIT_RATIO
  if (wasRevealed) {
    return exposedWidth > revealWidth - commitDistance ? 'revealed' : 'closed'
  }
  return exposedWidth >= commitDistance ? 'revealed' : 'closed'
}

export function swipeActions(node: HTMLElement, params: SwipeActionsParams) {
  node.dataset.swipeActions = ''
  let current = params
  let startX = 0
  let startY = 0
  let lastX = 0
  let active = false
  let revealed = params.open
  let lockedToAxis: boolean | null = null
  let currentOffset = revealed ? -params.revealWidth : 0
  let pendingOffset = currentOffset
  let animationFrame = 0
  let settleTimer = 0
  const previousTouchAction = node.style.touchAction
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  node.style.touchAction = 'pan-y'
  node.style.transform = `translateX(${currentOffset}px)`

  function setOffset(px: number) {
    currentOffset = px
    pendingOffset = px
    node.style.transform = `translateX(${px}px)`
  }

  function drawPendingOffset() {
    animationFrame = 0
    setOffset(pendingOffset)
  }

  function queueOffset(px: number) {
    pendingOffset = px
    if (!animationFrame) animationFrame = requestAnimationFrame(drawPendingOffset)
  }

  function settle(open: boolean, announce = true) {
    if (animationFrame) cancelAnimationFrame(animationFrame)
    animationFrame = 0
    node.style.transition = reduceMotion ? 'none' : SETTLE
    setOffset(open ? -current.revealWidth : 0)
    clearTimeout(settleTimer)
    settleTimer = window.setTimeout(() => {
      node.style.willChange = ''
    }, reduceMotion ? 0 : 300)
    if (revealed === open) return
    revealed = open
    if (announce) current.onRevealChange(open)
  }

  function onStart(event: TouchEvent) {
    if (current.enabled === false) return
    const touch = event.touches[0]
    if (!touch) return
    startX = touch.clientX
    startY = touch.clientY
    lastX = startX
    active = true
    lockedToAxis = null
    node.style.transition = 'none'
    node.style.willChange = 'transform'
  }

  function onMove(event: TouchEvent) {
    if (!active) return
    const touch = event.touches[0]
    if (!touch) return
    lastX = touch.clientX
    const dx = lastX - startX
    const dy = touch.clientY - startY

    if (lockedToAxis === null) {
      if (Math.abs(dx) < SWIPE_DIRECTION_LOCK_PX && Math.abs(dy) < SWIPE_DIRECTION_LOCK_PX) return
      lockedToAxis = Math.abs(dx) > Math.abs(dy)
      if (!lockedToAxis) {
        active = false
        node.style.willChange = ''
        return
      }
    }

    const base = revealed ? -current.revealWidth : 0
    const travelLimit = current.onFullSwipe ? node.offsetWidth : current.revealWidth
    queueOffset(Math.max(-travelLimit, Math.min(0, base + dx)))
  }

  function onEnd() {
    if (!active) return
    active = false
    lockedToAxis = null

    if (animationFrame) cancelAnimationFrame(animationFrame)
    animationFrame = 0
    setOffset(pendingOffset)
    const release = swipeRelease(
      -currentOffset,
      current.revealWidth,
      node.offsetWidth,
      !!current.onFullSwipe,
      revealed,
    )
    if (release === 'full') {
      node.style.transition = SETTLE
      setOffset(-node.offsetWidth)
      current.onFullSwipe?.()
      return
    }
    settle(release === 'revealed')
  }

  node.addEventListener('touchstart', onStart, { passive: true })
  node.addEventListener('touchmove', onMove, { passive: true })
  node.addEventListener('touchend', onEnd)
  node.addEventListener('touchcancel', onEnd)

  return {
    update(next: SwipeActionsParams) {
      current = next
      if ((!current.enabled || !current.open) && revealed) settle(false, false)
      else if (current.open && !revealed) settle(true, false)
    },
    destroy() {
      if (animationFrame) cancelAnimationFrame(animationFrame)
      clearTimeout(settleTimer)
      node.style.touchAction = previousTouchAction
      node.style.willChange = ''
      node.removeEventListener('touchstart', onStart)
      node.removeEventListener('touchmove', onMove)
      node.removeEventListener('touchend', onEnd)
      node.removeEventListener('touchcancel', onEnd)
    },
  }
}
