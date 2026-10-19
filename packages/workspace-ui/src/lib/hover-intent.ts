import type { Attachment } from 'svelte/attachments'

/** Long enough that a pointer crossing a transcript on its way somewhere else
 *  reads nothing; short against the time a reader takes to click. */
const HOVER_INTENT_MS = 150

/**
 * Run `onIntent` once a pointer rests on the element, or keyboard focus
 * reaches it. For reads that a click is likely to need next.
 */
export function hoverIntent(onIntent: () => void): Attachment<HTMLElement> {
  return (element) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancel = () => {
      clearTimeout(timer)
      timer = undefined
    }
    const schedule = () => {
      cancel()
      timer = setTimeout(onIntent, HOVER_INTENT_MS)
    }
    element.addEventListener('pointerenter', schedule)
    element.addEventListener('pointerleave', cancel)
    element.addEventListener('focus', onIntent)
    return () => {
      cancel()
      element.removeEventListener('pointerenter', schedule)
      element.removeEventListener('pointerleave', cancel)
      element.removeEventListener('focus', onIntent)
    }
  }
}
