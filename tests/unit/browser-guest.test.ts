import { describe, expect, test } from 'bun:test'
import {
  browserGuest,
  shouldUseNativeBrowser,
  type BrowserGuestElement,
} from '../../packages/workspace-ui/src/components/browser/lib/browser-guest'

/**
 * The native guest hands the server its `webContents` id exactly once, and the
 * whole surface — emulation, driving, annotation — hangs off that one handover.
 *
 * Electron fires `did-attach` before `dom-ready` on a freshly mounted guest,
 * and `getWebContentsId` throws until `dom-ready`. The old code read the id in
 * the `did-attach` handler, so on a fresh page the read threw, the id never
 * reached the host, and the page rendered but could not be annotated — which is
 * exactly what "I click a tool and nothing happens" was.
 */

interface FakeGuest extends BrowserGuestElement {
  fire(event: string): void
  listenerCount(event: string): number
}

/** A `<webview>` stand-in whose `getWebContentsId` throws until `domReady` is
 *  set — the one behaviour the attach race turns on. */
function fakeGuest(webContentsId: number): FakeGuest {
  const listeners = new Map<string, Set<() => void>>()
  const attributes = new Map<string, string>()
  let domReady = false
  const node = {
    src: '',
    partition: '',
    getWebContentsId(): number {
      if (!domReady) throw new Error('The WebView must be attached to the DOM and the dom-ready event emitted')
      return webContentsId
    },
    getURL: () => 'about:blank',
    getTitle: () => '',
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    addEventListener(event: string, handler: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)?.add(handler)
    },
    removeEventListener(event: string, handler: () => void) {
      listeners.get(event)?.delete(handler)
    },
    fire(event: string) {
      // `dom-ready` is the moment the id becomes readable — model that here so a
      // handler firing on it sees a working accessor.
      if (event === 'dom-ready') domReady = true
      for (const handler of listeners.get(event) ?? []) handler()
    },
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
  }
  // SAFETY: This fixture implements every guest member the action reads. The
  // remaining HTMLElement surface is deliberately absent because the test
  // verifies Electron event ordering, not browser layout behavior.
  return node as FakeGuest
}

describe('browserGuest attach handover', () => {
  test('does not attach — and does not throw — when did-attach beats dom-ready', () => {
    const node = fakeGuest(7)
    const attached: number[] = []
    browserGuest(node, {
      attach: (id) => attached.push(id),
      detach: () => {},
      report: () => {},
      crashed: () => {},
    })

    // The fresh-guest ordering: did-attach first, before the id is readable.
    expect(() => node.fire('did-attach')).not.toThrow()
    expect(attached).toEqual([])
  })

  test('attaches once dom-ready makes the id readable, and never twice', () => {
    const node = fakeGuest(7)
    const attached: number[] = []
    browserGuest(node, {
      attach: (id) => attached.push(id),
      detach: () => {},
      report: () => {},
      crashed: () => {},
    })

    node.fire('did-attach') // throws internally, swallowed; no attach yet
    node.fire('dom-ready') // id readable now → the one handover
    node.fire('dom-ready') // the real page's later navigations must not re-attach

    expect(attached).toEqual([7])
  })

  test('attaches from did-attach alone when the id is already readable', () => {
    const node = fakeGuest(7)
    const attached: number[] = []
    browserGuest(node, {
      attach: (id) => attached.push(id),
      detach: () => {},
      report: () => {},
      crashed: () => {},
    })

    // A warm guest: dom-ready has already happened, so did-attach can read the id.
    node.fire('dom-ready')
    expect(attached).toEqual([7])
    node.fire('did-attach')
    expect(attached).toEqual([7])
  })

  test('unbinds both attach events on destroy', () => {
    const node = fakeGuest(7)
    const instance = browserGuest(node, {
      attach: () => {},
      detach: () => {},
      report: () => {},
      crashed: () => {},
    })
    expect(node.listenerCount('did-attach')).toBe(1)
    expect(node.listenerCount('dom-ready')).toBe(1)
    instance.destroy()
    expect(node.listenerCount('did-attach')).toBe(0)
    expect(node.listenerCount('dom-ready')).toBe(0)
  })
})

describe('native browser ownership', () => {
  test('uses a webview only for a URL page owned by the local server', () => {
    // WHY: a desktop can display a remote page, but that remote server cannot
    // adopt this process's webContents id. It must receive streamed frames.
    expect(shouldUseNativeBrowser(true, 'local', 'local', 'url')).toBe(true)
    expect(shouldUseNativeBrowser(true, 'remote', 'local', 'url')).toBe(false)
    expect(shouldUseNativeBrowser(true, 'local', 'local', 'device')).toBe(false)
    expect(shouldUseNativeBrowser(false, 'local', 'local', 'url')).toBe(false)
  })
})
