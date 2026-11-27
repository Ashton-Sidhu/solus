import { BrowserWindow, nativeTheme, screen, shell } from 'electron'
import { createLogger } from '@solus/server/logger'
import { appWindowSearch, type AppShortcutTarget, type AppWindowRequest } from '@solus/contracts/app-shortcuts'
import type { AppShortcutRecords } from './app-shortcut-records'
import { appShortcutId } from './launcher-files'
import type { AppLaunchers } from './launchers'
import { restoredWindowBounds } from './window-bounds'

const log = createLogger('main', 'app-windows')

const DEFAULT_SIZE = { width: 1100, height: 760 }

export interface AppWindowsOptions {
  records: AppShortcutRecords
  launchers: AppLaunchers
  preloadPath: string
  /** Loads the Solus renderer page with these search parameters. */
  loadRenderer(window: BrowserWindow, search: URLSearchParams): void
  /** Lets the app take the foreground before the window takes focus. */
  bringToFront(window: BrowserWindow): void
}

/**
 * The app windows of the desktop app (docs/app-shortcuts.md §2): one window
 * for each open app, with the Solus renderer page in its app window form. The
 * page connects to the app's host as the workspace does, so the window holds
 * no state of its own but where the person left it.
 */
export class AppWindows {
  private readonly windows = new Map<string, BrowserWindow>()

  constructor(private readonly options: AppWindowsOptions) {}

  /** Opens the window of one app, or brings the one it has to the front. */
  open(request: AppWindowRequest): void {
    const key = appShortcutId(request)
    const existing = this.windows.get(key)
    if (existing && !existing.isDestroyed()) {
      this.reveal(existing)
      return
    }
    const { records } = this.options
    const window = new BrowserWindow({
      ...restoredWindowBounds(records.windowBounds(request), screen.getAllDisplays().map((display) => display.workArea)) ?? DEFAULT_SIZE,
      minWidth: 360,
      minHeight: 320,
      title: request.name || 'Solus',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#21201d' : '#fbfaf6',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    this.windows.set(key, window)
    this.applyIdentity(window, request, request.name)

    const contents = window.webContents
    contents.on('render-process-gone', (_event, details) => {
      log.error('app_window_renderer_gone', { appId: request.appId, reason: details.reason, exitCode: details.exitCode })
    })
    // The page is the Solus renderer; a link in it must not replace it.
    contents.on('will-navigate', (event) => {
      if (event.url.startsWith(new URL(contents.getURL()).origin)) return
      event.preventDefault()
      if (/^https?:\/\//i.test(event.url)) void shell.openExternal(event.url)
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    window.once('ready-to-show', () => this.reveal(window))
    window.on('close', () => records.saveWindowBounds(request, window.getNormalBounds()))
    window.on('closed', () => {
      if (this.windows.get(key) === window) this.windows.delete(key)
    })
    this.options.loadRenderer(window, appWindowSearch(request))
    log.info('app_window_opened', { appId: request.appId, host: request.host })
  }

  /** Gives the open window of an app the icon of its shortcut, after the launcher was written again. */
  showIdentity(target: AppShortcutTarget, name: string): void {
    const window = this.windows.get(appShortcutId(target))
    if (window && !window.isDestroyed()) this.applyIdentity(window, target, name)
  }

  private applyIdentity(window: BrowserWindow, target: AppShortcutTarget, name: string): void {
    const identity = this.options.launchers.windowIdentity(target, name)
    if (identity.iconPath) window.setIcon(identity.iconPath)
    if (identity.taskbar) window.setAppDetails(identity.taskbar)
  }

  private reveal(window: BrowserWindow): void {
    if (window.isMinimized()) window.restore()
    window.show()
    this.options.bringToFront(window)
    window.focus()
  }
}
