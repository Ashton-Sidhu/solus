import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { codexItemToMessage, codexTurnToMessages, completeCodexTurnMessages, toEpochMs, type CodexHistoryItem, type CodexTurnHistory } from './codex-utils'

// Experimental pagination fields from the installed Codex protocol. Keep this
// boundary local until the generated protocol includes these methods.
export interface CodexItemsListParams {
  threadId: string
  turnId: string
  cursor?: string
  limit: number
  sortDirection: 'desc'
}

export interface CodexItemsListResponse {
  data: Array<{ turnId: string; item: CodexHistoryItem }>
  nextCursor?: string | null
}

/** Summaries omit tools. Read the newest item pages needed by the client window,
 * preserving chronological order and the turn's completion timestamp. */
export async function loadCodexHistory(
  threadId: string,
  turns: CodexTurnHistory[],
  readItems: (params: CodexItemsListParams) => Promise<CodexItemsListResponse>,
  limit?: number,
): Promise<SessionLoadMessage[]> {
  const cap = limit && limit > 0 ? limit : Infinity
  const loaded: SessionLoadMessage[][] = []
  let count = 0
  for (let index = turns.length - 1; index >= 0 && count < cap; index--) {
    const turn = turns[index]
    let messages: SessionLoadMessage[]
    if (turn.itemsView === 'summary' || turn.itemsView === 'notLoaded') {
      if (!turn.id) throw new Error('Codex history summary has no turn id')
      const newestMessages: SessionLoadMessage[] = []
      const startedAt = toEpochMs(turn.startedAt)
      let cursor: string | undefined
      const seenCursors = new Set<string>()
      do {
        const page = await readItems({
          threadId, turnId: turn.id, cursor,
          limit: Math.min(200, cap - count - newestMessages.length), sortDirection: 'desc',
        })
        // Each page and the page sequence arrive newest first.
        for (const entry of page.data) {
          const message = codexItemToMessage(entry.item, startedAt)
          if (message) newestMessages.push(message)
        }
        cursor = page.nextCursor ?? undefined
        if (cursor && seenCursors.has(cursor)) throw new Error('Codex history repeated an item cursor')
        if (cursor) seenCursors.add(cursor)
      } while (cursor && newestMessages.length < cap - count)
      messages = completeCodexTurnMessages(turn, newestMessages.reverse())
    } else {
      // Older runtimes omit itemsView and return complete items in thread/read.
      messages = codexTurnToMessages(turn)
    }
    loaded.push(messages)
    count += messages.length
  }
  const messages = loaded.reverse().flat()
  return messages.length > cap ? messages.slice(-cap) : messages
}
