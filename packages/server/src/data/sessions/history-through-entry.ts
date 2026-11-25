import { HISTORY_PAGE_BYTES, HISTORY_PAGE_ROWS, type SessionLoadMessage } from '@solus/contracts/session-history'

const MAX_PAGES_PER_JUMP = 4

type HistoryRows<T> = { messages: T[]; before: string | null }

/** Read contiguous provider pages on the host for a jump. The screen can continue
 * from the returned cursor when the destination is outside this response. */
export async function readHistoryThroughEntry<T extends SessionLoadMessage>(
  read: (before?: string) => Promise<HistoryRows<T>>,
  before: string | undefined,
  throughEntryId: string | undefined,
): Promise<HistoryRows<T>> {
  const first = await read(before)
  if (!throughEntryId) return first
  const pages = [first.messages]
  const seen = new Set([before])
  let current = first
  let rows = first.messages.length
  let bytes = 0
  // Bound provider reads even when a provider returns many sparse or empty pages.
  while (current.before !== null) {
    if (seen.has(current.before)) throw new Error('Session history did not advance.')
    if (current.messages.some(row => row.messageId === throughEntryId) || pages.length >= MAX_PAGES_PER_JUMP || rows >= HISTORY_PAGE_ROWS) break
    if (pages.length === 1) bytes = Buffer.byteLength(JSON.stringify(first.messages))
    if (bytes >= HISTORY_PAGE_BYTES) break
    seen.add(current.before)
    const older = await read(current.before)
    rows += older.messages.length
    bytes += Buffer.byteLength(JSON.stringify(older.messages))
    // Keep the cursor at the start of the last included page. A single large
    // turn keeps its normal provider boundary on the next read.
    if (rows > HISTORY_PAGE_ROWS || bytes > HISTORY_PAGE_BYTES) break
    pages.push(older.messages)
    current = older
  }
  return pages.length === 1 ? first : { messages: pages.reverse().flat(), before: current.before }
}
