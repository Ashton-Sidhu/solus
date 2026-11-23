// A guide can sit inside a second scroller (the conversation). Only move the guide.
export function guideVisibleTop(viewport: HTMLElement): number {
  if (viewport.closest('.artifact-frame.expanded')) return 0
  const transcript = viewport.closest('[data-conversation-tab-id]')
  if (!transcript) return 0
  return Math.max(0, transcript.getBoundingClientRect().top - viewport.getBoundingClientRect().top)
}

export function guideScrollTop(viewport: HTMLElement, target: HTMLElement, inset: number): number {
  return viewport.scrollTop + target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - guideVisibleTop(viewport) - inset
}

export function scrollGuideTo(viewport: HTMLElement, target: HTMLElement, inset: number): void {
  viewport.scrollTo({
    top: guideScrollTop(viewport, target, inset),
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
  })
}
