import { describe, expect, mock, test } from 'bun:test'
import type { WebContents } from 'electron'
import { browserPartition, browserProfilePartition } from '@solus/contracts/browser-types'
import {
  browserPermissionHandlers,
  guardBrowserSession,
  isBrowserPartition,
  type AskBrowserPermission,
} from '../../apps/desktop/src/main/browser/browser-permissions'

// Any site the user opens runs in a browser partition. Electron grants every
// permission to a session without handlers, so these tests hold the line that
// a page gets nothing powerful unless the user said yes.

const guest = {} as WebContents

function setup(answers: Array<boolean | undefined> = []) {
  const ask = mock<AskBrowserPermission>(async () => answers.shift())
  return { ask, ...browserPermissionHandlers(ask) }
}

function request(
  handlers: ReturnType<typeof setup>,
  permission: Parameters<ReturnType<typeof setup>['request']>[1],
  details: { requestingUrl: string; externalURL?: string } = { requestingUrl: 'https://site.test/' },
): Promise<boolean> {
  return new Promise((resolve) => handlers.request(guest, permission, resolve, { isMainFrame: true, ...details }))
}

describe('browser pane permissions', () => {
  test('a page cannot read the clipboard until the user allows its origin', async () => {
    const handlers = setup([true])
    expect(handlers.check(null, 'clipboard-read', 'https://allowed.test', { isMainFrame: true })).toBe(false)

    expect(await request(handlers, 'clipboard-read', { requestingUrl: 'https://allowed.test/page' })).toBe(true)
    expect(handlers.ask).toHaveBeenCalledTimes(1)
    const prompt = handlers.ask.mock.calls[0]![1]
    expect(prompt.message).toBe('https://allowed.test wants to see text and images copied to the clipboard')
    expect(prompt.buttons).toEqual(['Allow', 'Block'])

    // Asked once per origin: the answer is remembered and the check reports it.
    expect(await request(handlers, 'clipboard-read', { requestingUrl: 'https://allowed.test/other' })).toBe(true)
    expect(handlers.ask).toHaveBeenCalledTimes(1)
    expect(handlers.check(null, 'clipboard-read', 'https://allowed.test', { isMainFrame: true })).toBe(true)
  })

  test('a blocked origin stays blocked without asking again', async () => {
    const handlers = setup([false])
    expect(await request(handlers, 'clipboard-read', { requestingUrl: 'https://blocked.test/' })).toBe(false)
    expect(await request(handlers, 'clipboard-read', { requestingUrl: 'https://blocked.test/again' })).toBe(false)
    expect(handlers.ask).toHaveBeenCalledTimes(1)
    expect(handlers.check(null, 'clipboard-read', 'https://blocked.test', { isMainFrame: true })).toBe(false)
  })

  test('no answer denies the read and asks again next time', async () => {
    const handlers = setup([undefined, true])
    expect(await request(handlers, 'clipboard-read')).toBe(false)
    expect(await request(handlers, 'clipboard-read')).toBe(true)
    expect(handlers.ask).toHaveBeenCalledTimes(2)
  })

  test('a page without an origin never reads the clipboard', async () => {
    const handlers = setup([true])
    expect(await request(handlers, 'clipboard-read', { requestingUrl: 'data:text/html,hi' })).toBe(false)
    expect(handlers.ask).not.toHaveBeenCalled()
  })

  test('each partition remembers its own answers', async () => {
    const first = setup([true])
    const second = setup([false])
    await request(first, 'clipboard-read')
    expect(await request(second, 'clipboard-read')).toBe(false)
    expect(second.ask).toHaveBeenCalledTimes(1)
  })

  test('powerful permissions are denied without asking', async () => {
    const handlers = setup([true, true, true, true, true, true])
    for (const permission of ['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'display-capture', 'keyboardLock', 'idle-detection', 'window-management', 'unknown'] as const) {
      expect(await request(handlers, permission)).toBe(false)
    }
    for (const permission of ['media', 'geolocation', 'notifications', 'hid', 'serial', 'usb', 'deprecated-sync-clipboard-read'] as const) {
      expect(handlers.check(null, permission, 'https://site.test', { isMainFrame: true })).toBe(false)
    }
    expect(handlers.ask).not.toHaveBeenCalled()
  })

  test('harmless permissions a normal page needs are allowed', async () => {
    const handlers = setup()
    for (const permission of ['clipboard-sanitized-write', 'fullscreen', 'pointerLock'] as const) {
      expect(await request(handlers, permission)).toBe(true)
    }
    expect(handlers.check(null, 'clipboard-sanitized-write', 'https://site.test', { isMainFrame: true })).toBe(true)
  })

  test('opening another application asks every time', async () => {
    const handlers = setup([true, false])
    const details = { requestingUrl: 'https://site.test/', externalURL: 'vscode://file/x' }
    expect(await request(handlers, 'openExternal', details)).toBe(true)
    expect(await request(handlers, 'openExternal', details)).toBe(false)
    expect(handlers.ask).toHaveBeenCalledTimes(2)
    expect(handlers.ask.mock.calls[0]![1].message).toBe('Open this vscode link?')
  })

  test('a second prompt while one is open is denied, not stacked', async () => {
    let answer!: (granted: boolean) => void
    const ask = mock<AskBrowserPermission>(() => new Promise((resolve) => { answer = resolve }))
    const handlers = { ask, ...browserPermissionHandlers(ask) }
    const first = request(handlers, 'clipboard-read', { requestingUrl: 'https://one.test/' })
    expect(await request(handlers, 'clipboard-read', { requestingUrl: 'https://two.test/' })).toBe(false)
    answer(true)
    expect(await first).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  test('only browser partitions are guarded, each session once', () => {
    expect(isBrowserPartition(browserPartition('/repo'))).toBe(true)
    expect(isBrowserPartition(browserProfilePartition('/repo', 'default', null))).toBe(true)
    expect(isBrowserPartition(browserProfilePartition('/repo', 'default', 'person'))).toBe(true)
    expect(isBrowserPartition('')).toBe(false)
    expect(isBrowserPartition(undefined)).toBe(false)
    expect(isBrowserPartition('persist:other')).toBe(false)

    const session = { setPermissionRequestHandler: mock(() => {}), setPermissionCheckHandler: mock(() => {}) }
    guardBrowserSession(session, async () => true)
    guardBrowserSession(session, async () => true)
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
  })
})
