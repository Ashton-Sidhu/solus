/**
 * After pairing, the dialog shrinks into the new host's row in the host list,
 * so the person sees where the host went. Rows opt in with `data-host-row`;
 * with no row on screen, or with reduced motion, nothing moves.
 */
export function landInHostList(dialog: HTMLElement, hostId: string): void {
  const row = document.querySelector<HTMLElement>(`[data-host-row="${CSS.escape(hostId)}"]`)
  if (!row || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const from = dialog.getBoundingClientRect()
  const to = row.getBoundingClientRect()
  if (to.width === 0 || to.bottom < 0 || to.top > innerHeight) return

  // SAFETY: a deep clone of an element is an element of the same kind.
  const card = row.cloneNode(true) as HTMLElement
  card.removeAttribute('data-host-row')
  card.setAttribute('aria-hidden', 'true')
  Object.assign(card.style, {
    position: 'fixed',
    left: `${to.left}px`,
    top: `${to.top}px`,
    width: `${to.width}px`,
    height: `${to.height}px`,
    margin: '0',
    zIndex: '10030',
    pointerEvents: 'none',
    transformOrigin: '0 0',
    borderRadius: '0.75rem',
    background: 'var(--solus-popover-bg)',
    boxShadow: 'var(--solus-popover-shadow)',
  })
  document.body.appendChild(card)

  const scaleX = from.width / to.width
  const scaleY = from.height / to.height
  const shift = `translate(${from.left - to.left}px, ${from.top - to.top}px)`
  const flight = card.animate(
    [
      { transform: `${shift} scale(${scaleX}, ${scaleY})`, opacity: 0.6 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: 600, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  )
  flight.onfinish = flight.oncancel = () => {
    card.remove()
    row.animate(
      [
        { backgroundColor: 'color-mix(in srgb, var(--solus-accent) 9%, transparent)', boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--solus-accent) 22%, transparent)' },
        { backgroundColor: 'transparent', boxShadow: 'inset 0 0 0 1px transparent' },
      ],
      { duration: 1600, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    )
  }
}
