import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { defaultViewport, type BrowserPage } from '@solus/contracts/browser-types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))

const previousStateDescriptor = Object.getOwnPropertyDescriptor(globalThis, '$state')
let BrowserStore: typeof import('@solus/workspace-ui/contexts/browser/browser.store.svelte')['BrowserStore']

beforeAll(async () => {
  Object.defineProperty(globalThis, '$state', {
    configurable: true,
    writable: true,
    value: Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value }),
  })
  ;({ BrowserStore } = await import('@solus/workspace-ui/contexts/browser/browser.store.svelte'))
})

beforeEach(() => connections.reset())

afterAll(() => {
  if (previousStateDescriptor) Object.defineProperty(globalThis, '$state', previousStateDescriptor)
  else Reflect.deleteProperty(globalThis, '$state')
})

function page(browserPageId: string, createdAt: number): BrowserPage {
  return {
    browserPageId,
    target: { kind: 'url', url: `http://localhost:${createdAt}/` },
    url: `http://localhost:${createdAt}/`,
    title: browserPageId,
    viewport: defaultViewport(),
    appearance: 'system',
    hostKind: 'headless',
    loadState: 'ready',
    canGoBack: false,
    canGoForward: false,
    devToolsOpen: false,
    annotationTool: null,
    label: browserPageId,
    createdAt,
  }
}

describe('BrowserStore page reconciliation', () => {
  test('removes pages the host no longer lists and repairs the active page', async () => {
    let listed = [page('one', 1), page('gone', 2)]
    connections.registerPrimary('host-a', {
      browserListPages: async () => listed,
    })
    const store = new BrowserStore()
    await store.loadPages('host-a')
    store.activeKey = store.keyOf('host-a', 'gone')

    listed = [page('one', 1)]
    await store.loadPages('host-a')

    // WHY: a restart or another client can close a page while this client is
    // disconnected. An omitted page is deletion, not an unchanged cache entry.
    expect(store.pages.has(store.keyOf('host-a', 'gone'))).toBe(false)
    expect(store.activeKey).toBe(store.keyOf('host-a', 'one'))
  })

  test('does not let an older list response restore stale host state', async () => {
    let finishOld = (_pages: BrowserPage[]): void => {}
    const old = new Promise<BrowserPage[]>((resolve) => { finishOld = resolve })
    let calls = 0
    connections.registerPrimary('host-a', {
      browserListPages: async () => ++calls === 1 ? old : [page('new', 2)],
    })
    const store = new BrowserStore()

    const first = store.loadPages('host-a')
    await store.loadPages('host-a')
    finishOld([page('old', 1)])
    await first

    expect([...store.pages.keys()]).toEqual([store.keyOf('host-a', 'new')])
  })

  test('reloads host state when the connection returns', async () => {
    let listed = [page('before-restart', 1)]
    connections.registerPrimary('host-a', {
      browserListPages: async () => listed,
    })
    const store = new BrowserStore()
    const unsubscribe = store.subscribe()
    await store.loadPages('host-a')

    listed = [page('after-restart', 2)]
    connections.emitStatus('host-a', 'connected')
    await Promise.resolve()
    await Promise.resolve()

    // WHY: events missed while disconnected cannot repair the cache. The list
    // on reconnect is the host's current truth.
    expect([...store.pages.keys()]).toEqual([store.keyOf('host-a', 'after-restart')])
    unsubscribe()
  })
})

describe('BrowserStore streamed frame cache', () => {
  test('keeps the last frame after the visible subscription stops', () => {
    let subscribeCalls = 0
    let unsubscribeCalls = 0
    connections.registerPrimary('host-a', {
      browserSubscribeFrames: async () => { subscribeCalls += 1 },
      browserUnsubscribeFrames: async () => { unsubscribeCalls += 1 },
    })
    const store = new BrowserStore()
    const key = store.keyOf('host-a', 'page-one')
    const data = new Uint8Array([1, 2, 3]).buffer
    const stop = store.subscribeFrames(key, () => {}, () => {})

    connections.framesFor('host-a').receive(
      { browserPageId: 'page-one', seq: 7 },
      data,
    )
    stop()

    // WHY: switching away must stop network work, but switching back should
    // still have a useful picture before the next remote frame arrives.
    expect(store.cachedFrame(key)).toEqual({
      header: { browserPageId: 'page-one', seq: 7 },
      data,
    })
    expect(subscribeCalls).toBe(1)
    expect(unsubscribeCalls).toBe(1)
  })

  test('shares one remote frame watch between mounted surfaces', async () => {
    let subscribeCalls = 0
    let unsubscribeCalls = 0
    connections.registerPrimary('host-a', {
      browserSubscribeFrames: async () => { subscribeCalls += 1 },
      browserUnsubscribeFrames: async () => { unsubscribeCalls += 1 },
    })
    const store = new BrowserStore()
    const key = store.keyOf('host-a', 'page-one')

    const stopEditor = store.subscribeFrames(key, () => {}, () => {})
    const stopPill = store.subscribeFrames(key, () => {}, () => {})
    await Promise.resolve()

    // WHY: the client-side frame channel already fans one frame out to both
    // canvases. Two remote references make reconnect restoration ambiguous and
    // can leave the host streaming after both surfaces are gone.
    expect(subscribeCalls).toBe(1)
    stopEditor()
    expect(unsubscribeCalls).toBe(0)
    stopPill()
    await Promise.resolve()
    expect(unsubscribeCalls).toBe(1)
  })

  test('restores a visible frame watch when a mobile connection returns', async () => {
    const calls: string[] = []
    connections.registerPrimary('host-a', {
      browserListPages: async () => [],
      browserSubscribeFrames: async () => { calls.push('subscribe') },
      browserUnsubscribeFrames: async () => { calls.push('unsubscribe') },
    })
    const store = new BrowserStore()
    const stopStore = store.subscribe()
    const stopFrames = store.subscribeFrames(
      store.keyOf('host-a', 'page-one'),
      () => {},
      () => {},
    )
    await Promise.resolve()

    connections.emitStatus('host-a', 'connected')
    await Promise.resolve()
    await Promise.resolve()

    // WHY: a phone can sleep past the host's client-expiry window without
    // unmounting this surface. A fresh subscribe is the only exit from the
    // skeleton after the socket returns; resetting first also handles a short
    // disconnect whose old watch still exists.
    expect(calls).toEqual(['subscribe', 'unsubscribe', 'subscribe'])

    stopFrames()
    stopStore()
  })
})
