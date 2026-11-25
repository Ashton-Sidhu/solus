export function stashDrawerVerticalPosition(
  composerTop: number,
  viewportTop: number,
  viewportHeight: number,
) {
  const margin = Math.min(12, viewportHeight / 4)
  const top = viewportTop + margin
  const availableHeight = viewportHeight - margin * 2
  // Keep room for at least the header and an entry when the composer is tall.
  const bottom = Math.min(top + availableHeight, Math.max(composerTop, top + 96))
  return { bottom, maxHeight: bottom - top }
}

/** Position the drawer at the outside edge of the card, including its padding. */
export function positionStashDrawer(drawer: HTMLElement, anchor: HTMLElement) {
  const card = anchor.closest<HTMLElement>('[data-slot="composer"]') ?? anchor
  const viewport = window.visualViewport
  let frame = 0

  function position() {
    frame = 0
    const bounds = card.getBoundingClientRect()
    const { bottom, maxHeight } = stashDrawerVerticalPosition(
      bounds.top,
      viewport?.offsetTop ?? 0,
      viewport?.height ?? window.innerHeight,
    )
    drawer.style.setProperty('--stash-card-left', `${bounds.left}px`)
    drawer.style.setProperty('--stash-card-width', `${bounds.width}px`)
    drawer.style.setProperty('--stash-bottom', `${window.innerHeight - bottom}px`)
    drawer.style.setProperty('--stash-max-height', `${maxHeight}px`)
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(position)
  }

  function onScroll(event: Event) {
    if (!(event.target instanceof Node && drawer.contains(event.target))) schedule()
  }

  position()
  const observer = new ResizeObserver(schedule)
  for (let element: HTMLElement | null = card; element; element = element.parentElement) {
    observer.observe(element)
  }
  window.addEventListener('resize', schedule)
  window.addEventListener('scroll', onScroll, true)
  viewport?.addEventListener('resize', schedule)
  viewport?.addEventListener('scroll', schedule)

  return {
    destroy() {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', onScroll, true)
      viewport?.removeEventListener('resize', schedule)
      viewport?.removeEventListener('scroll', schedule)
    },
  }
}
