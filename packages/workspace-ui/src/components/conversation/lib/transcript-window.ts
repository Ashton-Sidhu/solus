/**
 * How much of a transcript is mounted.
 *
 * A session can hold thousands of messages, and mounting all of them costs a
 * render of every tool card, diff well and markdown block in the history. The
 * view mounts a window at the tail instead and widens it a page at a time —
 * on scroll, on Find, or on the button a touch client shows at the top of the
 * thread.
 *
 * Separate from `historyTruncated`, which is the *other* half of the same
 * question: this decides how much of what the client already holds is rendered,
 * while `historyTruncated` says more is still on disk. Older turns exist if
 * either is true, which is why `hasOlderTurns` takes both.
 */

/** Messages mounted before any page has been requested. */
export const INITIAL_RENDER_CAP = 100

/** How much further back each page reaches. */
export const PAGE_SIZE = 100

/**
 * First index of the mounted window. Clamped at zero so a short transcript
 * mounts whole rather than slicing from a negative offset.
 */
export function transcriptWindowStart(total: number, renderOffset: number): number {
  return Math.max(0, total - INITIAL_RENDER_CAP - renderOffset * PAGE_SIZE)
}

/**
 * Whether anything precedes the mounted window — held in this client's own
 * message list, or still on the host's disk. The affordances that widen the
 * window all gate on this, so they appear and disappear together.
 */
export function hasOlderTurns(
  total: number,
  renderOffset: number,
  historyTruncated: boolean,
): boolean {
  return transcriptWindowStart(total, renderOffset) > 0 || historyTruncated
}

/**
 * The page that has to be reached to put `messageIndex` on screen. Find and the
 * minimap jump to a message that may sit above the window, so they widen it to
 * the message first and scroll afterwards.
 */
export function pageOffsetForMessage(total: number, messageIndex: number): number {
  return Math.ceil(Math.max(0, total - INITIAL_RENDER_CAP - messageIndex) / PAGE_SIZE)
}
