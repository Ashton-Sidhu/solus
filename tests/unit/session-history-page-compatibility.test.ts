import { expect, mock, test } from 'bun:test'
import { requestSessionHistoryPage } from '@solus/client-core/session-history-page'

const request = { sessionId: 'session', provider: 'codex' as const, turnLimit: 10 }

test.each(['codex', 'claude-code'] as const)('restore consumes pending startup history once for %s', async (provider) => {
  const { prefetchSessionHistoryPage } = await import('@solus/client-core/session-history-page')
  let finish!: (page: { messages: []; before: null }) => void
  const pending = new Promise<{ messages: []; before: null }>((resolve) => { finish = resolve })
  const loadSessionPage = mock(() => pending)
  const api = { loadSessionPage }
  const providerRequest = { ...request, provider }
  const prefetch = prefetchSessionHistoryPage(api, providerRequest)
  expect(loadSessionPage).toHaveBeenCalledTimes(1)
  const restored = requestSessionHistoryPage(api, providerRequest)
  expect(loadSessionPage).toHaveBeenCalledTimes(1)
  finish({ messages: [], before: null })
  expect(await restored).toBe(await prefetch)
  await requestSessionHistoryPage(api, providerRequest)
  expect(loadSessionPage).toHaveBeenCalledTimes(2)
})

test('startup history never crosses a host or a changed request', async () => {
  const { prefetchSessionHistoryPage } = await import('@solus/client-core/session-history-page')
  for (const changed of [
    { ...request, sessionId: 'other' },
    { ...request, projectPath: '/other' },
    { ...request, provider: 'claude-code' as const },
    { ...request, turnLimit: 20 },
    { ...request, before: 'older' },
  ]) {
    const api = { loadSessionPage: mock(async () => ({ messages: [], before: null })) }
    await prefetchSessionHistoryPage(api, request)
    await requestSessionHistoryPage(api, changed)
    expect(api.loadSessionPage).toHaveBeenCalledTimes(2)
  }
  const first = { loadSessionPage: mock(async () => ({ messages: [], before: null })) }
  const second = { loadSessionPage: mock(async () => ({ messages: [], before: null })) }
  await prefetchSessionHistoryPage(first, request)
  await requestSessionHistoryPage(second, request)
  expect(second.loadSessionPage).toHaveBeenCalledTimes(1)
})

test('a failed speculative read is not reused; restore reads again', async () => {
  const { prefetchSessionHistoryPage } = await import('@solus/client-core/session-history-page')
  const page = { messages: [], before: null }
  let calls = 0
  const api = { loadSessionPage: mock(async () => { if (++calls === 1) throw new Error('Disconnected'); return page }) }
  await prefetchSessionHistoryPage(api, request).catch(() => {})
  expect(await requestSessionHistoryPage(api, request)).toBe(page)
  expect(api.loadSessionPage).toHaveBeenCalledTimes(2)
})

test('settled startup history is available synchronously before normal hydration consumes it', async () => {
  const { prefetchSessionHistoryPage, readPrefetchedSessionHistoryPage } = await import('@solus/client-core/session-history-page')
  const page = { messages: [{ role: 'user', content: 'first visible transcript', timestamp: 1 }], before: null }
  const api = { loadSessionPage: mock(async () => page) }
  const pending = prefetchSessionHistoryPage(api, request)
  expect(readPrefetchedSessionHistoryPage(api, request)).toBeUndefined()
  await pending
  expect(readPrefetchedSessionHistoryPage(api, request)).toBe(page)
  expect(readPrefetchedSessionHistoryPage(api, { ...request, sessionId: 'different' })).toBeUndefined()
  expect(await requestSessionHistoryPage(api, request)).toBe(page)
  expect(readPrefetchedSessionHistoryPage(api, request)).toBeUndefined()
  expect(api.loadSessionPage).toHaveBeenCalledTimes(1)
})
