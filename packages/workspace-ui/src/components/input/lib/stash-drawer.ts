/** Position the drawer at the outside edge of the card, including its padding. */
export function positionStashDrawer(drawer: HTMLElement, anchor: HTMLElement) {
  const card = anchor.closest<HTMLElement>('[data-slot="composer"]') ?? anchor
  let frame = 0

  function position() {
    frame = 0
    const bounds = card.getBoundingClientRect()
    drawer.style.setProperty('--stash-card-left', `${bounds.left}px`)
    drawer.style.setProperty('--stash-card-width', `${bounds.width}px`)
    drawer.style.setProperty('--stash-card-top', `${bounds.top}px`)
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

  return {
    destroy() {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', onScroll, true)
    },
  }
}
