import type { CodexAppServerClient } from './codex-agent'
import type { Turn } from './generated/v2/Turn'

// Experimental pagination is not yet included in the checked-in protocol.
interface CodexTurnsListParams {
  threadId: string
  cursor?: string
  limit: number
  sortDirection: 'asc' | 'desc'
  itemsView: 'summary'
}

interface CodexTurnsListResponse {
  data: Turn[]
  nextCursor?: string | null
}

const TURN_PAGE = 200

/** Read ordered summaries without requesting deprecated full-history hydration. */
export async function loadCodexTurns(client: Pick<CodexAppServerClient, 'request'>, threadId: string, timeoutMs?: number): Promise<Turn[]> {
  const turns: Turn[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await client.request<CodexTurnsListResponse, CodexTurnsListParams>('thread/turns/list', {
      threadId, cursor, limit: TURN_PAGE, sortDirection: 'asc', itemsView: 'summary',
    }, timeoutMs)
    turns.push(...page.data)
    cursor = page.nextCursor ?? undefined
    if (cursor && seenCursors.has(cursor)) throw new Error('Codex history repeated a turn cursor')
    if (cursor) seenCursors.add(cursor)
  } while (cursor)
  return turns
}

/** The newest turns of a thread: the `count` turns before `beforeTurnId` (or
 *  the newest `count`), with that turn itself and one older turn when the
 *  thread has one, so a page knows whether older turns remain. Read newest
 *  first, so an open does not list every turn of a long thread. Returned
 *  oldest first, like `loadCodexTurns`. A turn id the thread no longer has
 *  gives every turn, and the page reports that history changed. */
export async function loadCodexTurnWindow(client: Pick<CodexAppServerClient, 'request'>, threadId: string, beforeTurnId: string | undefined, count: number): Promise<Turn[]> {
  const newestFirst: Turn[] = []
  let boundary = beforeTurnId === undefined ? -1 : undefined
  const wanted = () => boundary === undefined ? undefined : boundary + 1 + count + 1
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  do {
    const target = wanted()
    const page = await client.request<CodexTurnsListResponse, CodexTurnsListParams>('thread/turns/list', {
      threadId, cursor, limit: target === undefined ? TURN_PAGE : target - newestFirst.length, sortDirection: 'desc', itemsView: 'summary',
    })
    newestFirst.push(...page.data)
    if (boundary === undefined) {
      const index = newestFirst.findIndex((turn) => turn.id === beforeTurnId)
      if (index >= 0) boundary = index
    }
    cursor = page.nextCursor ?? undefined
    if (cursor && seenCursors.has(cursor)) throw new Error('Codex history repeated a turn cursor')
    if (cursor) seenCursors.add(cursor)
  } while (cursor && newestFirst.length < (wanted() ?? Number.POSITIVE_INFINITY))
  return newestFirst.slice(0, wanted()).reverse()
}
