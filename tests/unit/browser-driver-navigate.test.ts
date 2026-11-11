import { describe, expect, test } from 'bun:test'
import type { WebContents } from 'electron'
import { ChromiumBrowserDriver } from '../../apps/desktop/src/main/browser/chromium-driver'

/**
 * A page that redirects while it loads replaces the load, and Electron rejects
 * `loadURL` with ERR_ABORTED (-3). The navigation worked, so `goto` must not
 * report an error. A page that blocks its unload rejects with the same code,
 * and that navigation did not happen, so it stays an error.
 */

/** The error shape Electron's `loadURL` rejects with. */
function loadError(errno: number, code: string, url: string) {
  return Object.assign(new Error(`${code} (${errno}) loading '${url}'`), { errno, code, url })
}

type Listener = () => void

/** A guest whose `loadURL` runs the given behavior with the listeners it holds. */
async function guest(load: (listeners: Map<string, Set<Listener>>) => Promise<void>) {
  const listeners = new Map<string, Set<Listener>>()
  const cdp = {
    isAttached: () => true,
    attach: () => {},
    on: () => {},
    off: () => {},
    sendCommand: async (method: string) => method === 'Runtime.evaluate' ? { result: { value: 'null' } } : {},
  }
  const contents = {
    debugger: cdp,
    on: (event: string, listener: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)?.add(listener)
    },
    off: (event: string, listener: Listener) => { listeners.get(event)?.delete(listener) },
    isDestroyed: () => false,
    setWindowOpenHandler: () => {},
    getBackgroundThrottling: () => false,
    setBackgroundThrottling: () => {},
    loadURL: () => load(listeners),
  }
  // SAFETY: the fixture implements every WebContents and Debugger member that attach and navigate read.
  const driver = await ChromiumBrowserDriver.attach(contents as unknown as WebContents, { kind: 'webview', releaseGuest: async () => {} })
  return { driver, listeners }
}

describe('goto in the browser pane', () => {
  test('a redirect while the page loads is a successful navigation', async () => {
    const { driver, listeners } = await guest(async () => { throw loadError(-3, 'ERR_ABORTED', 'https://example.com/target') })
    await driver.navigate({ kind: 'goto', url: 'https://example.com/' })
    expect(listeners.get('will-prevent-unload')?.size ?? 0).toBe(0)
  })

  test('an unload the page blocked is still an error', async () => {
    const { driver, listeners } = await guest(async (held) => {
      for (const listener of held.get('will-prevent-unload') ?? []) listener()
      throw loadError(-3, 'ERR_ABORTED', 'https://example.com/blocked')
    })
    await expect(driver.navigate({ kind: 'goto', url: 'https://example.com/blocked' })).rejects.toMatchObject({ errno: -3 })
    expect(listeners.get('will-prevent-unload')?.size ?? 0).toBe(0)
  })

  test('a load that fails for another reason is an error', async () => {
    const { driver } = await guest(async () => { throw loadError(-105, 'ERR_NAME_NOT_RESOLVED', 'https://missing.invalid/') })
    await expect(driver.navigate({ kind: 'goto', url: 'https://missing.invalid/' })).rejects.toMatchObject({ errno: -105 })
  })
})
