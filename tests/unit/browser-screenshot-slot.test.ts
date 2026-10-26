import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { ChromiumBrowserDriver } from '../../apps/desktop/src/main/browser/chromium-driver'
import { captureInTurn } from '../../apps/desktop/src/main/browser/screenshot-slot'

/**
 * Chromium below 157 crashes the whole app when a guest's renderer dies with a
 * screenshot copy in flight, and overlapping copies make that far likelier. A
 * guest gets one copy at a time. A copy its caller gave up on still holds the
 * guest until it settles, because Chromium keeps it pending, unless the guest
 * loads a new document or goes away.
 */

/** A guest whose screenshots stay pending until the test answers them. */
function fakeGuest() {
  const contents = new EventEmitter()
  let destroyed = false
  const captures: (() => void)[] = []
  const cdp = {
    isAttached: () => true,
    attach: () => {},
    on: () => {},
    off: () => {},
    sendCommand: (method: string) => {
      if (method !== 'Page.captureScreenshot') return Promise.resolve({})
      return new Promise((resolve) => {
        captures.push(() => resolve({ data: `c2hvdC0${captures.length}` }))
      })
    },
  }
  Object.assign(contents, {
    debugger: cdp,
    isDestroyed: () => destroyed,
    setWindowOpenHandler: () => {},
    getBackgroundThrottling: () => false,
  })
  return {
    // SAFETY: the fixture implements every WebContents and Debugger member that attach and capture read.
    contents: contents as unknown as WebContents,
    /** Every capture sent to the guest, in order; call one to answer it. */
    captures,
    navigate: () => contents.emit('did-navigate'),
    destroy: () => {
      destroyed = true
      contents.emit('destroyed')
    },
  }
}

/** Let every settled promise run its handlers. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('one screenshot at a time per guest', () => {
  test('a second capture waits until the first one answers', async () => {
    const guest = fakeGuest()
    const driver = await ChromiumBrowserDriver.attach(guest.contents, { kind: 'headless', releaseGuest: async () => {} })

    const first = driver.captureScreenshot()
    const second = driver.captureScreenshot()
    await flush()
    expect(guest.captures).toHaveLength(1)

    guest.captures[0]()
    await first
    await flush()
    expect(guest.captures).toHaveLength(2)
    guest.captures[1]()
    await second
  })

  test('a new document lets the next capture go, and the old one answering late starts no third', async () => {
    const guest = fakeGuest()
    const driver = await ChromiumBrowserDriver.attach(guest.contents, { kind: 'headless', releaseGuest: async () => {} })

    void driver.captureScreenshot()
    const second = driver.captureScreenshot()
    const third = driver.captureScreenshot()
    await flush()
    guest.navigate()
    await flush()
    expect(guest.captures).toHaveLength(2)

    guest.captures[0]()
    await flush()
    expect(guest.captures).toHaveLength(2)

    guest.captures[1]()
    await second
    await flush()
    expect(guest.captures).toHaveLength(3)
    guest.captures[2]()
    await third
  })

  test('a capture that timed out keeps the guest until Chromium answers it', async () => {
    const guest = fakeGuest()
    const answers: (() => void)[] = []
    const copy = () => new Promise<string>((resolve) => answers.push(() => resolve('shot')))

    const stalled = captureInTurn(guest.contents, 'Page.captureScreenshot', 5, copy)
    await expect(stalled).rejects.toThrow('did not answer Page.captureScreenshot')

    const next = captureInTurn(guest.contents, 'Page.captureScreenshot', 1_000, copy)
    await flush()
    expect(answers).toHaveLength(1)

    answers[0]()
    await flush()
    expect(answers).toHaveLength(2)
    answers[1]()
    expect(await next).toBe('shot')
  })

  test('a capture whose caller gave up while it waited is never sent', async () => {
    const guest = fakeGuest()
    const answers: (() => void)[] = []
    const copy = () => new Promise<string>((resolve) => answers.push(() => resolve('shot')))

    const holding = captureInTurn(guest.contents, 'Page.captureScreenshot', 1_000, copy)
    const abandoned = captureInTurn(guest.contents, 'Page.captureScreenshot', 5, copy)
    await expect(abandoned).rejects.toThrow('did not answer')
    const wanted = captureInTurn(guest.contents, 'Page.captureScreenshot', 1_000, copy)

    answers[0]()
    await holding
    await flush()
    expect(answers).toHaveLength(2)
    answers[1]()
    expect(await wanted).toBe('shot')
  })

  test('a guest that goes away fails its waiting captures at once', async () => {
    const guest = fakeGuest()
    const copy = () => new Promise<string>(() => {})

    void captureInTurn(guest.contents, 'Page.captureScreenshot', 1_000, copy).catch(() => {})
    const waiting = captureInTurn(guest.contents, 'Page.captureScreenshot', 1_000, copy)
    guest.destroy()
    await expect(waiting).rejects.toThrow('went away')
  })
})
