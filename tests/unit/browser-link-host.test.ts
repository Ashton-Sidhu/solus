import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { BrowserOpenRequest, BrowserPage } from '@solus/contracts/browser-types'
import { isWebUrl } from '@solus/workspace-ui/components/conversation/lib/external-link'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const serverConnectionsMock = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: serverConnectionsMock,
}))

/** The store's singleton is built at import time, so the rune has to exist
 *  first. Identity is enough: nothing under test here is reactive. */
function installStateRune(): void {
  Reflect.set(globalThis, '$state', Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  ))
}

installStateRune()

const { BrowserStore } = await import('@solus/workspace-ui/contexts/browser/browser.store.svelte')

afterEach(() => {
  serverConnectionsMock.reset()
  Reflect.deleteProperty(globalThis, '$state')
})

describe('which addresses a browser pane can render', () => {
  test('an ordinary web address', () => {
    expect(isWebUrl('https://example.com/docs')).toBe(true)
    expect(isWebUrl('http://localhost:5173/')).toBe(true)
  })

  test('not a scheme a browser page cannot render', () => {
    // WHY: an affordance that opens nothing is worse than no affordance. Solus's
    // own schemes are among these; whether a routable https link is offered is
    // the link component's call, made where it knows the route.
    expect(isWebUrl('plan://open?planId=p1')).toBe(false)
    expect(isWebUrl('work://open?workId=w1')).toBe(false)
    expect(isWebUrl('file:///Users/dev/app/src/main.ts')).toBe(false)
    expect(isWebUrl('mailto:dev@example.com')).toBe(false)
    expect(isWebUrl('not a url')).toBe(false)
    expect(isWebUrl('')).toBe(false)
  })
})

describe('the page opens on the session’s host', () => {
  function installHosts() {
    installStateRune()
    const opened: { serverId: string; request: BrowserOpenRequest }[] = []
    const host = (serverId: string) => ({
      browserOpen: async (request: BrowserOpenRequest): Promise<BrowserPage> => {
        opened.push({ serverId, request })
        return { browserPageId: `browser_${serverId}`, createdAt: 1 } as BrowserPage
      },
    })
    serverConnectionsMock.registerPrimary('laptop', host('laptop'))
    serverConnectionsMock.registerHost('studio', host('studio'))
    return opened
  }

  test('a link from a remote session opens there, not on the primary host', async () => {
    // WHY: `localhost:5173` in a remote agent's output is a dev server on that
    // machine. Opening it here resolves the address against the wrong app, or
    // against nothing at all.
    const opened = installHosts()
    const store = new BrowserStore()

    const key = await store.open('studio', { target: { kind: 'url', url: 'http://localhost:5173/' } })

    expect(opened).toEqual([
      { serverId: 'studio', request: { target: { kind: 'url', url: 'http://localhost:5173/' } } },
    ])
    expect(key.startsWith('studio')).toBe(true)
  })

  test('the opened page is mirrored under its own host’s key', async () => {
    // WHY: a page id is unique only within its host, and two hosts can serve the
    // same worktree name.
    installHosts()
    const store = new BrowserStore()

    const key = await store.open('studio', { target: { kind: 'url', url: 'https://example.com/' } })

    expect(store.pages.get(key)?.serverId).toBe('studio')
    expect(store.activeKey).toBe(key)
  })
})
