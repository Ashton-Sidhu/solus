/** The drawer floats a small gap above `edgeTop`, inside the visible viewport. */
export function stashDrawerVerticalPosition(
  edgeTop: number,
  viewportTop: number,
  viewportHeight: number,
) {
  const margin = Math.min(12, viewportHeight / 4)
  const top = viewportTop + margin
  const availableHeight = viewportHeight - margin * 2
  // Keep room for at least the header and an entry when the composer is tall.
  const bottom = Math.min(top + availableHeight, Math.max(edgeTop - 8, top + 96))
  return { bottom, maxHeight: bottom - top }
}

/** Center the drawer over the composer card. In a session it floats above the
 *  action row, so the bookmark that opened it stays in view; in a draft, which
 *  has no action row, it floats above the card. */
export function positionStashDrawer(drawer: HTMLElement, anchor: HTMLElement) {
  const card = anchor.closest<HTMLElement>('[data-slot="composer"]') ?? anchor
  const column = card.closest<HTMLElement>('[data-composer-column]')
  const viewport = window.visualViewport
  let frame = 0

  function position() {
    frame = 0
    const bounds = card.getBoundingClientRect()
    const trigger = column?.querySelector<HTMLElement>('[data-session-action="prompt-stash"]')
    const triggerTop = trigger?.getBoundingClientRect().top
    const { bottom, maxHeight } = stashDrawerVerticalPosition(
      triggerTop && triggerTop < bounds.top ? triggerTop : bounds.top,
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
