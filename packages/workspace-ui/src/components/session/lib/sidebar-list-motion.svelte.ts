// Adapted from T3 Code's sidebar list motion (apps/web/src/components/Sidebar.motion.ts,
// MIT License, Copyright (c) 2026 T3 Tools Inc.).

// A filter change or a search swaps a large part of the list at once. Fades
// are the expensive part — every removed row gets a deep clone, and every
// clone and entering row gets its own animation — so past this many the list
// updates without motion. Translating displaced rows is cheap and never counts.
const MAX_FADED_ROWS_PER_UPDATE = 40

type RowPosition = { top: number; left: number; width: number; height: number }

function progress(animation: Animation): number {
  return animation.playState === 'finished'
    ? 1
    : (animation.effect?.getComputedTiming().progress ?? 0)
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
 */
export function createSidebarListMotion(parent: HTMLElement, durationMs: () => number) {
  const motionTiming = (): KeyframeAnimationOptions => ({ duration: durationMs(), easing: 'ease-out' })
  let positions: Map<HTMLElement, RowPosition> | null = null
  let disposed = false
  const view = parent.ownerDocument.defaultView
  const reducedMotion = view?.matchMedia('(prefers-reduced-motion: reduce)')
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
  const fadeOut = (node: HTMLElement, position: RowPosition) => {
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
      top: `${position.top + remainingOffset(node)}px`,
      left: `${position.left}px`,
      width: `${position.width}px`,
      height: `${position.height}px`,
      margin: '0',
      boxSizing: 'border-box',
      transform: 'none',
      transition: 'none',
      pointerEvents: 'none',
    })
    parent.append(clone)
    const entry = entering.get(node)
    const animation = clone.animate(
      [{ opacity: entry ? progress(entry) : 1 }, { opacity: 0 }],
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
    const animation = node.animate([{ opacity: 0 }, { opacity: 1 }], motionTiming())
    entering.set(node, animation)
    animation.addEventListener(
      'finish',
      () => {
        if (entering.get(node) === animation) entering.delete(node)
      },
      { once: true },
    )
  }

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

  /** Rows in one reading and not the other, which each cost a fade. */
  const countFades = (
    previous: Map<HTMLElement, RowPosition>,
    next: Map<HTMLElement, RowPosition>,
  ) => {
    let count = 0
    for (const [node, position] of previous) {
      if (!next.has(node) && position.height > 0) count++
    }
    for (const [node, position] of next) {
      if (!previous.has(node) && position.height > 0) count++
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

  /** Fade in the rows that arrived and slide the ones that moved. */
  const animateRemaining = (
    previous: Map<HTMLElement, RowPosition>,
    next: Map<HTMLElement, RowPosition>,
  ) => {
    for (const [node, position] of next) {
      const previousTop = previous.get(node)?.top
      if (previousTop === undefined) {
        if (position.height > 0) fadeIn(node)
      } else if (previousTop !== position.top) {
        move(node, previousTop + remainingOffset(node) - position.top)
      }
    }
  }

  return {
    /** Read every row's position and animate from the last reading. `animate`
     *  false only takes the reading, for the first pass. */
    update(animate: boolean) {
      if (disposed) return
      const next = readPositions()
      const previous = positions
      const shouldAnimate =
        animate &&
        previous !== null &&
        !reducedMotion?.matches &&
        durationMs() > 0 &&
        countFades(previous, next) <= MAX_FADED_ROWS_PER_UPDATE
      if (!shouldAnimate) clearFades()
      // A leaving row fades from where it is drawn, which includes its own
      // slide in flight, so it is read before stale slides are cancelled.
      else for (const [node, position] of previous) if (!next.has(node)) fadeOut(node, position)
      settleStale(next, shouldAnimate)
      if (shouldAnimate) animateRemaining(previous, next)
      positions = next
    },
    dispose() {
      for (const node of running.keys()) cancel(node)
      clearFades()
      positions = null
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
export function sidebarListMotion(orderKey: () => string, durationMs: () => number) {
  return (list: HTMLElement) => {
    const motion = createSidebarListMotion(list, durationMs)
    // Derived, so a re-render that leaves the order as it was compares equal
    // and never reaches the effect below.
    const key = $derived(orderKey())
    let isFirstPass = true
    $effect(() => {
      void key
      // Effects run after the DOM update, so the rows are in their new places.
      motion.update(!isFirstPass)
      isFirstPass = false
    })
    return () => motion.dispose()
  }
}
