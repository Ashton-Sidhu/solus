import { describe, expect, jest, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
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

type MessageListener = (event: object, method: string, params: object, sessionId?: string) => void

/** A guest whose window copy and own frame differ, recording every CDP command it is sent. */
function fakeGuest(stalls = false, visible = false, executeHost = async (_script: string) => visible) {
  const commands: { method: string; params?: object; target?: string }[] = []
  const listeners = new Set<MessageListener>()
  const emit = (method: string, params: object, target = '') => {
    for (const listener of [...listeners]) listener({}, method, params, target)
  }
  const attachFrame = (frameId: string, target: string, parent?: string) => {
    emit('Target.attachedToTarget', { sessionId: target, targetInfo: { targetId: frameId, type: 'iframe' } }, parent)
  }
  let sessionId = 0
  let surfaceCopies = 0
  const pendingFrames: (() => void)[] = []
  const pressSent = Promise.withResolvers<void>()
  const throttling: boolean[] = []
  let nativeCaptures = 0
  let throttled = true
  const cdp = {
    isAttached: () => true,
    attach: () => {},
    on: (event: 'message' | 'detach', listener: MessageListener) => { if (event === 'message') listeners.add(listener) },
    off: (event: 'message' | 'detach', listener: MessageListener) => { if (event === 'message') listeners.delete(listener) },
    sendCommand: async (method: string, params?: object, target?: string) => {
      commands.push({ method, params, target })
      // The first copy of a surface is an old frame; later copies are current.
      if (method === 'Page.captureScreenshot') return { data: surfaceCopies++ === 0 ? 'U1RBTEU=' : 'V0lORE9X' } // "STALE", "WINDOW"
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { pageX: 0, pageY: 100 } }
      if (method === 'DOM.getNodeForLocation') return { backendNodeId: 2 }
      if (method === 'DOM.describeNode') {
        const frameId = target === 'child' ? 'nested-frame' : target === undefined ? 'frame' : undefined
        return { node: { frameId } }
      }
      if (method === 'DOM.getBoxModel') return { model: { content: [10, 20, 100, 20, 100, 200, 10, 200] } }
      if (stalls && method === 'Input.dispatchMouseEvent' && params && 'type' in params && params.type === 'mousePressed') {
        pressSent.resolve()
        await new Promise<void>((resolve) => pendingFrames.push(resolve))
      }
      if (method === 'Runtime.evaluate') return { result: { value: 'null' } }
      // Each frame names the format it was asked in, so a capture's frame and a stream's differ.
      if (method === 'Page.startScreencast') {
        const format = params && 'format' in params ? String(params.format) : 'none'
        const paint = () => emit('Page.screencastFrame', { data: Buffer.from(`page-${format}`).toString('base64'), sessionId: ++sessionId })
        if (stalls) pendingFrames.push(paint)
        else queueMicrotask(paint)
      }
      return {}
    },
  }
  const contents = {
    debugger: cdp,
    id: 42,
    hostWebContents: { isDestroyed: () => false, executeJavaScript: executeHost },
    on: () => {},
    isDestroyed: () => false,
    setWindowOpenHandler: () => {},
    session: { on: () => {}, off: () => {} },
    getBackgroundThrottling: () => throttled,
    setBackgroundThrottling: (value: boolean) => { throttled = value; throttling.push(value) },
    capturePage: async () => {
      nativeCaptures++
      for (const paint of pendingFrames.splice(0)) paint()
      return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,V0lORE9X' }
    },
  }
  // SAFETY: the fixture implements every WebContents and Debugger member that attach and capture read.
  return { contents: contents as unknown as WebContents, commands, listeners, emit, attachFrame, throttling, pressSent: pressSent.promise, nativeCaptures: () => nativeCaptures }
}

async function attached(kind: 'webview' | 'headless') {
  const guest = fakeGuest()
  const driver = await ChromiumBrowserDriver.attach(guest.contents, { kind, releaseGuest: async () => {} })
  guest.commands.length = 0
  return { driver, commands: guest.commands, nativeCaptures: guest.nativeCaptures }
}

