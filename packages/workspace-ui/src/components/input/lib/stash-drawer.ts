/** The drawer's bottom edge sits at `edgeTop`, inside the visible viewport. */
export function stashDrawerVerticalPosition(
  edgeTop: number,
  viewportTop: number,
  viewportHeight: number,
) {
  const margin = Math.min(12, viewportHeight / 4)
  const top = viewportTop + margin
  const availableHeight = viewportHeight - margin * 2
  // Keep room for at least the header and an entry when the composer is tall.
  const bottom = Math.min(top + availableHeight, Math.max(edgeTop, top + 96))
  return { bottom, maxHeight: bottom - top }
}

/** Put the drawer just before the composer card, so the card paints over its
 *  bottom edge: the drawer reads as a tray that comes out from behind the card.
 *  It is inset from the card's shoulders and reaches down past the card's
 *  rounded top corners, which hide its lower end. */
export function tuckStashDrawer(drawer: HTMLElement, anchor: HTMLElement) {
  const card = anchor.closest<HTMLElement>('[data-slot="composer"]') ?? anchor
  card.parentElement?.insertBefore(drawer, card)
  const viewport = window.visualViewport
  let frame = 0

  function position() {
    frame = 0
    const container = drawer.offsetParent
    if (!(container instanceof HTMLElement)) return
    const box = container.getBoundingClientRect()
    const bounds = card.getBoundingClientRect()
    const radius = parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0
    const inset = Math.min(radius + 6, bounds.width / 10)
    const { bottom, maxHeight } = stashDrawerVerticalPosition(
      bounds.top + radius,
      viewport?.offsetTop ?? 0,
      viewport?.height ?? window.innerHeight,
    )
    drawer.style.left = `${bounds.left - box.left - container.clientLeft + inset}px`
    drawer.style.width = `${bounds.width - inset * 2}px`
    drawer.style.bottom = `${box.bottom - bottom}px`
    drawer.style.maxHeight = `${maxHeight}px`
    drawer.style.paddingBottom = `${radius + 4}px`
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(position)
  }

  position()
  const observer = new ResizeObserver(schedule)
  observer.observe(card)
  if (drawer.offsetParent) observer.observe(drawer.offsetParent)
  window.addEventListener('resize', schedule)
  viewport?.addEventListener('resize', schedule)

  return {
    destroy() {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      viewport?.removeEventListener('resize', schedule)
      drawer.remove()
    },
  }
}
