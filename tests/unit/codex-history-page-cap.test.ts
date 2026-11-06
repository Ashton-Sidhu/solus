import { expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { HISTORY_PAGE_BYTES, HISTORY_PAGE_ROWS, historyPageMustCut } from '@solus/contracts/session-history'
import type { CodexItemsListParams, CodexItemsListResponse } from '@solus/server/execution/agents/codex/codex-history'
import type { CodexHistoryItem, CodexTurnHistory } from '@solus/server/execution/agents/codex/codex-utils'
import { INITIAL_HISTORY_TURNS, OLDER_HISTORY_TURNS } from '@solus/client-core/session-history-page'

// The Codex helpers reach the database module, which loads `node:sqlite`.
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { loadCodexHistory } = await import('@solus/server/execution/agents/codex/codex-history')
const { loadCodexHistoryPage } = await import('@solus/server/execution/agents/codex/codex-history-page')

// WHY: a page cut inside a turn changes that turn on the client when the older
// page arrives, and the reader's view jumps. So Codex pages, like Claude pages,
// end only between turns. A turn of thousands of commands would still freeze
// the client when the session opens, so a turn past the hard budget is cut
// between items, and the older pages give back the rest of it, item for item.

const prompt = (id: string, text: string): CodexHistoryItem => ({ id, type: 'userMessage', content: [{ type: 'text', text }] })
const command = (step: number, output: string): CodexHistoryItem =>
  ({ id: `cmd-${step}`, type: 'commandExecution', command: `echo ${step}`, status: 'completed', aggregatedOutput: output })

/** An earlier short turn, then one turn of a prompt and `steps` commands. */
function longTurnThread(steps: number, output: string, itemsView: CodexTurnHistory['itemsView']) {
  const items = new Map<string, CodexHistoryItem[]>([
    ['earlier', [prompt('p-0', 'earlier'), { id: 'a-0', type: 'agentMessage', text: 'done' }]],
    ['long', [prompt('p-1', 'long turn'), ...Array.from({ length: steps }, (_, step) => command(step, output))]],
  ])
  const turns: CodexTurnHistory[] = [...items.keys()].map((id) => ({
    id, itemsView, status: 'completed', startedAt: 1_700_000_000, completedAt: 1_700_000_100,
    ...(itemsView === 'full' && { items: items.get(id) }),
  }))
  // Item pages arrive newest first; a cursor is the offset from the newest item.
  const read = async ({ turnId, cursor, limit }: CodexItemsListParams): Promise<CodexItemsListResponse> => {
    const newestFirst = [...items.get(turnId)!].reverse()
    const offset = Number(cursor ?? 0)
    const end = offset + limit
    return {
      data: newestFirst.slice(offset, end).map((item) => ({ turnId, item })),
      nextCursor: end < newestFirst.length ? String(end) : null,
    }
  }
  return { turns, read, items }
}

/** Every page from the newest to the oldest, as a client reads them. */
async function allPages(thread: ReturnType<typeof longTurnThread>) {
  const pages = [await loadCodexHistoryPage('thread', thread.turns, thread.read, INITIAL_HISTORY_TURNS)]
  while (pages.at(-1)!.before) pages.push(await loadCodexHistoryPage('thread', thread.turns, thread.read, OLDER_HISTORY_TURNS, pages.at(-1)!.before!))
  return pages
}

for (const itemsView of ['summary', 'full'] as const) {
  test(`a ${itemsView} Codex turn longer than the page budget arrives whole, from its prompt`, async () => {
    const thread = longTurnThread(900, 'ok', itemsView)
    const pages = await allPages(thread)
    expect(pages[0].messages.length).toBeGreaterThan(HISTORY_PAGE_ROWS)
    expect(pages[0].messages[0]).toMatchObject({ role: 'user', content: 'long turn' })
    expect(pages.flatMap((page) => page.messages.slice().reverse()).reverse()).toEqual(await loadCodexHistory('thread', thread.turns, thread.read))
  })

  test(`a ${itemsView} Codex turn past the hard row budget opens at its newest rows, and older pages give back the rest exactly`, async () => {
    const thread = longTurnThread(2100, 'ok', itemsView)
    const pages = await allPages(thread)
    expect(historyPageMustCut(pages[0].messages.length, 0)).toBe(true)
    expect(pages[0].messages[0].role).not.toBe('user')
    // The newest page holds the turn's end, so it keeps the turn's completion time.
    expect(pages[0].messages.at(-1)!.timestamp).toBe(1_700_000_100_000)
    expect(pages.flatMap((page) => page.messages.slice().reverse()).reverse()).toEqual(await loadCodexHistory('thread', thread.turns, thread.read))
  })
}

test('a Codex turn past the hard byte budget opens within it, and older pages give back the rest exactly', async () => {
  const output = 'x'.repeat(16 * 1024)
  const thread = longTurnThread(450, output, 'summary')
  const pages = await allPages(thread)
  const first = pages[0]
  expect(first.messages[0].role).not.toBe('user')
  expect(historyPageMustCut(first.messages.length, 0)).toBe(false)
  const itemBytes = Buffer.byteLength(JSON.stringify(command(449, output)))
  expect(first.messages.length * itemBytes).toBeLessThanOrEqual(4 * HISTORY_PAGE_BYTES + itemBytes)
  expect(pages.flatMap((page) => page.messages.slice().reverse()).reverse()).toEqual(await loadCodexHistory('thread', thread.turns, thread.read))
})

test('a cursor inside a turn whose items changed fails instead of skipping or repeating rows', async () => {
  const thread = longTurnThread(2100, 'ok', 'summary')
  const recent = await loadCodexHistoryPage('thread', thread.turns, thread.read, INITIAL_HISTORY_TURNS)
  // Two new items at the newest end shift every older item by two.
  thread.items.get('long')!.push(command(2100, 'ok'), command(2101, 'ok'))
  await expect(loadCodexHistoryPage('thread', thread.turns, thread.read, OLDER_HISTORY_TURNS, recent.before!)).rejects.toThrow('history changed')
})

function concurrentThread(count: number) {
  const turns: CodexTurnHistory[] = Array.from({ length: count }, (_, index) => ({ id: String(index), itemsView: 'summary' }))
  const calls: CodexItemsListParams[] = []
  const replies = new Map<string, ReturnType<typeof Promise.withResolvers<CodexItemsListResponse>>>()
  const started = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  for (const turn of turns) started.set(turn.id!, Promise.withResolvers<void>())
  let active = 0
  let peak = 0
  const read = async (params: CodexItemsListParams): Promise<CodexItemsListResponse> => {
    calls.push(params)
    active++
    peak = Math.max(peak, active)
    const reply = Promise.withResolvers<CodexItemsListResponse>()
    replies.set(params.turnId, reply)
    started.get(params.turnId)!.resolve()
    try { return await reply.promise } finally { active-- }
  }
  const finish = (turnId: string, text = turnId) => replies.get(turnId)!.resolve({
    data: [{ turnId, item: prompt(`p-${turnId}`, text) }], nextCursor: null,
  })
  return { turns, calls, replies, started, read, finish, peak: () => peak }
}

test('three turn reads overlap, preserve order, and do not exceed the requested turns', async () => {
  const thread = concurrentThread(5)
  const result = loadCodexHistoryPage('thread', thread.turns, thread.read, 4)
  expect(thread.calls.map((call) => call.turnId)).toEqual(['4', '3', '2'])
  // Older replies arrive first. They must not change chronology or advance
  // the shared budget before the newest turn has been consumed.
  thread.finish('2')
  thread.finish('3')
  thread.finish('4')
  await thread.started.get('1')!.promise
  thread.finish('1')
  const page = await result
  expect(thread.peak()).toBe(3)
  expect(page.messages.map((message) => message.content)).toEqual(['1', '2', '3', '4'])
  expect(thread.calls.map((call) => call.turnId)).toEqual(['4', '3', '2', '1'])
  expect(page.before).toBe(JSON.stringify({ turn: '1' }))
})

test('a full page stops scheduling and ignores errors in unused speculative reads', async () => {
  const thread = concurrentThread(5)
  const result = loadCodexHistoryPage('thread', thread.turns, thread.read, 5)
  thread.replies.get('2')!.reject(new Error('unused older turn'))
  thread.replies.get('3')!.reject(new Error('unused older turn'))
  thread.finish('4', 'x'.repeat(HISTORY_PAGE_BYTES))
  const page = await result
  expect(page.messages).toHaveLength(1)
  expect(page.before).toBe(JSON.stringify({ turn: '4' }))
  expect(thread.calls.map((call) => call.turnId)).toEqual(['4', '3', '2'])
})

test('an error in a needed prefetched turn still fails the page', async () => {
  const thread = concurrentThread(3)
  const result = loadCodexHistoryPage('thread', thread.turns, thread.read, 3)
  thread.replies.get('1')!.reject(new Error('needed turn unavailable'))
  thread.finish('0')
  thread.finish('2')
  await expect(result).rejects.toThrow('needed turn unavailable')
})
