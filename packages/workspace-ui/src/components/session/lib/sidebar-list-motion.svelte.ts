// Adapted from T3 Code's Sidebar.motion.ts (MIT, Copyright (c) 2026 T3 Tools Inc.).
// Rows in one list move as in pingdotgg/t3code@bf961f812: every row that keeps
// its place in the list slides to its new position. The glide between section
// lists is Solus's own, because each Solus section is its own list.

// A filter change or a search swaps a large part of the list at once. Fades
// are the expensive part — every removed row gets a deep clone, and every
// clone and entering row gets its own animation — so past this many the list
// updates without motion. Translating displaced rows is cheap and never counts.
const MAX_FADED_ROWS_PER_UPDATE = 40
/** How far a row that has no neighbour to ride with travels as it fades. */
const rowTravel = (height: number) => Math.min(height, 40)

type RowPosition = { top: number; left: number; width: number; height: number }
type Band = { top: number; bottom: number }
type Origin = { top: number; left: number }

/** A row that left one list or came into one, at its drawn place in the window. */
type RowPlace = { node: HTMLElement; position: RowPosition; windowTop: number; windowLeft: number; isSeen: boolean }

/** One list's reading for one frame, between its layout reads and its writes. */
type Pass = {
  apply: (glides: CrossListGlides) => void
  /** Rows that left this list, by row key. Empty when this pass does not animate. */
  departures: Map<string, RowPlace>
  /** Rows that came into this list, by row key. Empty when this pass does not animate. */
  arrivals: Map<string, RowPlace>
}

/** Rows that glide from another list (or another shape in this one). The
 *  departing row takes no fade of its own, and the arriving row takes the glide. */
type CrossListGlides = { departed: Set<HTMLElement>; arrived: Map<HTMLElement, RowPlace> }

const NO_GLIDES: CrossListGlides = { departed: new Set(), arrived: new Map() }

/** The attribute that names a row across lists: the same session in another
 *  section, or in another shape, has the same key. */
const ROW_KEY_ATTRIBUTE = 'data-sidebar-row-key'
/** The element a glide between lists is drawn in: an ancestor of every list
 *  that does not clip them, so a row can travel between scroll containers. */
const MOTION_LAYER_SELECTOR = '[data-sidebar-motion-layer]'

function progress(animation: Animation): number {
  return animation.playState === 'finished'
    ? 1
    : (animation.effect?.getComputedTiming().progress ?? 0)
}

/** An inert copy of a row for a fade or a glide. Svelte owns the removed row;
 *  the copy must not be a tree item the keyboard can land on, or a row the
 *  sidebar's own queries find. */
function inertCopy(node: HTMLElement): HTMLElement {
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
  return clone
}

function placeCopy(clone: HTMLElement, top: number, left: number, position: RowPosition): void {
  Object.assign(clone.style, {
    position: 'absolute',
    top: `${top}px`,
    left: `${left}px`,
    width: `${position.width}px`,
    height: `${position.height}px`,
    margin: '0',
    boxSizing: 'border-box',
    // A row can skip its rendering (`content-visibility: auto`); the copy
    // must always paint while it moves.
    contentVisibility: 'visible',
    transform: 'none',
    transition: 'none',
    pointerEvents: 'none',
  })
}

/**
 * The lists that changed order in this frame, read together and then written
 * together. A session that changes section leaves one list and comes into
 * another in the same update, so only a pass over both can see one row move.
 */
const pendingLists = new WeakMap<Window, { lists: Set<FrameList>; frame: number }>()

/** What the shared pass needs from one list's motion. */
interface FrameList {
  read(): Pass | null
  endFrame(): void
}

