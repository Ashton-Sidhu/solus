// Two-finger horizontal trackpad swipes go back and forward, like a browser.
// DOM wheel events carry no touch phase, so the lift is read from the events
// themselves: macOS's coasting tail, an empty wheel event, or Chromium's
// `gestureScrollEnd`, which the desktop main process forwards.

export type SwipeDirection = 'back' | 'forward'

/** How far the fingers travel before a release navigates. */
export const SWIPE_TRIGGER_DISTANCE = 120
/** Movement needed before the gesture picks an axis; first events are often diagonal. */
const SWIPE_AXIS_LOCK_DISTANCE = 8
/** A pause this long before the lift means the fingers held still: cancel. */
const SWIPE_HOLD_MS = 300
const MOMENTUM_SAMPLE_SIZE = 5

/** The parts of a `WheelEvent` the gesture reads. */
export interface SwipeWheel {
  deltaX: number
  deltaY: number
  /** Pinch-zoom arrives as a wheel event with ctrl held. */
  ctrlKey: boolean
  /** Only pixel deltas come from a trackpad; line and page deltas are a mouse wheel. */
  isPixelDelta: boolean
  clientY: number
  timeStamp: number
}

/** What the page under the pointer says about a swipe that starts there. */
export interface SwipeTarget {
  /** A dialog or an ancestor that can still scroll this way takes the wheel. */
  takesHorizontalWheel(deltaX: number): boolean
  canNavigate(direction: SwipeDirection): boolean
}

export interface SwipeIndicator {
  direction: SwipeDirection
  /** 0 to 1; at 1 a release navigates. */
  progress: number
  clientY: number
}

type SwipeGesture =
  | { kind: 'pending'; target: SwipeTarget; clientY: number; sumX: number; sumY: number }
  | {
      kind: 'tracking'
      direction: SwipeDirection
      distance: number
      deltas: number[]
      clientY: number
      lastAt: number
    }
  // Not a swipe, or one already decided: the rest of its events are ignored.
  | { kind: 'ignored' }

export interface SwipeStep {
  indicator: SwipeIndicator | null
  navigate: SwipeDirection | null
}

/**
 * macOS momentum after the fingers lift decays by a near-constant ratio per
 * event; finger movement is noisier. Deltas are signed along the swipe.
 */
export function isMomentumTail(deltas: readonly number[]): boolean {
  if (deltas.length < MOMENTUM_SAMPLE_SIZE) return false
  const recent = deltas.slice(-MOMENTUM_SAMPLE_SIZE)
  if (recent.some((delta) => delta <= 0)) return false
  const ratios = recent.slice(1).map((delta, index) => delta / recent[index])
  return ratios.every((ratio) => ratio >= 0.7 && ratio < 1) && Math.max(...ratios) - Math.min(...ratios) < 0.1
}

/** One trackpad gesture at a time, from the first wheel event to the lift. */
export class HistorySwipe {
  private gesture: SwipeGesture | null = null

  /** Chromium starts a trackpad scroll: a new gesture may begin. */
  scrollBegin(): void {
    if (this.gesture?.kind === 'ignored') this.gesture = null
  }

  /** Chromium ends a trackpad scroll, momentum included: the fingers are up. */
  scrollEnd(now: number): SwipeStep {
    const step = this.gesture?.kind === 'tracking' ? this.release(now) : idle()
    this.gesture = null
    return step
  }

  /** `target` is read once, when the gesture picks its axis. */
  wheel(event: SwipeWheel, target: () => SwipeTarget): SwipeStep {
    if (this.gesture === null) {
      this.gesture =
        event.ctrlKey || !event.isPixelDelta
          ? { kind: 'ignored' }
          : { kind: 'pending', target: target(), clientY: event.clientY, sumX: 0, sumY: 0 }
    }
    const gesture = this.gesture
    if (gesture.kind === 'ignored') return idle()
    if (gesture.kind === 'pending') {
      gesture.sumX += event.deltaX
      gesture.sumY += event.deltaY
      if (Math.abs(gesture.sumX) + Math.abs(gesture.sumY) < SWIPE_AXIS_LOCK_DISTANCE) return idle()
      this.gesture = lockAxis(gesture, event.timeStamp)
      return this.show()
    }
    if (event.deltaX === 0 && event.deltaY === 0) return this.release(event.timeStamp)
    const delta = gesture.direction === 'back' ? -event.deltaX : event.deltaX
    gesture.deltas.push(delta)
    if (gesture.deltas.length > MOMENTUM_SAMPLE_SIZE) gesture.deltas.shift()
    if (isMomentumTail(gesture.deltas)) return this.release(event.timeStamp)
    // A pause, then movement again: the fingers are still down, so keep going.
    gesture.lastAt = event.timeStamp
    gesture.distance = Math.max(0, gesture.distance + delta)
    return this.show()
  }

