import { beforeEach, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { Session, WebContents } from 'electron'
import { browserProfilePartition } from '@solus/contracts/browser-types'
import { browserProfileHost } from '@solus/server/browser/surface-driver'
import type { BrowserMediaDevice, BrowserPermissionHandlers } from '../../apps/desktop/src/main/browser/browser-permissions'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })

const window = { isDestroyed: () => false, isVisible: () => true }
const showMessageBox = mock<(owner: typeof window, options: Electron.MessageBoxOptions) => Promise<{ response: number }>>(
  async () => ({ response: 0 }),
)
const status: Record<BrowserMediaDevice, ReturnType<Electron.SystemPreferences['getMediaAccessStatus']>> = {
  camera: 'granted',
  microphone: 'granted',
}
const askForMediaAccess = mock(async (device: BrowserMediaDevice) => {
  status[device] = 'granted'
  return true
})
const fromPartition = mock<(partition: string) => Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'clearStorageData'>>()

mock.module('electron', () => ({
  BrowserWindow: { fromWebContents: () => window },
  session: { fromPartition },
  webContents: {},
  dialog: { showMessageBox },
  systemPreferences: { askForMediaAccess, getMediaAccessStatus: (device: BrowserMediaDevice) => status[device] },
}))

const { guardBrowserPartition } = await import('../../apps/desktop/src/main/browser/guard-browser-partition')
Object.defineProperty(process, 'platform', platform)
const { registerBrowserWebviewHost } = await import('../../apps/desktop/src/main/browser/webview-driver')

const partition = browserProfilePartition('/repo', 'default', 'person')

function setup() {
  let request!: BrowserPermissionHandlers['request']
  let check!: BrowserPermissionHandlers['check']
  const session = {
    setPermissionRequestHandler(handler: BrowserPermissionHandlers['request']) { request = handler },
    setPermissionCheckHandler(handler: BrowserPermissionHandlers['check']) { check = handler },
    clearStorageData: mock(async () => {}),
  }
  fromPartition.mockReturnValue(session)
  guardBrowserPartition(partition)
  registerBrowserWebviewHost()
  // SAFETY: This fixture implements the WebContents members read by the permission handlers.
  const guest = Object.assign(new EventEmitter(), {
    getType: () => 'webview',
    isDestroyed: () => false,
    hostWebContents: {},
  }) as unknown as WebContents
  const origin = 'https://site.test'
  return {
    request: (mediaTypes: Array<'audio' | 'video'> = ['video']) => new Promise<boolean>((resolve) => {
      const details = { isMainFrame: true, requestingUrl: `${origin}/page`, securityOrigin: origin, mediaTypes }
      request(guest, 'media', resolve, details)
    }),
    cameraAllowed: () => check(guest, 'media', origin, { isMainFrame: true, mediaType: 'video' }),
    clear: () => browserProfileHost()!.clearProfile(partition),
    clearStorageData: session.clearStorageData,
  }
}

beforeEach(() => {
  status.camera = 'granted'
  status.microphone = 'granted'
  showMessageBox.mockClear()
  askForMediaAccess.mockClear()
})

test('Block is the default and cancel action, and site consent precedes macOS consent', async () => {
  const browser = setup()
  status.camera = 'not-determined'
  showMessageBox.mockResolvedValueOnce({ response: 1 })
  expect(await browser.request()).toBe(false)
  expect(showMessageBox.mock.calls[0]?.[1]).toMatchObject({ buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1 })
  expect(askForMediaAccess).not.toHaveBeenCalled()

  await browser.clear()
  expect(browser.clearStorageData).toHaveBeenCalledTimes(1)
  expect(await browser.request()).toBe(true)
  expect(askForMediaAccess).toHaveBeenCalledWith('camera')
  expect(browser.cameraAllowed()).toBe(true)
  status.camera = 'denied'
  expect(browser.cameraAllowed()).toBe(false)
  expect(await browser.request()).toBe(false)
  expect(showMessageBox.mock.calls.at(-1)?.[1]).toMatchObject({
    type: 'info',
    message: 'Solus needs system access to your camera.',
  })
  expect(askForMediaAccess).toHaveBeenCalledTimes(1)
})

test('clearing the profile revokes an allow decision and discards a pending site answer', async () => {
  const browser = setup()
  expect(await browser.request(['audio'])).toBe(true)
  let answer!: (result: { response: number }) => void
  showMessageBox.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
  const pending = browser.request()
  await browser.clear()
  expect(showMessageBox.mock.calls.at(-1)?.[1].signal?.aborted).toBe(true)
  answer({ response: 0 })
  expect(await pending).toBe(false)
  expect(browser.cameraAllowed()).toBe(false)
  expect(await browser.request(['video', 'audio'])).toBe(true)
  expect(showMessageBox).toHaveBeenCalledTimes(3)
  expect(await browser.request(['audio'])).toBe(true)
  expect(showMessageBox).toHaveBeenCalledTimes(3)
})

test('clearing the profile during the first macOS request discards consent and skips the next device', async () => {
  const browser = setup()
  status.camera = 'not-determined'
  status.microphone = 'not-determined'
  let release!: (allowed: boolean) => void
  let entered!: () => void
  const systemRequested = new Promise<void>((resolve) => { entered = resolve })
  askForMediaAccess.mockImplementationOnce(() => new Promise((resolve) => {
    release = resolve
    entered()
  }))
  const pending = browser.request(['video', 'audio'])
  await systemRequested
  await browser.clear()
  status.camera = 'granted'
  release(true)
  expect(await pending).toBe(false)
  expect(browser.cameraAllowed()).toBe(false)
  expect(askForMediaAccess).toHaveBeenCalledTimes(1)
  expect(await browser.request()).toBe(true)
  expect(showMessageBox).toHaveBeenCalledTimes(2)
})
