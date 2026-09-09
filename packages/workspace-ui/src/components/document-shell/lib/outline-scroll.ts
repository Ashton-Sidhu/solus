/** Scroll only the outline, so following a section cannot move the document. */
export function revealActiveOutlineRow(container: HTMLElement | undefined): void {
  if (!container || container.clientHeight === 0) return
  const row = container.querySelector<HTMLElement>('[data-active="true"]')
  if (!row) return
  const viewport = container.getBoundingClientRect()
  const bounds = row.getBoundingClientRect()
  if (bounds.top < viewport.top) container.scrollTop += bounds.top - viewport.top
  else if (bounds.bottom > viewport.bottom) container.scrollTop += bounds.bottom - viewport.bottom
}
