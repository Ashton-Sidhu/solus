import { expect, test } from 'bun:test'
import type { SessionHistoryPage, SessionHistoryPageRequest } from '@solus/contracts/session-history'
import { requestSessionHistoryPage } from '@solus/client-core/session-history-page'
import { HistoryPageManifests, resumeHistoryPage } from '@solus/server/data/sessions/history-blocks'

const request: SessionHistoryPageRequest = { sessionId: 's', provider: 'codex', turnLimit: 10 }
const turn = (id: string, content: string) => [{ role: 'user', content: id, timestamp: 1 }, { role: 'assistant', content, timestamp: 2 }]

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

test('the host reuses a manifest only for the exact source, activity window and immutable rows', () => {
  const manifests = new HistoryPageManifests()
  const page = {before: null, messages: [{role: 'user', content: 'hello', timestamp: 1}]}
  const key = manifests.sourceKey('codex', 'id', false, Infinity, page, [])!
  const full = resumeHistoryPage(page, [])
  manifests.remember(key, full, page.messages)
  const hashes = full.historyBlocks!.map(block => block.hash)
  expect(manifests.resume(key, hashes)?.messages).toEqual([])
  expect(manifests.resume(key, [])).toBeNull()
  expect(manifests.sourceKey('codex', 'id', false, 2, page, [])).not.toBe(key)
  page.messages[0].content = 'changed'
  const changed = manifests.sourceKey('codex', 'id', false, Infinity, page, [])!
  expect(manifests.resume(changed, hashes)).toBeNull()
  manifests.remember(changed, full, [{...page.messages[0], agentConversationResults: [{messageId: 'exchange'}]}])
  expect(manifests.resume(changed, hashes)).toBeNull()
})
