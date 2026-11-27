import { BrowserWindow, nativeTheme, screen, shell, type WebContents } from 'electron'
import { createLogger } from '@solus/server/logger'
import type { AppDesktopEvent } from '@solus/contracts/app-desktop'
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
  /** Solus quits: a window closes even when its app keeps running hidden. */
  isQuitting(): boolean
  /** What the desktop capabilities of the app need to know (docs/plans/app-desktop-capabilities.md §4). */
  lifecycle: AppWindowLifecycle
}

export interface AppWindowLifecycle {
  opened(target: AppShortcutTarget): void
  /** The window's page loaded again. */
  reloaded(target: AppShortcutTarget): void
  /** The page's title, the app's name, changed. */
  renamed(target: AppShortcutTarget): void
  focusChanged(target: AppShortcutTarget, type: 'focus' | 'blur'): void
  /** A close hides the window instead: the app has a menu-bar item. */
  keepsRunning(target: AppShortcutTarget): boolean
  ended(target: AppShortcutTarget): void
}

/** The channel of an event to the page of an app window. */
export const APP_DESKTOP_EVENT_CHANNEL = 'solus:app-desktop-event'

/**
 * The app windows of the desktop app (docs/app-shortcuts.md §2): one window
 * for each open app, with the Solus renderer page in its app window form. The
 * page connects to the app's host as the workspace does, so the window holds
 * no state of its own but where the person left it.
 */
export class AppWindows {
  private readonly windows = new Map<string, BrowserWindow>()
  /** The app of each window's page, by its web contents id: a desktop call names its app from its sender only. */
  private readonly targets = new Map<number, AppShortcutTarget>()

  constructor(private readonly options: AppWindowsOptions) {}

  /** The open window of one app. */
  windowOf(target: AppShortcutTarget): BrowserWindow | null {
    const window = this.windows.get(appShortcutId(target))
    return window && !window.isDestroyed() ? window : null
  }

  /** The app whose window `contents` is, or null for any other page. */
  targetOf(contents: WebContents): AppShortcutTarget | null {
    return this.targets.get(contents.id) ?? null
  }

  /** Each open app window. */
  all(): BrowserWindow[] {
    return [...this.windows.values()].filter((window) => !window.isDestroyed())
  }

  send(target: AppShortcutTarget, event: AppDesktopEvent): void {
    this.windowOf(target)?.webContents.send(APP_DESKTOP_EVENT_CHANNEL, event)
  }

  /** Closes the window of an app, even when its app would keep it running hidden. */
  close(target: AppShortcutTarget): void {
    this.windowOf(target)?.destroy()
  }

  /**
   * Opens the window of one app, or brings the one it has to the front.
   * `isHidden` opens it with no window shown, for an app that starts at login:
   * its page runs, so its menu-bar item and its shortcuts work.
   */
  open(request: AppWindowRequest, { isHidden = false }: { isHidden?: boolean } = {}): void {
    const key = appShortcutId(request)
    const existing = this.windows.get(key)
    if (existing && !existing.isDestroyed()) {
      if (!isHidden) this.reveal(existing)
      return
    }
    const { records, launchers, lifecycle } = this.options
    const target: AppShortcutTarget = { host: request.host, appId: request.appId }
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
    const contentsId = window.webContents.id
    this.targets.set(contentsId, target)
    const identity = launchers.windowIdentity(request, request.name)
    if (identity.iconPath) window.setIcon(identity.iconPath)
    if (identity.taskbar) window.setAppDetails(identity.taskbar)

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
    contents.on('did-navigate', () => lifecycle.reloaded(target))
    window.on('page-title-updated', () => lifecycle.renamed(target))
    window.on('focus', () => lifecycle.focusChanged(target, 'focus'))
    window.on('blur', () => lifecycle.focusChanged(target, 'blur'))
    if (!isHidden) window.once('ready-to-show', () => this.reveal(window))
    window.on('close', (event) => {
      if (window.isVisible()) records.saveWindowBounds(request, window.getNormalBounds())
      if (this.options.isQuitting() || !lifecycle.keepsRunning(target)) return
      event.preventDefault()
      window.hide()
    })
    window.on('closed', () => {
      if (this.windows.get(key) === window) this.windows.delete(key)
      this.targets.delete(contentsId)
      lifecycle.ended(target)
    })
    this.options.loadRenderer(window, appWindowSearch(request))
    lifecycle.opened(target)
    log.info('app_window_opened', { appId: request.appId, host: request.host, isHidden })
  }

  /** Shows the window and brings it in front of every other app's windows. */
  reveal(window: BrowserWindow): void {
    if (window.isMinimized()) window.restore()
    window.show()
    this.options.bringToFront(window)
    window.focus()
  }
}
