import type { CodexAppServerClient } from './codex-agent'
import type { Turn } from './generated/v2/Turn'

// Experimental pagination is not yet included in the checked-in protocol.
interface CodexTurnsListParams {
  threadId: string
  cursor?: string
  limit: number
  sortDirection: 'asc'
  itemsView: 'summary'
}

interface CodexTurnsListResponse {
  data: Turn[]
  nextCursor?: string | null
}

/** Read ordered summaries without requesting deprecated full-history hydration. */
export async function loadCodexTurns(client: Pick<CodexAppServerClient, 'request'>, threadId: string, timeoutMs?: number): Promise<Turn[]> {
  const turns: Turn[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await client.request<CodexTurnsListResponse, CodexTurnsListParams>('thread/turns/list', {
      threadId, cursor, limit: 200, sortDirection: 'asc', itemsView: 'summary',
    }, timeoutMs)
    turns.push(...page.data)
    cursor = page.nextCursor ?? undefined
    if (cursor && seenCursors.has(cursor)) throw new Error('Codex history repeated a turn cursor')
    if (cursor) seenCursors.add(cursor)
  } while (cursor)
  return turns
}
