import { afterEach, describe, expect, mock, test } from 'bun:test'

/**
 * The desktop headless host owns a window nobody can see, so nobody can close
 * it either. Until a driver exists to own that window, a failed setup has to
 * destroy it, or every retry leaves one more hidden window running.
 */

let failBlankLoad = false
let failDomains = false
const windows: FakeWindow[] = []

class FakeWindow {
  destroyed = false
  readonly webContents = {
    debugger: {
      isAttached: () => true,
      attach: () => {},
      on: () => {},
      off: () => {},
      sendCommand: async () => {
        if (failDomains) throw new Error('Target closed')
        return {}
      },
    },
    on: () => {},
    isDestroyed: () => false,
    setWindowOpenHandler: () => {},
    loadURL: async () => {
      if (failBlankLoad) throw new Error('blank load failed')
    },
  }

  constructor() {
    windows.push(this)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
  }
}

mock.module('electron', () => ({ BrowserWindow: FakeWindow, session: {}, dialog: {} }))

const { registerBrowserHeadlessHost } = await import('../../apps/desktop/src/main/browser/headless-window')
const { browserHeadlessHost, setBrowserHeadlessHost } = await import('@solus/server/browser/surface-driver')

function openGuest() {
  registerBrowserHeadlessHost()
  const open = browserHeadlessHost()?.open
  if (!open) throw new Error('the headless host did not register')
  return open({
    url: 'http://localhost:5173/',
    partition: 'not-a-browser-partition',
    emulation: { viewport: { mode: 'custom', orientation: 'landscape', width: 800, height: 600, deviceScaleFactor: 1, hasTouch: false }, appearance: 'light' },
    report: () => {},
  })
}

afterEach(() => {
  failBlankLoad = false
  failDomains = false
  windows.length = 0
  setBrowserHeadlessHost(null)
})

describe('a headless window whose setup fails', () => {
  test('is destroyed when the blank document does not load', async () => {
    failBlankLoad = true
    await expect(openGuest()).rejects.toThrow('blank load failed')
    expect(windows.map((window) => window.destroyed)).toEqual([true])
  })

  test('is destroyed when the driver does not attach', async () => {
    failDomains = true
    await expect(openGuest()).rejects.toThrow('Target closed')
    expect(windows.map((window) => window.destroyed)).toEqual([true])
  })
})
