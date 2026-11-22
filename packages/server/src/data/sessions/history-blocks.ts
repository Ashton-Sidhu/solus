import { createHash } from 'node:crypto'
import { startsHistoryTurn, type HistoryBlock, type SessionHistoryPage } from '@solus/contracts/session-history'

/** Turn boundaries keep older blocks reusable when the first page slides
 * forward. Split large turns so one streamed edit replaces at most 48 rows. */
export function resumeHistoryPage(page: SessionHistoryPage, known: readonly string[]): SessionHistoryPage {
  const held = new Set(known)
  const messages: SessionHistoryPage['messages'] = []
  const historyBlocks: HistoryBlock[] = []
  for (let start = 0; start < page.messages.length;) {
    let end = start + 1
    while (end < page.messages.length && end - start < 48 && !startsHistoryTurn(page.messages[end]!)) end++
    const block = page.messages.slice(start, end)
    const hash = createHash('sha256').update(JSON.stringify(block)).digest('hex')
    if (held.has(hash)) historyBlocks.push({ hash, count: block.length, reused: true })
    else {
      messages.push(...block)
      historyBlocks.push({ hash, count: block.length })
    }
    start = end
  }
  return { ...page, messages, historyBlocks }
}
