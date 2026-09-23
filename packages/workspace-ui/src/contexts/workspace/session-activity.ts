import type { Session } from '@solus/contracts/types'

/**
 * When a session did things, read for the sidebar.
 *
 * The sidebar derives its whole column from these, so what they *read* matters
 * as much as what they return. A transcript is a deeply reactive array: reading
 * its `length` — which `find`, `for…of`, and `at(-1)` all do — subscribes the
 * reader to every message the session streams, and one streaming session then
 * rebuilds every row. `firstActivityAt` walks indices instead, so it depends on
 * the leading messages alone and settles once the first dated one exists.
 * `lastActivityAt` changes with every message by definition; only a lazy
 * consumer (a picker, a selection) may call it — never the column's projection.
 */

/** A running turn began at its prompt, so the tail-most user message dates it.
 *  Bounded because it only ever has to look at the turn in flight. The scan is
 *  the fallback for a session whose turn start was never recorded. */
const TURN_START_SCAN_DEPTH = 200

export function turnStartedAt(session: Session): number {
  if (session.currentTurnStartedAt) return session.currentTurnStartedAt
  const messages = session.messages
  const floor = Math.max(0, messages.length - TURN_START_SCAN_DEPTH)
  for (let i = messages.length - 1; i >= floor; i--) {
    const message = messages[i]
    if (message.role === 'user' && message.timestamp) return message.timestamp
  }
  return 0
}

export function lastActivityAt(session: Session): number {
  return session.messages.at(-1)?.timestamp ?? 0
}

/** A session with no dated message yet is the newest thing there is. */
export function firstActivityAt(session: Session): number {
  const messages = session.messages
  for (let i = 0; ; i++) {
    const message = messages[i]
    if (!message) return Number.MAX_SAFE_INTEGER
    if (message.timestamp) return message.timestamp
  }
}

/**
 * Give `row` a `lastActivityAt` that reads `read` when asked, not when the row
 * is built. The row is built inside the column's derived pass; the answer is
 * wanted only by pickers, so the dependency on every streamed message lands in
 * the picker that asks. Enumerable, so a later spread still copies a value.
 */
export function withLazyActivity<Row extends object>(
  row: Row,
  read: () => number,
): Row & { readonly lastActivityAt: number } {
  // SAFETY: the property was defined on `row` on the line that returns it.
  return Object.defineProperty(row, 'lastActivityAt', { get: read, enumerable: true, configurable: true }) as Row & {
    readonly lastActivityAt: number
  }
}
