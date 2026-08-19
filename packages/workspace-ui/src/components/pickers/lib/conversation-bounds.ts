/**
 * The picker belongs to the conversation it was opened from, so it centres over
 * the conversation column rather than the window — an open sidebar or side panel
 * would otherwise push it visibly off-axis.
 */

/** Horizontal extent of the conversation column, in viewport pixels. */
export interface ConversationBounds {
  left: number
  width: number
}

/** Below this the column is either hidden behind a full-page view or too narrow
 * to centre in, and viewport centring reads better. */
const MIN_USABLE_WIDTH = 384

function measure(el: HTMLElement): ConversationBounds | null {
  const rect = el.getBoundingClientRect()
  if (rect.width < MIN_USABLE_WIDTH) return null
  return { left: rect.left, width: rect.width }
}

/**
 * Padding that shrinks a full-bleed fixed overlay's centring box down to the
 * column, so the overlay still dims the whole window while its centred child
 * lands on the conversation's axis. Empty when there is nothing to centre on.
 */
export function centringPadding(
  bounds: ConversationBounds | null,
  viewportWidth: number,
): string {
  // Width 0 is the frame before the window binding reports: centre on the window
  // for that frame rather than padding one side only.
  if (!bounds || viewportWidth <= 0) return ''
  const right = Math.max(0, viewportWidth - (bounds.left + bounds.width))
  return `padding-left:${bounds.left}px;padding-right:${right}px`
}

/**
 * Reports the conversation column's bounds, then again on every resize.
 * Reports `null` when there is no column to centre on — pill mode and the
 * standalone client never render one. Returns a teardown.
 */
export function observeConversationBounds(
  onChange: (bounds: ConversationBounds | null) => void,
): () => void {
  const el = document.querySelector<HTMLElement>('[data-conversation-space]')
  if (!el) {
    onChange(null)
    return () => {}
  }

  const report = () => onChange(measure(el))
  report()

  const observer = new ResizeObserver(report)
  observer.observe(el)
  // The column can keep its width while the window moves it sideways (sidebar
  // collapse animates the pane, window resize moves the frame).
  window.addEventListener('resize', report)

  return () => {
    observer.disconnect()
    window.removeEventListener('resize', report)
  }
}
