/** Keep automatic smooth scrolling separate from a reader scrolling away.
 * Browser scrolling stops on direct input; no continuous animation loop is used. */
export function createResponseScroll(element: HTMLElement) {
  let moving = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  const settle = () => {
    moving = false
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = undefined
  }
  const cancel = () => {
    if (moving) element.scrollTo({ top: element.scrollTop, behavior: 'instant' })
    settle()
  }
  const inputEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
  for (const event of inputEvents) element.addEventListener(event, cancel, { passive: true })
  element.addEventListener('scrollend', settle)
  return {
    get moving() { return moving },
    follow(smooth: boolean) {
      const animate = smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (settleTimer) clearTimeout(settleTimer)
      moving = animate
      element.scrollTo({ top: element.scrollHeight, behavior: animate ? 'smooth' : 'instant' })
      // Fallback for clients without scrollend, including interrupted layout.
      if (animate) settleTimer = setTimeout(settle, 600)
    },
    destroy() {
      cancel()
      for (const event of inputEvents) element.removeEventListener(event, cancel)
      element.removeEventListener('scrollend', settle)
    },
  }
}
