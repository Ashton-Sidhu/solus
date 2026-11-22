import { expect, test } from 'bun:test'
import type { SessionHistoryPage, SessionHistoryPageRequest } from '@solus/contracts/session-history'
import { requestSessionHistoryPage } from '@solus/client-core/session-history-page'
import { resumeHistoryPage } from '@solus/server/data/sessions/history-blocks'

const request: SessionHistoryPageRequest = { sessionId: 's', provider: 'codex', turnLimit: 10 }
const turn = (id: string, content: string) => [{ role: 'user', content: id }, { role: 'assistant', content }]

test('after a restart only new or edited turns cross the wire, including when a turn leaves the first page', async () => {
  let current: SessionHistoryPage = { before: 'older', messages: [...turn('a', 'first'), ...turn('b', 'second'), ...turn('c', 'third')] }
  let saved: SessionHistoryPage | null = null
  const sent: number[] = []
  const api = { loadSessionPage: async (input: SessionHistoryPageRequest) => {
    const result = resumeHistoryPage(current, input.knownHistoryBlocks!)
    sent.push(result.messages.length)
    return result
  } }
  const open = () => requestSessionHistoryPage(api, request, 'account', async () => saved)
  saved = await open()
  expect((await open()).messages).toEqual(current.messages)
  current = { before: 'new-cursor', messages: [...turn('b', 'second'), ...turn('c', 'edited'), ...turn('d', 'fourth')] }
  saved = await open()
  expect(saved.messages).toEqual(current.messages)
  expect(saved.before).toBe('new-cursor')
  expect((await open()).messages).toEqual(current.messages)
  expect(sent).toEqual([6, 0, 4, 0])
})

test('older hosts can return a full page and access denial always wins over cached history', async () => {
  const page = { before: null, messages: turn('a', 'first') }
  const cached = resumeHistoryPage(page, [])
  const readCache = async () => cached
  expect(await requestSessionHistoryPage({ loadSessionPage: async () => page }, request, 'account', readCache)).toEqual(page)
  await expect(requestSessionHistoryPage({ loadSessionPage: async () => { throw new Error('Access denied') } }, request, 'account', readCache)).rejects.toThrow('Access denied')
})
