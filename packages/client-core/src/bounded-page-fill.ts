/**
 * Reads more pages while a list narrowed on the client is short.
 *
 * Some filters (review, checks, involvement) are answered only by rows a
 * client holds, so each page the host hands over is thinned out. Without this
 * the first page could show two rows, and the rest appeared only after a
 * scroll that nobody would think to try. The reads are bounded, so a filter
 * that matches nothing does not walk the whole history. Shared by the
 * workspace UI and the mobile app.
 */

/** At most this many extra pages for one list and filter. */
export const PAGE_FILL_MAX_READS = 5
/** A page with fewer rows than this is short. */
export const PAGE_FILL_MIN_ROWS = 25

export interface PageFillState {
  /** Rows the list shows after every filter. */
  rows: number
  hasMore: boolean
  /** A read of this list is on its way. */
  reading: boolean
}

export class BoundedPageFill {
  private key: string | null = null
  private reads = 0

  /**
   * Whether to read the next page now, and if so, counts that read. `key`
   * names the list and its filters; a new key starts the count again.
   */
  next(key: string, state: PageFillState): boolean {
    if (key !== this.key) {
      this.key = key
      this.reads = 0
    }
    if (state.reading || !state.hasMore || state.rows >= PAGE_FILL_MIN_ROWS) return false
    if (this.reads >= PAGE_FILL_MAX_READS) return false
    this.reads += 1
    return true
  }
}
