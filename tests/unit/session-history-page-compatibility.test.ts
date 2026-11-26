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

test('a mobile account change or reconnect cannot consume the previous first page', async () => {
  const { prefetchSessionHistoryPage } = await import('@solus/client-core/session-history-page')
  const api = { loadSessionPage: mock(async () => ({ messages: [], before: null })) }
  await prefetchSessionHistoryPage(api, request, 3_000, 'previous')
  await requestSessionHistoryPage(api, request, 'current')
  expect(api.loadSessionPage).toHaveBeenCalledTimes(2)
})

test('a page read on hover serves the click only while the same run goes on', async () => {
  const { prefetchSessionHistoryPage } = await import('@solus/client-core/session-history-page')
  const { sessionRunKey } = await import('@solus/contracts/session-execution')
  const working = { revision: 1, current: { runId: 'run-1', phase: 'running' as const, startedAt: 1 }, lastTurn: null }
  let execution: Parameters<typeof sessionRunKey>[0] = working
  const api = { loadSessionPage: mock(async () => ({ messages: [], before: null })) }
  const readDuring = sessionRunKey(execution)
  const isCurrent = () => sessionRunKey(execution) === readDuring

  // The same run goes on: the watch replays it, so the hovered page serves the click.
  await prefetchSessionHistoryPage(api, request, 10_000, undefined, undefined, isCurrent)
  execution = { ...working, revision: 2 }
  await requestSessionHistoryPage(api, request)
  expect(api.loadSessionPage).toHaveBeenCalledTimes(1)

  // The run ended before the click: its end is in no replay, so the click reads again.
  execution = working
  await prefetchSessionHistoryPage(api, request, 10_000, undefined, undefined, isCurrent)
  execution = { revision: 3, current: null, lastTurn: { runId: 'run-1', outcome: 'completed', startedAt: 1, endedAt: 2 } }
  await requestSessionHistoryPage(api, request)
  expect(api.loadSessionPage).toHaveBeenCalledTimes(3)
})

test('the pointer-down read replaces a hovered page that went stale', async () => {
  const { prefetchSessionHistoryPage } = await import('@solus/client-core/session-history-page')
  const api = { loadSessionPage: mock(async () => ({ messages: [], before: null })) }
  let isStale = false
  await prefetchSessionHistoryPage(api, request, 10_000, undefined, undefined, () => !isStale)
  isStale = true
  const pressed = await prefetchSessionHistoryPage(api, request)
  expect(api.loadSessionPage).toHaveBeenCalledTimes(2)
  expect(await requestSessionHistoryPage(api, request)).toBe(pressed)
  expect(api.loadSessionPage).toHaveBeenCalledTimes(2)
})

test('the run key changes when a run starts or ends, and not while one goes on', async () => {
  const { sessionRunKey } = await import('@solus/contracts/session-execution')
  const idle = { revision: 1, current: null, lastTurn: { runId: 'run-1', outcome: 'completed' as const, startedAt: 1, endedAt: 2 } }
  const working = { ...idle, revision: 2, current: { runId: 'run-2', phase: 'running' as const, startedAt: 3 } }
  const waiting = { ...working, revision: 3, current: { ...working.current, phase: 'awaiting_input' as const } }
  const ended = { revision: 4, current: null, lastTurn: { runId: 'run-2', outcome: 'completed' as const, startedAt: 3, endedAt: 4 } }
  expect(sessionRunKey(working)).not.toBe(sessionRunKey(idle))
  expect(sessionRunKey(waiting)).toBe(sessionRunKey(working))
  expect(sessionRunKey(ended)).not.toBe(sessionRunKey(working))
})
