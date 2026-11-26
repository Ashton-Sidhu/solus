import { createHash } from 'node:crypto'
import type { Activity } from '@solus/contracts/activity'
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
  const historyRevision = createHash('sha256').update(JSON.stringify([
    page.before, page.turnDiffs, historyBlocks.map(({ hash, count }) => [hash, count]),
  ])).digest('hex')
  return { ...page, messages, historyBlocks, historyRevision }
}

/** Remember only the last verified manifest for a page. Every request still
 * reads the authorized source rows and activity. No cached row can cross readers. */
export class HistoryPageManifests {
  private readonly pages = new Map<string, Pick<SessionHistoryPage, 'before' | 'historyRevision' | 'turnDiffs'> & { blocks: HistoryBlock[] }>()

  sourceKey(provider: string, sessionId: string, defersHtml: boolean, until: number, page: SessionHistoryPage, activity: readonly Activity[]): string | null {
    // Storing inline images can have a different outcome on a later request.
    if (page.messages.some(row => row.imageAttachments?.length)) return null
    const hash = createHash('sha256').update(JSON.stringify([provider, sessionId, defersHtml, until, page.before, page.turnDiffs, activity]))
    for (const row of page.messages) hash.update('\n').update(JSON.stringify(row))
    return hash.digest('hex')
  }

  resume(key: string, known: readonly string[]): SessionHistoryPage | null {
    const page = this.pages.get(key)
    if (!page) return null
    const hashes = new Set(known)
    if (!page.blocks.every(block => hashes.has(block.hash))) return null
    return { before: page.before, historyRevision: page.historyRevision, turnDiffs: page.turnDiffs, messages: [], historyBlocks: page.blocks.map(block => ({ ...block, reused: true })) }
  }

  remember(key: string, page: SessionHistoryPage, rows: SessionHistoryPage['messages']): void {
    // An exchange can finish without changing its provider transcript.
    if (!page.historyBlocks || page.historyBlocks.length > 128 || rows.some(row => row.artifactWorkRef?.contentVersion || row.agentConversationResults?.some(result => result.messageId))) return
    this.pages.delete(key)
    this.pages.set(key, { before: page.before, historyRevision: page.historyRevision, turnDiffs: page.turnDiffs, blocks: page.historyBlocks.map(({hash, count}) => ({hash, count})) })
    if (this.pages.size > 128) this.pages.delete(this.pages.keys().next().value!)
  }
}
