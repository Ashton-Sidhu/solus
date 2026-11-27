import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, shell, systemPreferences, Tray, type NativeImage } from 'electron'
import { existsSync } from 'fs'
import { z } from 'zod'
import { createLogger } from '@solus/server/logger'
import { appDesktopPermissionSchema, desktopUnavailable, parseAppDesktopCall, type AppDesktopResult } from '@solus/contracts/app-desktop'
import { isAppShortcutTarget, type AppShortcutTarget } from '@solus/contracts/app-shortcuts'
import type { DesktopPlatform, LoginItemInstall } from '@solus/desktop-main/platform/desktop-platform'
import { AppDesktop, requestedAppPermissions, systemMediaSettingsUrl, systemMediaStep, type AppWindowHandle } from './app-desktop'
import { permissionDetail, permissionQuestion } from './app-permission-text'
import type { AppShortcutRecords } from './app-shortcut-records'
import { AppWindows, type AppWindowLifecycle, type AppWindowsOptions } from './app-windows'
import { registerAppShortcutIpc, removeAppShortcut } from './ipc'
import type { AppWindowPermissionRequest } from '@solus/desktop-main/mac-permissions'
import type { AppLaunchers } from './launchers'

const log = createLogger('main', 'app-desktop')

const LOGIN_ITEMS_SETTINGS_URL = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'
/** Notifications kept so a click still reaches its handler: Electron drops one that nothing holds. */
const NOTIFICATIONS_KEPT = 20
const TRAY_ICON_SIZE = 16

/** Tells Solus that its login item started it, so the workspace stays hidden (Windows and Linux). */
export const SOLUS_LOGIN_ARGUMENT = '--solus-login'

interface AppDesktopElectronDeps {
  /** The app windows. A getter: the windows take the lifecycle that this returns. */
  windows(): AppWindows
  records: AppShortcutRecords
  launchers: AppLaunchers
  platform: DesktopPlatform
  loginItem: LoginItemInstall
  /** The icon of Solus in the tray, for an app with no icon file. */
  solusTrayIcon(): NativeImage
  /** The apps' badge counts changed: the badge of Solus is drawn again, where they add into it. */
  badgesChanged(): void
}

/** The desktop capabilities with their Electron parts, and the lifecycle the app windows report to. */
interface AppDesktopParts {
  desktop: AppDesktop
  lifecycle: AppWindowLifecycle
}

export interface AppWindowsRuntimeDeps extends Omit<AppDesktopElectronDeps, 'windows' | 'loginItem'>, Omit<AppWindowsOptions, 'records' | 'launchers' | 'lifecycle'> {
  /** This copy of Solus, for its login item. */
  install: Omit<LoginItemInstall, 'loginArgument'>
}

/** The app windows of this run, the desktop capabilities of their apps, and their IPC. */
export interface AppWindowsRuntime {
  windows: AppWindows
  desktop: AppDesktop
  /** For the session's permission handler: what a request of an app window's page gets. */
  permissionRequest: AppWindowPermissionRequest
  /** An app the person allowed to start at login opens with no window each time Solus starts. */
  openAppsThatStartAtLogin(): void
}

/** Where a removed launcher goes on this system (docs/app-shortcuts.md §4). */
function launcherGoesTo(): string {
  if (process.platform === 'darwin') return 'Its launcher goes to the Trash.'
  if (process.platform === 'win32') return 'Its launcher goes to the Recycle Bin.'
  return 'Its launcher is deleted from this computer.'
}

export function createAppWindowsRuntime(deps: AppWindowsRuntimeDeps): AppWindowsRuntime {
  const { records, launchers } = deps
  let windows: AppWindows | null = null
  const windowsOf = (): AppWindows => {
    if (!windows) throw new Error('The app windows are not ready yet.')
    return windows
  }
  const parts = createAppDesktop({ ...deps, windows: windowsOf, loginItem: { ...deps.install, loginArgument: SOLUS_LOGIN_ARGUMENT } })
  const created = new AppWindows({
    records,
    launchers,
    preloadPath: deps.preloadPath,
    loadRenderer: deps.loadRenderer,
    bringToFront: deps.bringToFront,
    isQuitting: deps.isQuitting,
    lifecycle: parts.lifecycle,
  })
  windows = created
  registerAppShortcutIpc({ records, launchers, windows: created })
  registerAppDesktopIpc(parts.desktop, created)
  return {
    windows: created,
    desktop: parts.desktop,
    permissionRequest: appWindowPermissionRequest(parts.desktop, created),
    openAppsThatStartAtLogin() {
      for (const { target, name } of parts.desktop.appsThatStartAtLogin()) created.open({ ...target, name }, { isHidden: true })
    },
  }
}

