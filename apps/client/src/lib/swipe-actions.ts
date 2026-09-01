// Swipe-left on a list row to reveal its actions.
//
// Sibling of `swipe-dismiss`, and deliberately one-directional: rightward drag
// belongs to back navigation (installed) or the browser's own back (web), so a
// row that also travelled right would fight the shell. The finger drags the row
// itself off the tiles rather than sliding a proxy in — the tiles are already
// there, underneath.
//
// Two commits, per the gesture table: a short swipe rests at the reveal, and a
// swipe past the row's own width commits the *safe* action. Drop is never
// reachable without aiming at its tile.

export interface SwipeActionsParams {
  /** Total width of the revealed tiles. The row rests here after a short drag. */
  revealWidth: number
  /** Whether the tiles are showing. The host owns this so only one row in a
   *  list can be open at a time; the action animates to whatever it is told. */
  open: boolean
  /** Fired when the drag crosses the full-swipe threshold and is released. */
  onFullSwipe: () => void
  /** Fired when the gesture itself opens or closes the row. */
  onRevealChange: (revealed: boolean) => void
  /** When false the gesture is inert. */
  enabled?: boolean
}

/** Below this the row springs back rather than resting open. */
const REVEAL_COMMIT = 40
/** Movement before we decide this is a horizontal drag and not a list scroll. */
const DIRECTION_LOCK = 8
/** Past this fraction of the row width, release commits the safe action. */
const FULL_SWIPE_RATIO = 0.62
const SETTLE = 'transform 0.22s cubic-bezier(0.32, 0.72, 0, 1)'

export function swipeActions(node: HTMLElement, params: SwipeActionsParams) {
  // Claims the horizontal drag for this row, so an enclosing swipe-to-dismiss
  // surface (`swipe-dismiss`, `ignoreWithin`) lets it through instead of
  // closing itself when the row is dragged.
  node.dataset.swipeActions = ''
  let p = params
  let startX = 0
  let startY = 0
  let lastX = 0
  let active = false
  let revealed = false
  let lockedToAxis: boolean | null = null

  function setOffset(px: number) {
    node.style.transform = `translateX(${px}px)`
  }

  function settle(open: boolean, announce = true) {
    node.style.transition = SETTLE
    setOffset(open ? -p.revealWidth : 0)
    if (revealed === open) return
    revealed = open
    if (announce) p.onRevealChange(open)
  }

  function onStart(e: TouchEvent) {
    if (p.enabled === false) return
    const t = e.touches[0]
    startX = t.clientX
    startY = t.clientY
    lastX = startX
    active = true
    lockedToAxis = null
    node.style.transition = 'none'
  }

  function onMove(e: TouchEvent) {
    if (!active) return
    const t = e.touches[0]
    lastX = t.clientX
    const dx = lastX - startX
    const dy = t.clientY - startY

    if (lockedToAxis === null) {
      if (Math.abs(dx) < DIRECTION_LOCK && Math.abs(dy) < DIRECTION_LOCK) return
      lockedToAxis = Math.abs(dx) > Math.abs(dy)
      // A vertical drag is the list scrolling — one axis per surface.
      if (!lockedToAxis) {
        active = false
        return
      }
    }

    // Leftward only, and never further than the row is wide.
    const base = revealed ? -p.revealWidth : 0
    const next = Math.max(-node.offsetWidth, Math.min(0, base + dx))
    setOffset(next)
  }

  function onEnd() {
    if (!active) return
    active = false
    lockedToAxis = null

    const base = revealed ? -p.revealWidth : 0
    const travel = -(base + (lastX - startX))
    if (travel > node.offsetWidth * FULL_SWIPE_RATIO) {
      // The tile fills before the row leaves: on the web there is no haptic to
      // confirm the commit, so the confirmation has to be visual.
      node.style.transition = SETTLE
      setOffset(-node.offsetWidth)
      p.onFullSwipe()
      return
    }
    settle(travel > REVEAL_COMMIT)
  }

  node.addEventListener('touchstart', onStart, { passive: true })
  node.addEventListener('touchmove', onMove, { passive: true })
  node.addEventListener('touchend', onEnd)
  node.addEventListener('touchcancel', onEnd)

  return {
    update(next: SwipeActionsParams) {
      p = next
      // The host closed this row — another one opened, or its action ran.
      // Announce nothing: this is the host's own decision coming back.
      if ((!p.enabled || !p.open) && revealed) settle(false, false)
      else if (p.open && !revealed) settle(true, false)
    },
    destroy() {
      node.removeEventListener('touchstart', onStart)
      node.removeEventListener('touchmove', onMove)
      node.removeEventListener('touchend', onEnd)
      node.removeEventListener('touchcancel', onEnd)
    },
  }
}
