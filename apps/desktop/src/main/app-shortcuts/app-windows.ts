import { BrowserWindow, nativeTheme, screen, shell, type Rectangle, type WebContents } from 'electron'
import { createLogger } from '@solus/server/logger'
import type { AppDesktopEvent } from '@solus/contracts/app-desktop'
import type { AppMenuBarPage } from '@solus/contracts/apps'
import { appWindowSearch, type AppShortcutTarget, type AppWindowRequest } from '@solus/contracts/app-shortcuts'
import type { AppShortcutRecords } from './app-shortcut-records'
import { appShortcutId } from './launcher-files'
import type { AppLaunchers } from './launchers'
import { popoverPosition, restoredWindowBounds } from './window-bounds'

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
  /** The popover of each app's menu-bar page, kept hidden between clicks so it opens at once. */
  private readonly popovers = new Map<string, BrowserWindow>()

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

  /** Whether `contents` is the page of a popover, not of an app window. */
  isPopover(contents: WebContents): boolean {
    return [...this.popovers.values()].some((popover) => !popover.isDestroyed() && popover.webContents.id === contents.id)
  }

  /**
   * Shows the popover of the app's menu-bar page under its item, or hides the
   * one that shows (Executor's `togglePopover`). It closes when it loses the
   * focus, as a menu does. `anchor` is the item's place; null where the
   * system gives none (Linux), and the pointer is the place then.
   */
  togglePopover(request: AppWindowRequest, page: AppMenuBarPage, anchor: Rectangle | null): void {
    const key = appShortcutId(request)
    const existing = this.popovers.get(key)
    if (existing && !existing.isDestroyed() && existing.isVisible()) {
      existing.hide()
      return
    }
    const popover = existing && !existing.isDestroyed() ? existing : this.createPopover(request)
    popover.setResizable(true)
    popover.setSize(page.width, page.height)
    popover.setResizable(false)
    const place = anchor && anchor.width > 0 ? anchor : { ...screen.getCursorScreenPoint(), width: 0 as const, height: 0 as const }
    const { workArea } = screen.getDisplayNearestPoint({ x: place.x, y: place.y })
    const { x, y } = popoverPosition(page, place, workArea)
    popover.setPosition(x, y)
    popover.show()
    popover.focus()
  }

  closePopover(target: AppShortcutTarget): void {
    const key = appShortcutId(target)
    const popover = this.popovers.get(key)
    this.popovers.delete(key)
    if (popover && !popover.isDestroyed()) popover.destroy()
  }

  private createPopover(request: AppWindowRequest): BrowserWindow {
    const key = appShortcutId(request)
    const target: AppShortcutTarget = { host: request.host, appId: request.appId }
    const popover = new BrowserWindow({
      width: 320,
      height: 400,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: request.name || 'Solus',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#21201d' : '#fbfaf6',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    this.popovers.set(key, popover)
    const contentsId = popover.webContents.id
    this.targets.set(contentsId, target)
    this.guardNavigation(popover.webContents)
    popover.webContents.on('render-process-gone', (_event, details) => {
      log.error('app_popover_renderer_gone', { appId: request.appId, reason: details.reason })
      this.closePopover(target)
    })
    popover.on('blur', () => {
      if (!popover.isDestroyed()) popover.hide()
    })
    popover.on('closed', () => {
      if (this.popovers.get(key) === popover) this.popovers.delete(key)
      this.targets.delete(contentsId)
    })
    this.options.loadRenderer(popover, appWindowSearch({ ...request, page: 'menubar' }))
    log.info('app_popover_opened', { appId: request.appId, host: request.host })
    return popover
  }

  /** The page is the Solus renderer; a link in it must not replace it. A web link opens in the browser. */
  private guardNavigation(contents: WebContents): void {
    contents.on('will-navigate', (event) => {
      if (event.url.startsWith(new URL(contents.getURL()).origin)) return
      event.preventDefault()
      if (/^https?:\/\//i.test(event.url)) void shell.openExternal(event.url)
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
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
      // A shortcut link for an app whose window is open asks in that window.
      if (request.offer) existing.webContents.send('solus:app-shortcut-offer', request.offer)
      if (!isHidden || request.offer) this.reveal(existing)
      return
    }
    const { records, lifecycle } = this.options
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
    this.applyIdentity(window, request, request.name)

    const contents = window.webContents
    contents.on('render-process-gone', (_event, details) => {
      log.error('app_window_renderer_gone', { appId: request.appId, reason: details.reason, exitCode: details.exitCode })
    })
    this.guardNavigation(contents)
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
      this.closePopover(request)
      lifecycle.ended(target)
    })
    this.options.loadRenderer(window, appWindowSearch(request))
    lifecycle.opened(target)
    log.info('app_window_opened', { appId: request.appId, host: request.host, isHidden })
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

  /** Shows the window and brings it in front of every other app's windows. */
  reveal(window: BrowserWindow): void {
    if (window.isMinimized()) window.restore()
    window.show()
    this.options.bringToFront(window)
    window.focus()
  }
}
