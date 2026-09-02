/**
 * When a press on a picker row stops being a press.
 *
 * A phone reaches the picker's preview only through press-and-hold, so the rule
 * that cancels the hold decides whether the surface exists at all. The obvious
 * rule — cancel on any `pointermove` — reads well and never fires the peek: a
 * finger resting on glass emits a stream of sub-pixel moves, so the first frame
 * after touchdown cancels the timer every time.
 *
 * The honest question is not "did the pointer move" but "is this a scroll". A
 * scroll travels; a thumb held still does not. `TOUCH_SLOP_PX` is the distance
 * that separates them, and it is the same slop a native list uses to decide
 * between a tap and a drag.
 */
export const TOUCH_SLOP_PX = 10

export interface PressPoint {
  x: number
  y: number
}

/** True once the pointer has travelled far enough to be a scroll, not a hold. */
export function hasLeftPress(origin: PressPoint, x: number, y: number): boolean {
  return Math.hypot(x - origin.x, y - origin.y) > TOUCH_SLOP_PX
}
