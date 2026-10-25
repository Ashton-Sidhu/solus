import { describe, expect, test } from 'bun:test'
import type { WebContents } from 'electron'
import type { BrowserScreencastOptions } from '@solus/server/browser/surface-driver'
import { ChromiumBrowserDriver } from '../../apps/desktop/src/main/browser/chromium-driver'

/**
 * A browser snapshot must show the page. For a page in the browser pane,
 * `Page.captureScreenshot` with `fromSurface: false` returned the top-left of
 * the Solus window instead: another conversation, at the page's size. A
 * pane page reads one fresh frame from its own surface, and a stream that
 * was running (a watcher or a recording) keeps running after the capture.
 */

/** The frame a capture of the page itself returns. */
const PAGE_PNG = `data:image/png;base64,${Buffer.from('page-png').toString('base64')}`

type FrameEmitter = (method: string, params: { data: string; sessionId: number }) => void
type MessageListener = (event: object, method: string, params: { data: string; sessionId: number }) => void

/** A guest whose window copy and own frame differ, recording every CDP command it is sent. */
function fakeGuest() {
  const commands: { method: string; params?: object }[] = []
  const listeners = new Set<MessageListener>()
  const emit: FrameEmitter = (method, params) => { for (const listener of [...listeners]) listener({}, method, params) }
  let sessionId = 0
  const cdp = {
    isAttached: () => true,
    attach: () => {},
    on: (_event: 'message', listener: MessageListener) => { listeners.add(listener) },
    off: (_event: 'message', listener: MessageListener) => { listeners.delete(listener) },
    sendCommand: async (method: string, params?: object) => {
      commands.push({ method, params })
      if (method === 'Page.captureScreenshot') return { data: 'V0lORE9X' } // "WINDOW"
      if (method === 'Runtime.evaluate') return { result: { value: 'null' } }
      // Each frame names the format it was asked in, so a capture's frame and a stream's differ.
      if (method === 'Page.startScreencast') {
        const format = params && 'format' in params ? String(params.format) : 'none'
        queueMicrotask(() => emit('Page.screencastFrame', { data: Buffer.from(`page-${format}`).toString('base64'), sessionId: ++sessionId }))
      }
      return {}
    },
  }
  const contents = {
    debugger: cdp,
    on: () => {},
    isDestroyed: () => false,
    setWindowOpenHandler: () => {},
    getBackgroundThrottling: () => false,
    setBackgroundThrottling: () => {},
    capturePage: async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,V0lORE9X' }),
  }
  // SAFETY: the fixture implements every WebContents and Debugger member that attach and capture read.
  return { contents: contents as unknown as WebContents, commands }
}

async function attached(kind: 'webview' | 'headless') {
  const guest = fakeGuest()
  const driver = await ChromiumBrowserDriver.attach(guest.contents, { kind, releaseGuest: async () => {} })
  guest.commands.length = 0
  return { driver, commands: guest.commands }
}

describe('capturing a page in the browser pane', () => {
  test('the image is a frame of the page itself, never a copy of the window', async () => {
    const { driver, commands } = await attached('webview')
    const image = await driver.captureScreenshot()
    expect(image).toBe(PAGE_PNG)
    expect(commands.some((command) => command.method === 'Page.captureScreenshot')).toBe(false)
    expect(commands.at(-1)?.method).toBe('Page.stopScreencast')
  })

  test('a stream that was running resumes with its own caps after the capture', async () => {
    const { driver, commands } = await attached('webview')
    const streamed: string[] = []
    const options: BrowserScreencastOptions = { quality: 60, maxWidth: 800, maxHeight: 600 }
    await driver.startScreencast(options, (frame) => streamed.push(frame.toString()))
    commands.length = 0

    expect(await driver.captureScreenshot()).toBe(PAGE_PNG)
    // The capture's frame is not the stream's.
    expect(streamed).not.toContain('page-png')
    expect(streamed).toContain('page-jpeg')
    const restart = commands.findLast((command) => command.method === 'Page.startScreencast')
    expect(restart?.params).toMatchObject({ format: 'jpeg', quality: 60, maxWidth: 800, maxHeight: 600 })
    expect(commands.some((command) => command.method === 'Page.stopScreencast')).toBe(false)
  })
})

describe('capturing a headless page', () => {
  test('the emulated surface answers, at the emulated size', async () => {
    const { driver, commands } = await attached('headless')
    expect(await driver.captureScreenshot()).toBe('data:image/png;base64,V0lORE9X')
    expect(commands.find((command) => command.method === 'Page.captureScreenshot')?.params).toMatchObject({ fromSurface: true })
  })
})