describe('capturing a page in the browser pane', () => {
  test('the image is a frame of the page itself, never a copy of the window', async () => {
    const { driver, commands, nativeCaptures } = await attached('webview')
    const image = await driver.captureScreenshot()
    expect(image).toBe(PAGE_PNG)
    expect(commands.some((command) => command.method === 'Page.captureScreenshot')).toBe(false)
    expect(commands.at(-1)?.method).toBe('Page.stopScreencast')
    expect(nativeCaptures()).toBe(0)
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

describe('console text', () => {
  test('a cut entry does not end on half of an emoji', async () => {
    // WHY: a snapshot carries this text to an agent, and a provider that reads
    // strict JSON rejects a message with a lone surrogate.
    const guest = fakeGuest()
    const driver = await ChromiumBrowserDriver.attach(guest.contents, { kind: 'headless', releaseGuest: async () => {} })
    const long = `${'a'.repeat(1999)}😀`
    for (const listener of guest.listeners) {
      listener({}, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: long }] })
      listener({}, 'Log.entryAdded', { entry: { level: 'error', text: long } })
    }
    expect(driver.consoleEntries().map((entry) => entry.text)).toEqual(['a'.repeat(1999), 'a'.repeat(1999)])
  })
})

describe('capturing a headless page', () => {
  test('the emulated surface answers, at the emulated size', async () => {
    const { driver, commands } = await attached('headless')
    expect(await driver.captureScreenshot()).toBe('data:image/png;base64,V0lORE9X')
    expect(commands.find((command) => command.method === 'Page.captureScreenshot')?.params).toMatchObject({ fromSurface: true })
  })

  test('the first copy wakes the surface and is discarded; the kept copy is taken after the page paints', async () => {
    // WHY: a window that is never shown can answer with the last frame it drew.
    // A snapshot showed an app's boot splash while its workspace was in the DOM.
    const { driver, commands } = await attached('headless')
    expect(await driver.captureScreenshot()).toBe('data:image/png;base64,V0lORE9X')
    const steps = commands.map((command) => command.method === 'Runtime.evaluate'
      && command.params && 'expression' in command.params && String(command.params.expression).includes('requestAnimationFrame')
      ? 'paint'
      : command.method)
    expect(steps).toEqual(['Page.captureScreenshot', 'paint', 'Page.captureScreenshot'])
  })
})


test('a stalled pane screenshot and click wake their own guest and restore throttling', async () => {
  const guest = fakeGuest(true)
  const driver = await ChromiumBrowserDriver.attach(guest.contents, { kind: 'webview', releaseGuest: async () => {} })
  jest.useFakeTimers()
  try {
    const shot = driver.captureScreenshot()
    await Promise.resolve()
    jest.advanceTimersByTime(250)
    expect(guest.nativeCaptures()).toBe(1)
    expect(await shot).toBe(PAGE_PNG)

    const click = driver.clickAt(30, 40)
    await guest.pressSent
    jest.advanceTimersByTime(250)
    expect(guest.nativeCaptures()).toBe(2)
    await click
    jest.advanceTimersByTime(20_000)
    expect(guest.nativeCaptures()).toBe(2)
    expect(guest.throttling).toEqual([false, true, false, true])
  } finally {
    jest.useRealTimers()
  }
})

test.each([false, true])('clicks use the frame session only when the guest is in the background (visible = %s)', async (visible) => {
  const guest = fakeGuest(false, visible)
  const driver = await ChromiumBrowserDriver.attach(guest.contents, { kind: 'webview', releaseGuest: async () => {} })
  guest.attachFrame('frame', 'child')
  await driver.clickAt(30, 40)
  const events = guest.commands.filter(({ method }) => method === 'Input.dispatchMouseEvent')
  const point = visible ? { x: 30, y: 40 } : { x: 20, y: 20 }
  expect(events).toEqual([
    { method: 'Input.dispatchMouseEvent', target: visible ? undefined : 'child', params: { ...point, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 } },
    { method: 'Input.dispatchMouseEvent', target: visible ? undefined : 'child', params: { ...point, type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 } },
  ])
})


test('a parked click reaches a nested cross-site frame using each viewport and scroll offset', async () => {
  const guest = fakeGuest()
  const driver = await ChromiumBrowserDriver.attach(guest.contents, { kind: 'webview', releaseGuest: async () => {} })
  guest.attachFrame('frame', 'child')
  guest.attachFrame('nested-frame', 'nested', 'child')
  await driver.clickAt(35, 55)
  expect(guest.commands.filter(({ method }) => method === 'DOM.getNodeForLocation').map(({ target, params }) => ({ target, params }))).toEqual([
    { target: undefined, params: { x: 35, y: 155, includeUserAgentShadowDOM: true } },
    { target: 'child', params: { x: 25, y: 135, includeUserAgentShadowDOM: true } },
    { target: 'nested', params: { x: 15, y: 115, includeUserAgentShadowDOM: true } },
  ])
  expect(guest.commands.filter(({ method }) => method === 'Input.dispatchMouseEvent')).toEqual([
    { method: 'Input.dispatchMouseEvent', target: 'nested', params: { type: 'mousePressed', x: 15, y: 15, button: 'left', buttons: 1, clickCount: 1 } },
    { method: 'Input.dispatchMouseEvent', target: 'nested', params: { type: 'mouseReleased', x: 15, y: 15, button: 'left', buttons: 0, clickCount: 1 } },
  ])
  expect(guest.nativeCaptures()).toBe(0)
})

test('a detached frame fails the click before mouse release even when Chromium never replies to the press', async () => {
  const guest = fakeGuest(true)
  const driver = await ChromiumBrowserDriver.attach(guest.contents, { kind: 'webview', releaseGuest: async () => {} })
  guest.attachFrame('frame', 'child')
  const click = driver.clickAt(30, 40)
  await guest.pressSent
  guest.emit('Target.detachedFromTarget', { sessionId: 'child' })
  await expect(click).rejects.toThrow('The frame under the pointer went away')
  expect(guest.commands.filter(({ method }) => method === 'Input.dispatchMouseEvent')).toHaveLength(1)
})

test.each([true, false])('a click restores focus only when its own webview still has it (stole focus = %s)', async (stoleFocus) => {
  const document = {
    querySelectorAll: () => [view],
    body: {},
    visibilityState: 'visible',
    hasFocus: () => true,
    get activeElement() { return active },
  }
  class Element {
    isConnected = true
    focus() { active = this }
  }
  const view = new class extends Element {
    getWebContentsId() { return 42 }
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100 } }
  }()
  const input = new Element()
  const otherControl = new Element()
  let active = input
  const context = { document, HTMLElement: Element, innerWidth: 100, innerHeight: 100 }
  const guest = fakeGuest(true, true, async (script) => runInNewContext(script, context))
  const driver = await ChromiumBrowserDriver.attach(guest.contents, { kind: 'webview', releaseGuest: async () => {} })
  const click = driver.clickAt(30, 40)
  await guest.pressSent
  active = stoleFocus ? view : otherControl
  await guest.contents.capturePage()
  await click
  expect(active).toBe(stoleFocus ? input : otherControl)
})
