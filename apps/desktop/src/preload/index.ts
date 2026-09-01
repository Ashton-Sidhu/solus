import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { AccountState } from '@solus/contracts/account-types'
import type { ClientNotificationRequest, NotificationSoundLog } from '@solus/contracts/notification-types'

const LOCAL_CONNECTION_CHANNEL = 'solus:local-connection'

export type { LocalConnectionInfo, SolusAPI } from '@solus/contracts/host-api'
import type { LocalConnectionInfo } from '@solus/contracts/host-api'

export type { NativeSolusAPI } from '@solus/contracts/host-api'
import type { NativeSolusAPI } from '@solus/contracts/host-api'

// Main has finished booting the local server before it creates either renderer
// window. Start this immutable bootstrap lookup while the preload itself is
// evaluating so HTML parsing and renderer startup do not sit behind a fresh IPC
// round trip.
const localConnectionPromise: Promise<LocalConnectionInfo> = ipcRenderer.invoke(LOCAL_CONNECTION_CHANNEL)

// One IPC listener per channel, fanned out to however many callers subscribe.
// A listener per caller crossed Node's ten-listener warning threshold on
// `solus:window-shown`: the renderer keeps every tab mounted, so each tab
// holding a composer added its own.
function channelFanOut<Args extends unknown[]>(channel: string): (cb: (...args: Args) => void) => () => void {
  const callbacks = new Set<(...args: Args) => void>()
  ipcRenderer.on(channel, (_event: IpcRendererEvent, ...args: unknown[]) => {
    // SAFETY: main sends exactly `Args` on this channel — the channel name and
    // the payload type are fixed together at each `channelFanOut` call below.
    const payload = args as Args
    for (const cb of callbacks) cb(...payload)
  })
  return (cb) => {
    callbacks.add(cb)
    return () => { callbacks.delete(cb) }
  }
}

const subscribeQuoteSelection = channelFanOut<[text: string, sourceTabId: string]>('solus:quote-selection')
const subscribeAskSelectionInNewSession
  = channelFanOut<[text: string, sourceTabId: string]>('solus:ask-selection-in-new-session')
const subscribeOpenRoute = channelFanOut<[route: string]>('solus:open-route')
const subscribeThemeChange = channelFanOut<[isDark: boolean]>('solus:theme-changed')
const subscribeWindowShown = channelFanOut<[cursorPos: { x: number; y: number } | null]>('solus:window-shown')
const subscribeWindowHidden = channelFanOut<[]>('solus:window-hidden')
const subscribeAccountStateChange = channelFanOut<[state: AccountState]>('solus:account-state-changed')

const nativeApi: NativeSolusAPI = {
  getPlatform: () => process.platform,
  getLocalConnection: () => localConnectionPromise,
  refreshLocalSessionToken: () =>
    ipcRenderer.invoke(LOCAL_CONNECTION_CHANNEL).then((info: LocalConnectionInfo) => info.token),
  openExternal: (url: string, options?: { hideAppAfterOpen?: boolean }) =>
    ipcRenderer.invoke('solus:open-external', url, options),
  showNotification: (request: ClientNotificationRequest) =>
    ipcRenderer.invoke('solus:show-notification', request),
  logNotificationSound: (row: NotificationSoundLog) =>
    ipcRenderer.send('solus:log-notification-sound', row),
  rendererReady: (mode: 'pill' | 'editor') => ipcRenderer.send('solus:renderer-ready', mode),
  rendererMounted: (mode: 'pill' | 'editor') => ipcRenderer.send('solus:renderer-mounted', mode),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  readAttachmentBytes: (path: string, mime: string) =>
    ipcRenderer.invoke('solus:read-attachment-bytes', path, mime),
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward?: boolean; focus?: boolean }) =>
    ipcRenderer.send('solus:set-ignore-mouse-events', ignore, options || {}),
  setZoomFactor: (factor: number) =>
    ipcRenderer.send('solus:set-zoom-factor', factor),
  setQuoteContext: (tabId: string | null) =>
    ipcRenderer.send('solus:set-quote-context', tabId),
  onQuoteSelection: subscribeQuoteSelection,
  onAskSelectionInNewSession: subscribeAskSelectionInNewSession,
  /** A location the app was asked to open from outside the renderer — today a
   *  notification click; the payload is a serialized route. */
  onOpenRoute: subscribeOpenRoute,
  onThemeChange: subscribeThemeChange,
  onWindowShown: subscribeWindowShown,
  onWindowHidden: subscribeWindowHidden,
  accountState: () => ipcRenderer.invoke('solus:account-state'),
  accountSignIn: () => ipcRenderer.invoke('solus:account-sign-in'),
  accountCancelSignIn: () => ipcRenderer.send('solus:account-cancel-sign-in'),
  accountSignOut: () => ipcRenderer.invoke('solus:account-sign-out'),
  accountRetryVerify: () => ipcRenderer.invoke('solus:account-retry-verify'),
  onAccountStateChange: subscribeAccountStateChange,
}

contextBridge.exposeInMainWorld('solusNative', nativeApi)
