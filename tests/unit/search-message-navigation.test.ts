import { expect, test } from 'bun:test'
import { openSearchMessage } from '@solus/workspace-ui/components/conversation/lib/search-message-navigation'
import { sessionSearchNavigation } from '@solus/client-core/session-search-navigation'
import type { Message } from '@solus/contracts/types'

test('a message result reads older pages only until the requested message, then opens its actual word', async () => {
  const rows: Message[] = [{ id: 'new', role: 'assistant', content: 'latest reply', timestamp: 300 }]
  let pages = 0
  const revealed: Array<[string, string]> = []
  const request = { target: { sourceSessionId: 's', messageId: 'old', role: 'assistant', timestamp: 100, text: 'the serverConnections store' }, query: 'connections store' }
  expect(await openSearchMessage(request, {
    messages: () => rows, hasOlder: () => true, stillWanted: () => true,
    loadOlder: async () => { pages++; rows.unshift({ id: 'old', role: 'assistant', content: 'the serverConnections store', timestamp: 100 }) },
    reveal: async (messageId, word) => { revealed.push([messageId, word]) },
  })).toBe(true)
  expect(pages).toBe(1)
  expect(revealed).toEqual([['old', 'Connections']])
})

test('a cancelled navigation never reads history or moves another conversation', async () => {
  let reads = 0
  const found = await openSearchMessage({ target: { sourceSessionId: 's', messageId: null, role: 'user', timestamp: 1, text: 'old' }, query: 'old' }, {
    messages: () => [], hasOlder: () => true, stillWanted: () => false,
    loadOlder: async () => { reads++ }, reveal: async () => { throw new Error('must not scroll') },
  })
  expect(found).toBe(false)
  expect(reads).toBe(0)
})

test('a stalled history cursor stops without a loop', async () => {
  let reads = 0
  expect(await openSearchMessage({ target: { sourceSessionId: 's', messageId: null, role: 'user', timestamp: 1, text: 'old' }, query: 'old' }, {
    messages: () => [], hasOlder: () => true, stillWanted: () => true,
    loadOlder: async () => { reads++ }, reveal: async () => {},
  })).toBe(false)
  expect(reads).toBe(1)
})

test('pending navigation belongs to one host and is consumed once', () => {
  const request = { target: { sourceSessionId: 's', messageId: 'm', role: 'user', timestamp: 1, text: 'message' }, query: 'message' }
  sessionSearchNavigation.request('a', 's', request)
  expect(sessionSearchNavigation.take('b', 's')).toBeUndefined()
  expect(sessionSearchNavigation.take('a', 's')).toEqual(request)
  expect(sessionSearchNavigation.take('a', 's')).toBeUndefined()
})
