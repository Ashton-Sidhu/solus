// Adapted from T3 Code's Sidebar.motion.ts (MIT, Copyright (c) 2026 T3 Tools Inc.).
// Scroll clamping follows pingdotgg/t3code@bcb9217e8.

// A filter change or a search swaps a large part of the list at once. Fades
// are the expensive part — every removed row gets a deep clone, and every
// clone and entering row gets its own animation — so past this many the list
// updates without motion. Translating displaced rows is cheap and never counts.
const MAX_FADED_ROWS_PER_UPDATE = 40
// A row that changes order crosses its neighbours. It fades out at its old
// place and in at its new one, and the two fades do not overlap, so the rows
// never slide through each other.
const EXIT_FADE_END = 0.4
const ENTRY_FADE_START = 0.6
// A move longer than this many row heights also fades instead of slides.
const MAX_SLIDE_ROWS = 1.5

type RowPosition = { top: number; left: number; width: number; height: number }
type Band = { top: number; bottom: number }

function progress(animation: Animation): number {
  return animation.playState === 'finished'
    ? 1
    : (animation.effect?.getComputedTiming().progress ?? 0)
}

/** The opacity of an entering row, which stays 0 until `ENTRY_FADE_START`. */
function entryOpacity(animation: Animation): number {
  return Math.max(0, (progress(animation) - ENTRY_FADE_START) / (1 - ENTRY_FADE_START))
}

/** Rows kept in the list that changed order: every row out of the longest run
 *  that kept its previous order. */
function crossingRows(previousOrder: readonly HTMLElement[], nextOrder: readonly HTMLElement[]) {
  const previousIndex = new Map(previousOrder.map((node, index) => [node, index] as const))
  const retained = nextOrder.filter((node) => previousIndex.has(node))
  const tails: number[] = []
  const predecessor: number[] = []
  for (const [index, node] of retained.entries()) {
    const value = previousIndex.get(node)!
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (previousIndex.get(retained[tails[middle]!]!)! < value) low = middle + 1
      else high = middle
    }
    predecessor[index] = low > 0 ? tails[low - 1]! : -1
    tails[low] = index
  }
  const ordered = new Set<HTMLElement>()
  for (let index = tails.at(-1) ?? -1; index >= 0; index = predecessor[index]!) {
    ordered.add(retained[index]!)
  }
  return new Set(retained.filter((node) => !ordered.has(node)))
}

/**
 * Animate a list's direct children between their layout positions: a row that
 * arrives fades in, a row that leaves fades out where it stood, and every row
 * displaced by either slides to its new place.
 *
 * Positions are read only when `update` is called, so the caller decides when
 * a layout read is worth it — on an order change, not on every re-render. The
 * list must be positioned (`relative`) so every child's `offsetTop` shares one
 * origin with the clones of leaving rows.
 *
 * `durationMs` is read at each update, so a change in Settings applies to the
 * next change of order. 0 updates without motion, as reduced motion does.
 *
 * `scroller` is the element the list scrolls in. Only rows that pass through
 * its visible part move or fade. When the list overflows, a row that goes to
 * the Completed shelf displaces every row between its two places, and most of
 * them are below the fold. One animation for each of them made the change lag,
 * and nobody saw that motion.
 */
