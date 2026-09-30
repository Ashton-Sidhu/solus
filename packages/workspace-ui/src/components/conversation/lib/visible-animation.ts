import type { Attachment } from 'svelte/attachments'

/**
 * Pauses looping activity animations (shimmer, spinner, dots) while their row
 * is scrolled out of view. A live turn can hold several such rows, and a long
 * transcript scrolls them away while the run continues; each one would
 * otherwise repaint every frame for nothing.
 *
 * The attachment sets `--visible-animation-state` on its element, and the
 * animations below it read that as their `animation-play-state`. One shared
 * observer serves every row.
 */

let observer: IntersectionObserver | undefined

function sharedObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!(entry.target instanceof HTMLElement)) continue
      entry.target.style.setProperty('--visible-animation-state', entry.isIntersecting ? 'running' : 'paused')
    }
  })
  return observer
}

export const pauseWhenOffscreen: Attachment<HTMLElement> = (element) => {
  const rows = sharedObserver()
  rows.observe(element)
  return () => rows.unobserve(element)
}
