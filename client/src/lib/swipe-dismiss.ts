// Reusable swipe-to-dismiss gesture for mobile sheets/drawers.
//
// Extracted from the original hand-rolled handlers in WebSidebarDrawer so the
// bottom sheet (MobilePlusMenu) and the side drawer share one tested gesture.
// It only owns the *drag*: the host keeps its open/close transition effect and
// animates the panel out when `onDismiss` flips its `open` prop to false.

export interface SwipeDismissParams {
  /** Axis the panel travels along to leave the screen. */
  axis: 'x' | 'y'
  /** Direction along that axis that dismisses: -1 = left/up, 1 = right/down. */
  sign: -1 | 1
  /** Fired once the drag passes the dismiss threshold. */
  onDismiss: () => void
  /** Optional backdrop whose opacity tracks drag progress. */
  backdrop?: () => HTMLElement | null | undefined
  /** When false the gesture is inert (e.g. non-touch pointers). */
  enabled?: boolean
}

const DISMISS_DISTANCE = 80
const DISMISS_VELOCITY = 0.3
// Movement (px) before we commit to "this is a swipe along our axis".
const DIRECTION_LOCK = 8
const SNAP_BACK = 'transform 0.2s cubic-bezier(0.32, 0.72, 0, 1)'

export function swipeDismiss(node: HTMLElement, params: SwipeDismissParams) {
  let p = params
  let startAlong = 0
  let startAcross = 0
  let lastAlong = 0
  let startTime = 0
  let active = false
  // null = direction not yet locked; true = along our axis; false = across it.
  let lockedToAxis: boolean | null = null

  const size = () => (p.axis === 'x' ? node.offsetWidth : node.offsetHeight)
  const along = (t: Touch) => (p.axis === 'x' ? t.clientX : t.clientY)
  const across = (t: Touch) => (p.axis === 'x' ? t.clientY : t.clientX)

  function setTransform(px: number) {
    node.style.transform = p.axis === 'x' ? `translateX(${px}px)` : `translateY(${px}px)`
  }

  function onStart(e: TouchEvent) {
    if (p.enabled === false) return
    const t = e.touches[0]
    startAlong = along(t)
    startAcross = across(t)
    lastAlong = startAlong
    startTime = Date.now()
    active = true
    lockedToAxis = null
    node.style.transition = 'none'
  }

  function onMove(e: TouchEvent) {
    if (!active) return
    const t = e.touches[0]
    lastAlong = along(t)
    const distAlong = lastAlong - startAlong
    const distAcross = across(t) - startAcross

    if (lockedToAxis === null) {
      const a = Math.abs(distAlong)
      const b = Math.abs(distAcross)
      if (a < DIRECTION_LOCK && b < DIRECTION_LOCK) return
      lockedToAxis = a > b
      if (!lockedToAxis) {
        // Cross-axis gesture (e.g. scrolling the drawer list) — yield to native.
        active = false
        return
      }
    }

    // Only follow the finger in the dismiss direction; resist the other way.
    const travel = distAlong * p.sign
    if (travel <= 0) return
    const clamped = Math.min(travel, size())
    setTransform(clamped * p.sign)
    const bg = p.backdrop?.()
    if (bg) bg.style.opacity = String(Math.max(0, 1 - clamped / size()))
  }

  function onEnd() {
    if (!active) return
    active = false
    lockedToAxis = null

    const travel = (lastAlong - startAlong) * p.sign
    const elapsed = Date.now() - startTime
    const velocity = Math.abs(travel) / Math.max(elapsed, 1)
    const dismiss = travel > DISMISS_DISTANCE || (travel > 20 && velocity > DISMISS_VELOCITY)
    const bg = p.backdrop?.()
    if (bg) bg.style.opacity = ''

    if (dismiss) {
      // Leave the panel where the finger left it; the host's `open=false`
      // transition animates it the rest of the way out.
      p.onDismiss()
    } else {
      node.style.transition = SNAP_BACK
      node.style.transform = ''
    }
  }

  node.addEventListener('touchstart', onStart, { passive: true })
  node.addEventListener('touchmove', onMove, { passive: true })
  node.addEventListener('touchend', onEnd)
  node.addEventListener('touchcancel', onEnd)

  return {
    update(next: SwipeDismissParams) {
      p = next
    },
    destroy() {
      node.removeEventListener('touchstart', onStart)
      node.removeEventListener('touchmove', onMove)
      node.removeEventListener('touchend', onEnd)
      node.removeEventListener('touchcancel', onEnd)
    },
  }
}