function createAppDesktop(deps: AppDesktopElectronDeps): AppDesktopParts {
  const { records, launchers, platform } = deps
  const isMac = platform.id === 'darwin'
  const notifications: Notification[] = []
  /** The macOS menu bar of Solus, while an app window's menu takes its place. */
  let solusMenu: Menu | null = null
  let isAppMenuShown = false
  const windowMenus = new Map<BrowserWindow, Menu>()

  function handleOf(target: AppShortcutTarget): AppWindowHandle | null {
    const windows = deps.windows()
    const window = windows.windowOf(target)
    if (!window) return null
    return {
      isVisible: () => window.isVisible(),
      isFocused: () => window.isFocused(),
      show: () => window.show(),
      hide: () => window.hide(),
      reveal: () => windows.reveal(window),
      setAlwaysOnTop: (isOn) => window.setAlwaysOnTop(isOn, 'floating'),
      reload: () => window.webContents.reload(),
      title: () => window.getTitle(),
      send: (event) => windows.send(target, event),
    }
  }

  function restoreSolusMenu(): void {
    if (!isAppMenuShown) return
    Menu.setApplicationMenu(solusMenu)
    isAppMenuShown = false
  }

  function showAppMenu(menu: Menu): void {
    if (!isAppMenuShown) solusMenu = Menu.getApplicationMenu()
    Menu.setApplicationMenu(menu)
    isAppMenuShown = true
  }

  function trayIcon(target: AppShortcutTarget): NativeImage {
    const iconPath = launchers.windowIdentity(target, '').iconPath
    if (iconPath && existsSync(iconPath)) return nativeImage.createFromPath(iconPath).resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE, quality: 'best' })
    // macOS shows the title alone; Windows and Linux need an image.
    return isMac ? nativeImage.createEmpty() : deps.solusTrayIcon()
  }

  function broadcast(channel: string): void {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(channel)
  }

  const desktop = new AppDesktop({
    os: platform.id,
    records,
    windowOf: handleOf,
    openWindow: (target, name, { isHidden }) => deps.windows().open({ ...target, name }, { isHidden }),
    closeWindow: (target) => deps.windows().close(target),
    async ask({ target, name, permission, isOnWindow }) {
      const window = isOnWindow ? deps.windows().windowOf(target) : null
      const options: Electron.MessageBoxOptions = {
        type: 'none',
        title: `${name} permission`,
        message: `${name} ${permissionQuestion(permission, platform.id)}`,
        detail: permissionDetail(permission),
        buttons: ['Allow', 'Don\'t Allow'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }
      const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
      log.info('app_permission_answered', { appId: target.appId, permission, isAllowed: response === 0 })
      return response === 0
    },
    async mediaAccess(permission) {
      // macOS and Windows have one switch for Solus as a whole; a refusal there is one for every app.
      if (platform.id === 'linux') return true
      const step = systemMediaStep(platform.id, systemPreferences.getMediaAccessStatus(permission))
      if (step === 'allowed') return true
      if (step === 'ask') return systemPreferences.askForMediaAccess(permission)
      const device = permission === 'microphone' ? 'Microphone' : 'Camera'
      const place = isMac ? 'System Settings > Privacy & Security' : 'Settings > Privacy & security'
      const { response } = await dialog.showMessageBox({
        type: 'none',
        message: `Turn on ${device} access for Solus.`,
        detail: `An app asked for the ${device.toLowerCase()}. In ${place} > ${device}, turn on access for Solus, then try again.`,
        buttons: [isMac ? 'Open System Settings' : 'Open Settings', 'Not Now'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (response === 0) await shell.openExternal(systemMediaSettingsUrl(platform.id, permission))
      return false
    },
    globalShortcuts: {
      isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator),
      register: (accelerator, onPress) => globalShortcut.register(accelerator, onPress),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    createTray(target, onOpen) {
      const tray = new Tray(trayIcon(target))
      // A Windows tray icon opens its menu on a right click only; a left click opens the app.
      if (platform.trayShowsOnClick) tray.on('click', onOpen)
      return {
        setTitle(text) {
          if (isMac) tray.setTitle(text)
          tray.setToolTip(text)
        },
        setMenu: (template) => tray.setContextMenu(Menu.buildFromTemplate(template)),
        destroy: () => tray.destroy(),
      }
    },
    notify({ title, body, onClick }) {
      if (!Notification.isSupported()) return
      const notification = new Notification({ title, body })
      notification.on('click', onClick)
      notifications.push(notification)
      if (notifications.length > NOTIFICATIONS_KEPT) notifications.shift()
      notification.show()
    },
    readClipboard: () => clipboard.readText(),
    async setOpenAtLogin(isOn) {
      const outcome = await platform.setOpenAtLogin(app, isOn, deps.loginItem)
      log.info('app_login_item_changed', { isOn, outcome })
      if (outcome !== 'requires-approval') return
      const { response } = await dialog.showMessageBox({
        type: 'none',
        message: 'Allow Solus to open at login',
        detail: 'An app you allowed to start at login needs Solus to open at login. Turn on Solus in System Settings → General → Login Items.',
        buttons: ['Open System Settings', 'Not Now'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (response === 0) await shell.openExternal(LOGIN_ITEMS_SETTINGS_URL)
    },
    personOpensAtLogin: () => isMac && app.getLoginItemSettings().openAtLogin,
    applyWindowMenu(target, template) {
      const window = deps.windows().windowOf(target)
      if (!window) return
      const menu = Menu.buildFromTemplate(template)
      if (!isMac) {
        window.setMenu(menu)
        return
      }
      windowMenus.set(window, menu)
      if (window.isFocused()) showAppMenu(menu)
    },
    async removeShortcut(target, name) {
      const window = deps.windows().windowOf(target)
      const options: Electron.MessageBoxOptions = {
        type: 'none',
        message: `Remove the ${name} shortcut?`,
        detail: `${launcherGoesTo()} The app stays on its host, and opens from Solus.`,
        buttons: ['Remove', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      }
      const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
      if (response !== 0) return
      const removal = await removeAppShortcut({ records, launchers }, target)
      broadcast('solus:app-shortcuts-changed')
      // The Trash refused the launcher: it stays and still opens the app, so the person learns where it is.
      if (removal.launcher === 'kept') {
        const notice: Electron.MessageBoxOptions = {
          type: 'none',
          message: `The ${name} shortcut is removed, but its launcher stays.`,
          detail: `Solus could not move it to the ${isMac ? 'Trash' : 'Recycle Bin'}. It is at ${removal.launcherPath}.`,
          buttons: ['OK'],
          noLink: true,
        }
        if (window) await dialog.showMessageBox(window, notice)
        else await dialog.showMessageBox(notice)
      }
    },
    badgeChanged(target, count) {
      if (!platform.appBadgesOnOwnWindow) {
        deps.badgesChanged()
        return
      }
      const window = deps.windows().windowOf(target)
      if (window) platform.setActivityBadge(app, window, count ?? 0, count ? `${window.getTitle()}: ${count}` : '')
    },
    grantsChanged: () => broadcast('solus:app-permissions-changed'),
  })

  // macOS: the menu bar is the focused window's. Another window of Solus gets the Solus menu back.
  if (isMac) {
    app.on('browser-window-focus', (_event, window) => {
      if (deps.windows().targetOf(window.webContents)) {
        const menu = windowMenus.get(window)
        if (menu) showAppMenu(menu)
      } else {
        restoreSolusMenu()
      }
    })
  }

  const lifecycle: AppWindowLifecycle = {
    opened: (target) => desktop.opened(target),
    reloaded: (target) => desktop.reloaded(target),
    renamed: (target) => desktop.renamed(target),
    focusChanged: (target, type) => desktop.focusChanged(target, type),
    keepsRunning: (target) => desktop.keepsRunning(target),
    ended(target) {
      desktop.ended(target)
      for (const window of windowMenus.keys()) if (window.isDestroyed()) windowMenus.delete(window)
      if (isMac && !BrowserWindow.getFocusedWindow()) restoreSolusMenu()
    },
  }
  return { desktop, lifecycle }
}

const callSchema = z.object({ operation: z.string().max(100), args: z.json() })
const targetSchema = z.object({ host: z.string(), appId: z.string() }).refine(isAppShortcutTarget)
const changeSchema = z.object({
  host: z.string(),
  appId: z.string(),
  permission: appDesktopPermissionSchema,
  state: z.enum(['granted', 'denied', 'prompt']),
}).refine(isAppShortcutTarget)

/**
 * The calls of the desktop capabilities. `solus:app-desktop-call` comes only
 * from the Solus page of an app window, which relays its app's page; the app
 * is the one of the sender's window, never one the call names. Settings reads
 * and changes the grants of every app.
 */
function registerAppDesktopIpc(desktop: AppDesktop, windows: AppWindows): void {
  ipcMain.handle('solus:app-desktop-call', (event, operation, args): Promise<AppDesktopResult> | AppDesktopResult => {
    const target = windows.targetOf(event.sender)
    if (!target) return { ok: false, failure: desktopUnavailable() }
    const raw = callSchema.safeParse({ operation, args })
    if (!raw.success) return { ok: false, failure: { code: 'DesktopInvalidInput', message: 'The call is not a desktop call.' } }
    const parsed = parseAppDesktopCall(raw.data.operation, raw.data.args)
    return parsed.ok ? desktop.call(target, parsed.call) : parsed
  })
  ipcMain.handle('solus:app-permissions', () => desktop.list())
  ipcMain.handle('solus:app-permission-set', (_event, rawChange) => desktop.change(changeSchema.parse(rawChange)))
  ipcMain.handle('solus:app-permissions-forget', (_event, rawTarget) => desktop.forget(targetSchema.parse(rawTarget)))
}

/**
 * What a permission request of an app window's page gets: its grants, asked
 * for when needed. Null leaves the request to the handler of Solus's own
 * pages. The app's page gets no other permission; the Solus page of the
 * window keeps what Solus's pages get.
 */
function appWindowPermissionRequest(desktop: AppDesktop, windows: AppWindows): AppWindowPermissionRequest {
  return (contents, permission, details) => {
    const target = windows.targetOf(contents)
    if (!target) return null
    const permissions = requestedAppPermissions(permission, details.mediaTypes)
    if (permissions === null) return details.isMainFrame ? null : Promise.resolve(false)
    return desktop.allows(target, permissions)
  }
}
