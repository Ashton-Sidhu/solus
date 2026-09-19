import { expect, mock, test } from 'bun:test'
import { requestSessionHistoryPage } from '@solus/client-core/session-history-page'
import type { HostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'

const request = { sessionId: 'session', provider: 'codex' as const, limit: 200 }
const ctx = { session: { sessionId: 'session' } } as IpcContext

test('an older remote host can open history through its existing RPC', async () => {
  const loadSession = mock(async () => [{ role: 'user', content: 'cached history', timestamp: 1 }])
  const api = {
    loadSessionPage: async () => { throw new Error('Unknown method "loadSessionPage"') }, loadSession,
  } as unknown as HostApi
  const result = await requestSessionHistoryPage(api, request, ctx)
  expect(Array.isArray(result)).toBe(true)
  expect(loadSession).toHaveBeenCalledTimes(1)
})

test('failed reads and cursors never fall back to a different transcript read', async () => {
  const loadSession = mock(async () => [])
  const api = {
    loadSessionPage: async () => { throw new Error('Not authorized') }, loadSession,
  } as unknown as HostApi
  await expect(requestSessionHistoryPage(api, request, ctx)).rejects.toThrow('Not authorized')
  api.loadSessionPage = async () => { throw new Error('Unknown method "loadSessionPage"') }
  await expect(requestSessionHistoryPage(api, { ...request, before: 'cursor' }, ctx)).rejects.toThrow('Unknown method')
  expect(loadSession).not.toHaveBeenCalled()
})

test('startup reads history before mount and restore consumes it only once', async () => {
  const { prefetchSessionHistoryPage } = await import('@solus/client-core/session-history-page')
  let finish!: (page: { messages: []; before: null }) => void
  const pending = new Promise<{ messages: []; before: null }>((resolve) => { finish = resolve })
  const loadSessionPage = mock(() => pending)
  const api = { loadSessionPage, loadSession: mock(async () => []) }
  const prefetch = prefetchSessionHistoryPage(api, request)
  expect(loadSessionPage).toHaveBeenCalledTimes(1)
  const restored = requestSessionHistoryPage(api, request, ctx)
  expect(loadSessionPage).toHaveBeenCalledTimes(1)
  finish({ messages: [], before: null })
  expect(await restored).toBe(await prefetch)
  await requestSessionHistoryPage(api, request, ctx)
  expect(loadSessionPage).toHaveBeenCalledTimes(2)
})

test('startup history never crosses a host or a changed request', async () => {
  const { prefetchSessionHistoryPage } = await import('@solus/client-core/session-history-page')
  for (const changed of [
    { ...request, sessionId: 'other' },
    { ...request, projectPath: '/other' },
    { ...request, provider: 'claude-code' as const },
    { ...request, deferToolInputs: true },
    { ...request, limit: 100 },
    { ...request, before: 'older' },
  ]) {
    const api = { loadSessionPage: mock(async () => ({ messages: [], before: null })), loadSession: mock(async () => []) }
    await prefetchSessionHistoryPage(api, request)
    await requestSessionHistoryPage(api, changed, ctx)
    expect(api.loadSessionPage).toHaveBeenCalledTimes(2)
  }
  const first = { loadSessionPage: mock(async () => ({ messages: [], before: null })), loadSession: mock(async () => []) }
  const second = { loadSessionPage: mock(async () => ({ messages: [], before: null })), loadSession: mock(async () => []) }
  await prefetchSessionHistoryPage(first, request)
  await requestSessionHistoryPage(second, request, ctx)
  expect(second.loadSessionPage).toHaveBeenCalledTimes(1)
})

test('failed speculative reads retry normally, including older hosts', async () => {
  const { prefetchSessionHistoryPage } = await import('@solus/client-core/session-history-page')
  const api = {
    loadSessionPage: mock(async () => { throw new Error('Unknown method "loadSessionPage"') }),
    loadSession: mock(async () => []),
  }
  await prefetchSessionHistoryPage(api, request)?.catch(() => {})
  expect(await requestSessionHistoryPage(api, request, ctx)).toEqual([])
  expect(api.loadSession).toHaveBeenCalledTimes(1)
  expect(api.loadSessionPage).toHaveBeenCalledTimes(2)
})

test('settled startup history is available synchronously before normal hydration consumes it', async () => {
  const { prefetchSessionHistoryPage, readPrefetchedSessionHistoryPage } = await import('@solus/client-core/session-history-page')
  const page = { messages: [{ role: 'user', content: 'first visible transcript', timestamp: 1 }], before: null }
  const api = { loadSessionPage: mock(async () => page), loadSession: mock(async () => []) }
  const pending = prefetchSessionHistoryPage(api, request)
  expect(readPrefetchedSessionHistoryPage(api, request)).toBeUndefined()
  await pending
  expect(readPrefetchedSessionHistoryPage(api, request)).toBe(page)
  expect(readPrefetchedSessionHistoryPage(api, { ...request, sessionId: 'different' })).toBeUndefined()
  expect(await requestSessionHistoryPage(api, request, ctx)).toBe(page)
  expect(readPrefetchedSessionHistoryPage(api, request)).toBeUndefined()
  expect(api.loadSessionPage).toHaveBeenCalledTimes(1)
})