function runPasses(motions: Iterable<FrameList>): void {
  // Every layout read happens before any animation starts.
  const passes = [...motions].map((motion) => motion.read()).filter((pass): pass is Pass => pass !== null)
  const glides = new Map<Pass, CrossListGlides>()
  const glidesOf = (pass: Pass) => {
    let found = glides.get(pass)
    if (!found) glides.set(pass, (found = { departed: new Set(), arrived: new Map() }))
    return found
  }
  for (const to of passes) {
    for (const [key, arrival] of to.arrivals) {
      const from = passes.find((pass) => pass.departures.has(key))
      const departure = from?.departures.get(key)
      if (!from || !departure || !(departure.isSeen || arrival.isSeen)) continue
      glidesOf(from).departed.add(departure.node)
      glidesOf(to).arrived.set(arrival.node, departure)
    }
  }
  for (const pass of passes) pass.apply(glides.get(pass) ?? NO_GLIDES)
}

/**
 * Animate a list's direct children between their layout positions. A row that
 * stays in the list slides from where it was drawn to its new place. A row
 * that arrives fades in and a row that leaves fades out, each riding with the
 * row before it. A row that leaves for another list (another section, or the
 * same session in another shape) glides there in the motion layer.
 *
 * Positions are read only when an update runs, so the caller decides when
 * a layout read is worth it — on an order change, not on every re-render. The
 * list must be positioned (`relative`) so every child's `offsetTop` shares one
 * origin with the copies of leaving rows.
 *
 * `durationMs` is read at each update, so a change in Settings applies to the
 * next change of order. 0 updates without motion, as reduced motion does.
 *
 * `scroller` is the element the list scrolls in. Only rows that pass through
 * its visible part move or fade. When the list overflows, a row that goes to
 * another section displaces every row between its two places, and most of
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
  // Where the list stood in the window, and how far its scroller had scrolled,
  // when `positions` was read. A row that left for another list starts there.
  let readOrigin: Origin = { top: 0, left: 0 }
  let readScrollTop = 0
  let disposed = false
  const view = parent.ownerDocument.defaultView
  const reducedMotion = view?.matchMedia('(prefers-reduced-motion: reduce)')
  let scrollElement: HTMLElement | undefined
  let scrollTop = 0
  let isFramePending = false
  const trackScroll = () => {
    // The frame reads the new layout. Keep the previous offset if the browser
    // delivers its scroll event for that layout first.
    if (!isFramePending) scrollTop = scrollElement?.scrollTop ?? 0
  }
  const bindScroller = (element: HTMLElement | undefined) => {
    if (scrollElement === element) return
    scrollElement?.removeEventListener('scroll', trackScroll)
    scrollElement = element
    scrollTop = element?.scrollTop ?? 0
    element?.addEventListener('scroll', trackScroll, { passive: true })
  }
  const isRow = (node: Element): node is HTMLElement =>
    !!view && node instanceof view.HTMLElement && !exiting.has(node)
  const running = new Map<HTMLElement, { animation: Animation; offset: number }>()
  const entering = new Map<HTMLElement, { animation: Animation; travel: number }>()
  const exiting = new Map<HTMLElement, Animation>()

  /** How far a row still is from its place, in its slide and its entry. */
  const remainingOffset = (node: HTMLElement) => {
    const current = running.get(node)
    const run = current ? current.offset * (1 - progress(current.animation)) : 0
    const entry = entering.get(node)
    const enter = entry ? entry.travel * (1 - progress(entry.animation)) : 0
    return run + enter
  }
  const clearFades = () => {
    for (const entry of entering.values()) entry.animation.cancel()
    for (const animation of exiting.values()) animation.cancel()
    for (const node of exiting.keys()) node.remove()
    entering.clear()
    exiting.clear()
  }
  const track = (copy: HTMLElement, animation: Animation) => {
    exiting.set(copy, animation)
    animation.addEventListener(
      'finish',
      () => {
        copy.remove()
        exiting.delete(copy)
      },
      { once: true },
    )
  }
  const fadeOut = (node: HTMLElement, position: RowPosition, travel: number, shift: number) => {
    if (position.height === 0) return
    const copy = inertCopy(node)
    placeCopy(copy, position.top + remainingOffset(node) + shift, position.left, position)
    parent.append(copy)
    const entry = entering.get(node)
    const entryProgress = entry ? progress(entry.animation) : 1
    track(copy, copy.animate(
      [
        { opacity: entryProgress, transform: 'translateY(0px)' },
        { opacity: 0, transform: `translateY(${travel}px)` },
      ],
      motionTiming(),
    ))
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
    const entry = entering.get(node)
    if (entry) entry.travel = 0
    if (offset === 0 && !entry) return
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
  const fadeIn = (node: HTMLElement, travel: number) => {
    const animation = node.animate(
      [
        { opacity: 0, transform: `translateY(${travel}px)` },
        { opacity: 1, transform: 'translateY(0px)' },
      ],
      motionTiming(),
    )
    entering.set(node, { animation, travel })
    animation.addEventListener(
      'finish',
      () => {
        if (entering.get(node)?.animation === animation) entering.delete(node)
      },
      { once: true },
    )
  }

  /**
   * A row that came from another list glides from where it was drawn there.
   * Each list clips its rows to its own scroller, so a copy of the old row
   * travels in the motion layer, over both lists. A row that keeps its shape
   * shows at the end of the glide; a row that changes shape (card to slim)
   * fades in as the copy of the old shape fades out.
   */
  const glideIn = (node: HTMLElement, arrival: RowPlace, departure: RowPlace) => {
    const layer = parent.closest<HTMLElement>(MOTION_LAYER_SELECTOR)
    const distance = arrival.windowTop - departure.windowTop
    if (!layer) {
      fadeIn(node, -rowTravel(arrival.position.height))
      return
    }
    const layerBox = layer.getBoundingClientRect()
    const copy = inertCopy(departure.node)
    placeCopy(copy, departure.windowTop - layerBox.top, departure.windowLeft - layerBox.left, departure.position)
    copy.style.zIndex = '1'
    layer.append(copy)
    const keepsRowHeight = Math.abs(departure.position.height - arrival.position.height) < 1
    track(copy, copy.animate(
      [
        { opacity: 1, transform: 'translateY(0px)' },
        { opacity: keepsRowHeight ? 1 : 0, transform: `translateY(${distance}px)` },
      ],
      motionTiming(),
    ))
    const animation = node.animate(
      keepsRowHeight
        ? [{ opacity: 0 }, { opacity: 0, offset: 0.99 }, { opacity: 1 }]
        : [{ opacity: 0, transform: `translateY(${-distance}px)` }, { opacity: 1, transform: 'translateY(0px)' }],
      motionTiming(),
    )
    entering.set(node, { animation, travel: keepsRowHeight ? 0 : -distance })
    animation.addEventListener(
      'finish',
      () => {
        if (entering.get(node)?.animation === animation) entering.delete(node)
      },
      { once: true },
    )
  }

  /** The scroller's visible part, in the coordinates of `offsetTop`. */
  const visibleBand = (element: HTMLElement | undefined, origin: Origin): Band => {
    if (!element) return { top: -Infinity, bottom: Infinity }
    const top = element.getBoundingClientRect().top - origin.top
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

  /** How far the rows moved with the scroller: `shift`, the clamp that a
   *  removal near the bottom causes, and the whole scroll since the last read. */
  const readScroll = (element: HTMLElement | undefined) => {
    if (!element) return { shift: 0, scrolledSinceRead: 0 }
    // Removing a row near the bottom can clamp scrollTop. Use the old
    // on-screen positions so the rows slide instead of jumping with the clamp.
    const max = Math.max(0, element.scrollHeight - element.clientHeight)
    const currentScrollTop = element.scrollTop
    const shift = scrollTop > max && currentScrollTop >= max - 1 ? currentScrollTop - scrollTop : 0
    const scrolledSinceRead = scrollTop - readScrollTop
    scrollTop = currentScrollTop
    return { shift, scrolledSinceRead }
  }

  /** Rows in view that leave or arrive, each of which costs a fade. */
  const countFades = (previous: Map<HTMLElement, RowPosition>, next: Map<HTMLElement, RowPosition>, band: Band, shift: number) => {
    let count = 0
    for (const [node, { top, height }] of previous) {
      const drawnTop = top + remainingOffset(node) + shift
      if (!next.has(node) && isSeen(band, drawnTop, drawnTop, height)) count++
    }
    for (const [node, { top, height }] of next) {
      if (!previous.has(node) && isSeen(band, top, top, height)) count++
    }
    return count
  }

  /** The rows that left this list and the rows that came into it, by row key,
   *  at their drawn places in the window. */
  const rowPlaces = (
    previous: Map<HTMLElement, RowPosition>,
    next: Map<HTMLElement, RowPosition>,
    from: Origin,
    to: Origin,
    band: Band,
    shift: number,
  ) => {
    const departures = new Map<string, RowPlace>()
    const arrivals = new Map<string, RowPlace>()
    for (const [node, position] of previous) {
      const key = next.has(node) ? null : node.getAttribute(ROW_KEY_ATTRIBUTE)
      if (!key) continue
      const drawnTop = position.top + remainingOffset(node)
      departures.set(key, {
        node,
        position,
        windowTop: from.top + drawnTop,
        windowLeft: from.left + position.left,
        isSeen: isSeen(band, drawnTop + shift, drawnTop + shift, position.height),
      })
    }
    for (const [node, position] of next) {
      const key = previous.has(node) ? null : node.getAttribute(ROW_KEY_ATTRIBUTE)
      if (!key) continue
      arrivals.set(key, {
        node,
        position,
        windowTop: to.top + position.top,
        windowLeft: to.left + position.left,
        isSeen: isSeen(band, position.top, position.top, position.height),
      })
    }
    return { departures, arrivals }
  }

  /** How far each row that stays moves, from where it is drawn to its new
   *  place, and the delta a row that arrives or leaves rides with: that of the
   *  nearest row before it that stays, so it moves with its neighbours
   *  instead of against them. */
  const slideDeltas = (previous: Map<HTMLElement, RowPosition>, next: Map<HTMLElement, RowPosition>, shift: number) => {
    const movedDelta = new Map<HTMLElement, number>()
    for (const [node, position] of next) {
      const previousTop = previous.get(node)?.top
      if (previousTop === undefined || previousTop + shift === position.top) continue
      movedDelta.set(node, previousTop + remainingOffset(node) - position.top + shift)
    }
    const ridingDelta = (order: readonly HTMLElement[], index: number, retained: (node: HTMLElement) => boolean) => {
      for (let cursor = index - 1; cursor >= 0; cursor--) {
        const node = order[cursor]!
        const delta = movedDelta.get(node)
        if (delta !== undefined) return delta
        if (retained(node)) return remainingOffset(node)
      }
      return undefined
    }
    return { movedDelta, ridingDelta }
  }

  /** Drop motion that belongs to rows no longer in the list. */
  const dropLeftRows = (next: Map<HTMLElement, RowPosition>) => {
    for (const [node, entry] of entering) {
      if (!next.has(node)) {
        entry.animation.cancel()
        entering.delete(node)
      }
    }
    for (const node of running.keys()) {
      if (!next.has(node)) cancel(node)
    }
  }

  /** Read this list's new layout. Null when there is nothing to animate or
   *  record, as for a hidden list. */
  const read = (animate: boolean): Pass | null => {
    if (disposed) return null
    const element = scroller()
    bindScroller(element)
    if (parent.getClientRects().length === 0) {
      suspend()
      return null
    }
    const next = readPositions()
    const box = parent.getBoundingClientRect()
    const origin = { top: box.top, left: box.left }
    const { shift, scrolledSinceRead } = readScroll(element)
    const previous = positions
    // Where the old rows are drawn now: the list's place at the last read,
    // moved by the scroll since then.
    const previousOrigin = { top: readOrigin.top - scrolledSinceRead, left: readOrigin.left }
    const band = visibleBand(element, origin)
    const shouldAnimate =
      animate &&
      previous !== null &&
      !reducedMotion?.matches &&
      durationMs() > 0 &&
      countFades(previous, next, band, shift) <= MAX_FADED_ROWS_PER_UPDATE
    const { departures, arrivals } = shouldAnimate
      ? rowPlaces(previous!, next, previousOrigin, origin, band, shift)
      : { departures: new Map<string, RowPlace>(), arrivals: new Map<string, RowPlace>() }
    positions = next
    readOrigin = origin
    readScrollTop = scrollTop

    const apply = (glides: CrossListGlides) => {
      if (!shouldAnimate || !previous) {
        clearFades()
        for (const node of running.keys()) cancel(node)
        return
      }
      const { movedDelta, ridingDelta } = slideDeltas(previous, next, shift)
      // A leaving row fades from its drawn position before any slide in
      // flight is cancelled. A row that glides to another list has no fade.
      const oldOrder = [...previous.keys()]
      for (const [index, node] of oldOrder.entries()) {
        if (next.has(node) || glides.departed.has(node)) continue
        const position = previous.get(node)!
        const drawnTop = position.top + remainingOffset(node) + shift
        if (!isSeen(band, drawnTop, drawnTop, position.height)) continue
        const delta = ridingDelta(oldOrder, index, (candidate) => next.has(candidate))
        fadeOut(node, position, delta === undefined ? rowTravel(position.height) : -delta, shift)
      }
      dropLeftRows(next)
      const nextOrder = [...next.keys()]
      for (const [index, node] of nextOrder.entries()) {
        const position = next.get(node)!
        const departure = glides.arrived.get(node)
        const arrival = arrivals.get(node.getAttribute(ROW_KEY_ATTRIBUTE) ?? '')
        if (departure && arrival) glideIn(node, arrival, departure)
        else if (!previous.has(node)) {
          if (!isSeen(band, position.top, position.top, position.height)) continue
          const delta = ridingDelta(nextOrder, index, (candidate) => previous.has(candidate))
          fadeIn(node, delta === undefined ? -rowTravel(position.height) : delta)
        } else {
          const delta = movedDelta.get(node)
          if (delta === undefined) continue
          if (isSeen(band, position.top + delta, position.top, position.height)) move(node, delta)
          else cancel(node)
        }
      }
    }
    return { apply, departures, arrivals }
  }

  const motion: FrameList & { update(animate: boolean): void; scheduleUpdate(): void; dispose(): void } = {
    /** Read this list for a shared pass over the lists that changed. */
    read: () => read(true),
    /** Read and animate this list alone. */
    update(animate: boolean) {
      if (!animate) {
        read(false)?.apply(NO_GLIDES)
        return
      }
      runPasses([motion])
    },
    scheduleUpdate() {
      // Coalesce layout reads and run after the DOM update, before it paints.
      // Every list that changed in this frame runs in one pass, so a row that
      // moves between lists is seen leaving one and arriving in the other.
      if (!view || disposed || isFramePending) return
      isFramePending = true
      let pending = pendingLists.get(view)
      if (!pending) pendingLists.set(view, (pending = { lists: new Set(), frame: 0 }))
      pending.lists.add(motion)
      if (pending.frame) return
      const shared = pending
      shared.frame = view.requestAnimationFrame(() => {
        shared.frame = 0
        const lists = [...shared.lists]
        shared.lists.clear()
        for (const list of lists) list.endFrame()
        runPasses(lists)
      })
    },
    /** The shared frame has started for this list. */
    endFrame() {
      isFramePending = false
    },
    dispose() {
      if (view) pendingLists.get(view)?.lists.delete(motion)
      isFramePending = false
      bindScroller(undefined)
      suspend()
      disposed = true
    },
  }
  return motion
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
