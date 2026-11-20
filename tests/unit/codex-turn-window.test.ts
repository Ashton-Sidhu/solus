import { expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'

// The Codex helpers reach the database module, which loads `node:sqlite`.
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { loadCodexTurns, loadCodexTurnWindow } = await import('@solus/server/execution/agents/codex/codex-turns')
const { historyPageTurnId, loadCodexHistoryPage } = await import('@solus/server/execution/agents/codex/codex-history-page')

interface TurnsListParams { cursor?: string; limit: number; sortDirection: 'asc' | 'desc' }

/** An app-server thread of `count` turns that pages its turn list the way
 *  Codex does: in the asked direction, `limit` at a time, with a cursor. */
function thread(count: number) {
  const turns = Array.from({ length: count }, (_, index) => ({ id: `turn-${index + 1}`, status: 'completed', itemsView: 'summary', items: [] }))
  const requests: TurnsListParams[] = []
  const client = {
    request: async <T>(method: string, params: unknown): Promise<T> => {
      if (method === 'thread/items/list') {
        const { turnId } = params as { turnId: string }
        return { data: [{ turnId, item: { id: `${turnId}-message`, type: 'agentMessage', text: turnId } }], nextCursor: null } as T
      }
      const list = params as TurnsListParams
      requests.push(list)
      const ordered = list.sortDirection === 'desc' ? [...turns].reverse() : turns
      const start = list.cursor ? Number(list.cursor) : 0
      const data = ordered.slice(start, start + list.limit)
      const next = start + data.length
      return { data, nextCursor: next < ordered.length ? String(next) : null } as T
    },
  }
  return { client, requests }
}

test('a first page lists only the newest turns it can hold, newest first, in one request', async () => {
  // WHY: an open listed every turn of a thread, 200 at a time and one request
  // after another, before it read the newest turn's items.
  const { client, requests } = thread(1_500)

  const turns = await loadCodexTurnWindow(client, 'thread', undefined, 20)

  expect(requests).toEqual([{ threadId: 'thread', cursor: undefined, limit: 21, sortDirection: 'desc', itemsView: 'summary' } as unknown as TurnsListParams])
  // Oldest first, as the page expects; the one extra turn says older ones remain.
  expect(turns.map((turn) => turn.id)).toEqual(Array.from({ length: 21 }, (_, index) => `turn-${1_480 + index}`))
})

test('the pages of a long thread read the same turns as the whole list did', async () => {
  // The page token names a turn, so a client that holds one from before still pages.
  const { client } = thread(450)
  const whole = thread(450)
  const read = (params: unknown) => client.request<never>('thread/items/list', params)
  const allTurns = await loadCodexTurns(whole.client, 'thread')

  const windowed: string[][] = []
  const listed: string[][] = []
  let before: string | null | undefined
  let windowBefore: string | null | undefined
  do {
    const turns = await loadCodexTurnWindow(client, 'thread', historyPageTurnId(windowBefore ?? undefined), 40)
    const page = await loadCodexHistoryPage('thread', turns, read, 40, windowBefore ?? undefined)
    const reference = await loadCodexHistoryPage('thread', allTurns, read, 40, before ?? undefined)
    windowed.push(page.messages.map((message) => message.content))
    listed.push(reference.messages.map((message) => message.content))
    windowBefore = page.before
    before = reference.before
  } while (before)

  expect(windowBefore).toBeNull()
  expect(windowed).toEqual(listed)
  expect(windowed.flat()).toHaveLength(450)
})

test('a turn the thread no longer has gives every turn, so the page says history changed', async () => {
  const { client } = thread(30)
  const turns = await loadCodexTurnWindow(client, 'thread', 'turn-gone', 10)
  expect(turns).toHaveLength(30)
  await expect(loadCodexHistoryPage('thread', turns, async () => ({ data: [], nextCursor: null }), 10, JSON.stringify({ turn: 'turn-gone' })))
    .rejects.toThrow('Session history changed')
})