  /** The fingers lifted: navigate if the swipe went far enough without a hold,
   *  then ignore the rest of the gesture, its momentum included. */
  private release(now: number): SwipeStep {
    const gesture = this.gesture
    this.gesture = { kind: 'ignored' }
    if (gesture?.kind !== 'tracking') return idle()
    const held = now - gesture.lastAt >= SWIPE_HOLD_MS
    const far = gesture.distance >= SWIPE_TRIGGER_DISTANCE
    return { indicator: null, navigate: far && !held ? gesture.direction : null }
  }

  private show(): SwipeStep {
    const gesture = this.gesture
    if (gesture?.kind !== 'tracking') return idle()
    return {
      indicator: {
        direction: gesture.direction,
        progress: Math.min(1, gesture.distance / SWIPE_TRIGGER_DISTANCE),
        clientY: gesture.clientY,
      },
      navigate: null,
    }
  }
}

function idle(): SwipeStep {
  return { indicator: null, navigate: null }
}

function lockAxis(pending: Extract<SwipeGesture, { kind: 'pending' }>, now: number): SwipeGesture {
  const { target, sumX, sumY } = pending
  if (Math.abs(sumX) <= Math.abs(sumY)) return { kind: 'ignored' }
  if (target.takesHorizontalWheel(sumX)) return { kind: 'ignored' }
  const direction: SwipeDirection = sumX < 0 ? 'back' : 'forward'
  if (!target.canNavigate(direction)) return { kind: 'ignored' }
  return { kind: 'tracking', direction, distance: Math.abs(sumX), deltas: [], clientY: pending.clientY, lastAt: now }
}

/** The parts of an element the scroll check reads. */
export interface ScrollableElement<Parent = unknown> {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
  parentElement: Parent | null
}

/** Whether `element` or an ancestor can still scroll horizontally the way the
 *  wheel moves. A diff, a code block, or a wide table keeps its own wheel. */
export function canScrollHorizontally<E extends ScrollableElement<E>>(
  element: E | null,
  deltaX: number,
  overflowX: (element: E) => string,
): boolean {
  for (let current = element; current; current = current.parentElement) {
    if (current.scrollWidth <= current.clientWidth) continue
    const overflow = overflowX(current)
    if (overflow !== 'auto' && overflow !== 'scroll') continue
    const canScroll =
      deltaX < 0 ? current.scrollLeft > 0 : current.scrollLeft + current.clientWidth < current.scrollWidth - 1
    if (canScroll) return true
  }
  return false
}

/** The `SwipeWheel` of a DOM wheel event. */
export function swipeWheelOf(event: WheelEvent): SwipeWheel {
  return {
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    ctrlKey: event.ctrlKey,
    isPixelDelta: event.deltaMode === WheelEvent.DOM_DELTA_PIXEL,
    clientY: event.clientY,
    timeStamp: event.timeStamp,
  }
}

/** What the page says about a swipe that starts on `target`. */
export function swipeTargetAt(
  target: EventTarget | null,
  canNavigate: (direction: SwipeDirection) => boolean,
): SwipeTarget {
  const element = target instanceof Element ? target : null
  return {
    takesHorizontalWheel: (deltaX) =>
      !!element?.closest('[role="dialog"]') ||
      canScrollHorizontally<Element>(element, deltaX, (current) => getComputedStyle(current).overflowX),
    canNavigate,
  }
}

export interface SwipeAreaBounds {
  left: number
  top: number
  width: number
  height: number
}

/** The main content area the indicator peeks into: everything right of the sidebar. */
export function swipeAreaBounds(): SwipeAreaBounds {
  const area = document.querySelector('[data-history-swipe-area]') ?? document.documentElement
  const { left, top, width, height } = area.getBoundingClientRect()
  return { left, top, width, height }
}
