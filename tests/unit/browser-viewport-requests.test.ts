import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { BrowserViewportRequest } from '@solus/contracts/browser-types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const serverConnectionsMock = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: serverConnectionsMock,
}))

/** The store is a `.svelte.ts` module whose singleton is constructed at import
 *  time, so the rune has to exist before that import runs. Identity is enough:
 *  nothing under test here is reactive. */
function installStateRune(): void {
  Reflect.set(globalThis, '$state', Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  ))
}

installStateRune()

const { BrowserStore } = await import('@solus/workspace-ui/contexts/browser/browser.store.svelte')

/**
 * What the pane states while a gesture is still being answered.
 *
 * A dragged edge produces a size per frame and each one is real emulation on the
 * host. The numbers the user is steering cannot wait for that round trip — but
 * nothing that *draws* the page may run ahead of it, or the stage would show a
 * rendering at a size the guest is not emulating.
 */

afterEach(() => {
  serverConnectionsMock.reset()
  // Nothing outside this file puts a rune on the global — a real Svelte build
  // compiles them away — so the teardown is a removal rather than a restore.
  Reflect.deleteProperty(globalThis, '$state')
})

const SERVER_ID = 'local'
const KEY = `${SERVER_ID}\0browser_1`

/** A host that answers viewports only when the test says so — that window is
 *  where every rule below lives. */
function installHost() {
  // Re-installed per test, because the teardown above removes it: no other file
  // should inherit a rune this one put on the global.
  installStateRune()
  const applied: BrowserViewportRequest[] = []
  let release: (() => void) | null = null
  serverConnectionsMock.registerPrimary(SERVER_ID, {
    browserClose: async () => {},
    browserSetViewport: async (_browserPageId: string, request: BrowserViewportRequest) => {
      applied.push(request)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    },
  })
  return {
    applied,
    /** Let the host answer the request currently in flight. */
    answer: async () => {
      release?.()
      release = null
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

const ignoreErrors = () => {}

describe('browser viewport requests', () => {
  test('the size being asked for is stated before the host has answered', async () => {
    // WHY: this is the whole complaint — a drag whose numbers only move when the
    // round trip lands reads as the control being broken, not as latency.
    const host = installHost()
    const store = new BrowserStore()

    store.commitViewport(KEY, { mode: 'custom', width: 913, height: 640 }, ignoreErrors)

    expect(store.requestedViewport(KEY)?.width).toBe(913)
    expect(store.requestedViewport(KEY)?.height).toBe(640)
    await host.answer()
  })

  test('a stated size is clamped the way the host will clamp it', async () => {
    // WHY: a drag past the limit that showed 9000 and then snapped back to 3840
    // would be the chrome disagreeing with the page about what was asked for.
    const host = installHost()
    const store = new BrowserStore()

    store.commitViewport(KEY, { mode: 'custom', width: 10, height: 99_999 }, ignoreErrors)

    expect(store.requestedViewport(KEY)?.width).toBe(120)
    expect(store.requestedViewport(KEY)?.height).toBe(3840)
    await host.answer()
  })

  test('frames that arrive mid-flight collapse to the newest', async () => {
    // WHY: the host must never work through a backlog of sizes the pointer has
    // already left, and the chrome must state where the pointer is now.
    const host = installHost()
    const store = new BrowserStore()

    store.commitViewport(KEY, { mode: 'custom', width: 400, height: 400 }, ignoreErrors)
    store.commitViewport(KEY, { mode: 'custom', width: 500, height: 400 }, ignoreErrors)
    store.commitViewport(KEY, { mode: 'custom', width: 600, height: 400 }, ignoreErrors)

    expect(host.applied).toHaveLength(1)
    expect(store.requestedViewport(KEY)?.width).toBe(600)

    await host.answer()

    expect(host.applied).toHaveLength(2)
    expect(host.applied[1]).toMatchObject({ width: 600 })
  })

  test('once the gesture is answered the page itself is the truth again', async () => {
    // WHY: the request leads, it is not a second source of state. Leaving it set
    // would pin the chrome to a size an agent or a preset later moved.
    const host = installHost()
    const store = new BrowserStore()

    store.commitViewport(KEY, { mode: 'custom', width: 913, height: 640 }, ignoreErrors)
    await host.answer()

    expect(store.requestedViewport(KEY)).toBeNull()
  })

  test('a preset is stated at the device size, not at the numbers asked for', async () => {
    const host = installHost()
    const store = new BrowserStore()

    store.commitViewport(KEY, { mode: 'preset', presetId: 'iphone-15' }, ignoreErrors)

    expect(store.requestedViewport(KEY)?.width).toBe(393)
    expect(store.requestedViewport(KEY)?.presetId).toBe('iphone-15')
    await host.answer()
  })

  test('a page closed mid-gesture leaves no size behind', async () => {
    const host = installHost()
    const store = new BrowserStore()

    store.commitViewport(KEY, { mode: 'custom', width: 913, height: 640 }, ignoreErrors)
    expect(store.requestedViewport(KEY)?.width).toBe(913)

    await store.close(KEY)

    expect(store.requestedViewport(KEY)).toBeNull()
    await host.answer()
  })
})