export function createSidebarListMotion(
  parent: HTMLElement,
  durationMs: () => number,
  scroller: () => HTMLElement | undefined = () => undefined,
) {
  const motionTiming = (): KeyframeAnimationOptions => ({ duration: durationMs(), easing: 'ease-out' })
  let positions: Map<HTMLElement, RowPosition> | null = null
  let disposed = false
  const view = parent.ownerDocument.defaultView
  const reducedMotion = view?.matchMedia('(prefers-reduced-motion: reduce)')
  let scrollElement: HTMLElement | undefined
  let scrollTop = 0
  const trackScroll = () => {
    // The frame reads the new layout. Keep the previous offset if the browser
    // delivers its scroll event for that layout first.
    if (!frame) scrollTop = scrollElement?.scrollTop ?? 0
  }
  const bindScroller = (element: HTMLElement | undefined) => {
    if (scrollElement === element) return
    scrollElement?.removeEventListener('scroll', trackScroll)
    scrollElement = element
    scrollTop = element?.scrollTop ?? 0
    element?.addEventListener('scroll', trackScroll, { passive: true })
  }
  let frame = 0
  const isRow = (node: Element): node is HTMLElement =>
    !!view && node instanceof view.HTMLElement && !exiting.has(node)
  const running = new Map<HTMLElement, { animation: Animation; offset: number }>()
  const entering = new Map<HTMLElement, Animation>()
  const exiting = new Map<HTMLElement, Animation>()

  const remainingOffset = (node: HTMLElement) => {
    const current = running.get(node)
    return current ? current.offset * (1 - progress(current.animation)) : 0
  }
  const clearFades = () => {
    for (const animation of [...entering.values(), ...exiting.values()]) animation.cancel()
    for (const node of exiting.keys()) node.remove()
    entering.clear()
    exiting.clear()
  }
  const fadeOut = (node: HTMLElement, position: RowPosition, scrollShift: number) => {
    if (position.height === 0) return
    // Svelte owns the removed row; only an inert copy stays for the fade. It
    // must not be a tree item the keyboard can land on, or a row the sidebar's
    // own queries find.
    // SAFETY: a deep clone of an HTMLElement is an HTMLElement of the same kind.
    const clone = node.cloneNode(true) as HTMLElement
    for (const element of [clone, ...clone.querySelectorAll('*')]) {
      for (const attribute of Array.from(element.attributes)) {
        if (
          (attribute.name === 'id' && element.namespaceURI !== 'http://www.w3.org/2000/svg') ||
          attribute.name === 'role' ||
          attribute.name === 'tabindex' ||
          attribute.name.startsWith('data-') ||
          attribute.name.startsWith('aria-')
        ) {
          element.removeAttribute(attribute.name)
        }
      }
    }
    clone.setAttribute('aria-hidden', 'true')
    clone.inert = true
    Object.assign(clone.style, {
      position: 'absolute',
      top: `${position.top + remainingOffset(node) + scrollShift}px`,
      left: `${position.left}px`,
      width: `${position.width}px`,
      height: `${position.height}px`,
      margin: '0',
      boxSizing: 'border-box',
      // A row can skip its rendering (`content-visibility: auto`); the copy
      // must always paint while it fades.
      contentVisibility: 'visible',
      transform: 'none',
      transition: 'none',
      pointerEvents: 'none',
    })
    parent.append(clone)
    const entry = entering.get(node)
    const animation = clone.animate(
      [{ opacity: entry ? entryOpacity(entry) : 1 }, { opacity: 0, offset: EXIT_FADE_END }, { opacity: 0 }],
      motionTiming(),
    )
    exiting.set(clone, animation)
    animation.addEventListener(
      'finish',
      () => {
        clone.remove()
        exiting.delete(clone)
      },
      { once: true },
    )
  }

  const cancel = (node: HTMLElement) => {
    running.get(node)?.animation.cancel()
    running.delete(node)
  }
  const suspend = () => {
    for (const node of running.keys()) cancel(node)
    clearFades()
    positions = null
  }
  const move = (node: HTMLElement, offset: number) => {
    cancel(node)
    if (offset === 0) return
    const animation = node.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0px)' }],
      motionTiming(),
    )
    running.set(node, { animation, offset })
    animation.addEventListener(
      'finish',
      () => {
        if (running.get(node)?.animation === animation) running.delete(node)
      },
      { once: true },
    )
  }

  const fadeIn = (node: HTMLElement) => {
    const animation = node.animate(
      [{ opacity: 0 }, { opacity: 0, offset: ENTRY_FADE_START }, { opacity: 1 }],
      motionTiming(),
    )
    entering.set(node, animation)
    animation.addEventListener(
      'finish',
      () => {
        if (entering.get(node) === animation) entering.delete(node)
      },
      { once: true },
    )
  }

  /** The scroller's visible part, in the coordinates of `offsetTop`. */
  const visibleBand = (element: HTMLElement | undefined): Band => {
    if (!element) return { top: -Infinity, bottom: Infinity }
    const top = element.getBoundingClientRect().top - parent.getBoundingClientRect().top
    return { top, bottom: top + element.clientHeight }
  }
  /** Whether a row is in view at some time while it goes from `from` to `to`. */
  const isSeen = (band: Band, from: number, to: number, height: number) =>
    height > 0 && Math.min(from, to) < band.bottom && Math.max(from, to) + height > band.top

  const readPositions = () =>
    new Map(
      Array.from(parent.children)
        .filter(isRow)
        .map((node) => [
          node,
          {
            top: node.offsetTop,
            left: node.offsetLeft,
            width: node.offsetWidth,
            height: node.offsetHeight,
          },
        ]),
    )

  /** Rows that change order, or move too far to slide. */
  const findCrossing = (previous: Map<HTMLElement, RowPosition>, next: Map<HTMLElement, RowPosition>) => {
    const crossing = crossingRows([...previous.keys()], [...next.keys()])
    for (const [node, { top, height }] of next) {
      const previousTop = previous.get(node)?.top
      if (
        previousTop !== undefined &&
        height > 0 &&
        Math.abs(previousTop + remainingOffset(node) - top) > height * MAX_SLIDE_ROWS
      ) {
        crossing.add(node)
      }
    }
    return crossing
  }

  /** Rows in view in one reading and not in the other, which each cost a fade,
   *  and crossing rows in view, which cost two. */
  const countFades = (
    previous: Map<HTMLElement, RowPosition>,
    next: Map<HTMLElement, RowPosition>,
    crossing: Set<HTMLElement>,
    band: Band,
    scrollShift: number,
  ) => {
    let count = 0
    for (const [node, { top, height }] of previous) {
      if (next.has(node)) continue
      const drawnTop = top + remainingOffset(node) + scrollShift
      if (isSeen(band, drawnTop, drawnTop, height)) count++
    }
    for (const [node, { top, height }] of next) {
      if (!previous.has(node) && isSeen(band, top, top, height)) count++
    }
    for (const node of crossing) {
      const { top, height } = next.get(node)!
      const drawnTop = previous.get(node)!.top + remainingOffset(node) + scrollShift
      if (isSeen(band, drawnTop, top, height)) count += 2
    }
    return count
  }

  /** Drop motion that belongs to rows no longer in the list, or all of it when
   *  this update does not animate. */
  const settleStale = (next: Map<HTMLElement, RowPosition>, shouldAnimate: boolean) => {
    for (const [node, animation] of entering) {
      if (!next.has(node)) {
        animation.cancel()
        entering.delete(node)
      }
    }
    for (const node of running.keys()) {
      if (!shouldAnimate || !next.has(node)) cancel(node)
    }
  }

  /** Fade in the rows that arrived or crossed and slide the ones that moved, if
   *  they are in view. A row out of view goes to its place at once. */
  const animateRemaining = (
    previous: Map<HTMLElement, RowPosition>,
    next: Map<HTMLElement, RowPosition>,
    crossing: Set<HTMLElement>,
    band: Band,
    scrollShift: number,
  ) => {
    for (const [node, { top, height }] of next) {
      const previousTop = previous.get(node)?.top
      if (crossing.has(node)) {
        cancel(node)
        entering.get(node)?.cancel()
        entering.delete(node)
        if (isSeen(band, top, top, height)) fadeIn(node)
        continue
      }
      if (previousTop === undefined) {
        if (isSeen(band, top, top, height)) fadeIn(node)
        continue
      }
      if (previousTop + scrollShift === top) continue
      const drawnTop = previousTop + remainingOffset(node) + scrollShift
      if (isSeen(band, drawnTop, top, height)) move(node, drawnTop - top)
      else cancel(node)
    }
  }

  /** Read each row's position. Animate from the previous visible reading. */
  const update = (animate: boolean) => {
    if (disposed) return
    const element = scroller()
    bindScroller(element)
    if (parent.getClientRects().length === 0) {
      suspend()
      return
    }
    const next = readPositions()
    // Removing a row near the bottom can clamp scrollTop. Use the old
    // on-screen positions so the rows slide instead of jumping with the clamp.
    let scrollShift = 0
    if (element) {
      const max = Math.max(0, element.scrollHeight - element.clientHeight)
      const currentScrollTop = element.scrollTop
      if (scrollTop > max && currentScrollTop >= max - 1) scrollShift = currentScrollTop - scrollTop
      scrollTop = currentScrollTop
    }
    const previous = positions
    const band = visibleBand(element)
    const crossing = previous ? findCrossing(previous, next) : new Set<HTMLElement>()
    const shouldAnimate =
      animate &&
      previous !== null &&
      !reducedMotion?.matches &&
      durationMs() > 0 &&
      countFades(previous, next, crossing, band, scrollShift) <= MAX_FADED_ROWS_PER_UPDATE
    if (!shouldAnimate) clearFades()
    // A leaving or crossing row fades from its drawn position before any
    // slide in flight is cancelled.
    else {
      for (const [node, position] of previous) {
        if (next.has(node) && !crossing.has(node)) continue
        const drawnTop = position.top + remainingOffset(node) + scrollShift
        if (isSeen(band, drawnTop, drawnTop, position.height)) fadeOut(node, position, scrollShift)
      }
    }
    settleStale(next, shouldAnimate)
    if (shouldAnimate) animateRemaining(previous, next, crossing, band, scrollShift)
    positions = next
  }

  return {
    update,
    scheduleUpdate() {
      // Coalesce layout reads and run after the DOM update, before it paints.
      if (!view || disposed || frame) return
      frame = view.requestAnimationFrame(() => {
        frame = 0
        update(true)
      })
    },
    dispose() {
      if (frame) view?.cancelAnimationFrame(frame)
      bindScroller(undefined)
      suspend()
      disposed = true
    },
  }
}

/**
 * Attach list motion to a sidebar list. `orderKey` names its entries in order
 * (`sidebarListOrderKey`); the motion pass runs only when it changes. The
 * sidebar re-renders on every status, unread, and activity change, and reading
 * every row's layout on each of those is exactly the work that made the list
 * stutter.
 */
export function sidebarListMotion(
  orderKey: () => string,
  durationMs: () => number,
  scroller: () => HTMLElement | undefined,
) {
  return (list: HTMLElement) => {
    const motion = createSidebarListMotion(list, durationMs, scroller)
    // Derived, so a re-render that leaves the order as it was compares equal
    // and never reaches the effect below.
    const key = $derived(orderKey())
    $effect(() => {
      void key
      motion.scheduleUpdate()
    })
    return () => motion.dispose()
  }
}
