import { HISTORY_PREFETCH_SCREENS } from '@solus/client-core/session-history-page'

/** Where the conversation's scroller is, for the older-history prefetch. */
export interface HistoryScroll {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  /** The reader follows the end of the conversation. */
  atEnd: boolean
}

/**
 * Whether to read the next older history page now. The prefetch keeps
 * `HISTORY_PREFETCH_SCREENS` of history above a reader who scrolls back, so
 * their scroll does not stop at the top to wait. A reader at the end whose
 * view is full is not reading back: a conversation opened there read page
 * after page of short turns until three screens sat above it, history the
 * reader may never open. A view the history does not fill still reads, and a
 * tap on the button at the top (`force`) always does.
 */
export function shouldReadOlderHistory(scroll: HistoryScroll, force = false): boolean {
  if (force) return true
  if (scroll.scrollHeight <= scroll.clientHeight) return true
  if (scroll.atEnd) return false
  return scroll.scrollTop <= scroll.clientHeight * HISTORY_PREFETCH_SCREENS
}
