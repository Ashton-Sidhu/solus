import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, shell, systemPreferences, Tray, webContents, type NativeImage } from 'electron'
import { existsSync } from 'fs'
import { release } from 'os'
import { z } from 'zod'
import { createLogger } from '@solus/server/logger'
import { appDesktopPermissionSchema, desktopUnavailable, parseAppDesktopCall, type AppDesktopResult } from '@solus/contracts/app-desktop'
import { isAppShortcutTarget, type AppShortcutTarget } from '@solus/contracts/app-shortcuts'
import type { DesktopPlatform, LoginItemInstall } from '@solus/desktop-main/platform/desktop-platform'
import { AppDesktop, isNativeWayland, requestedAppPermissions, systemAudioSupported, systemMediaSettingsUrl, systemMediaStep, type AppWindowHandle } from './app-desktop'
import { permissionDetail, permissionQuestion } from './app-permission-text'
import type { AppShortcutRecords } from './app-shortcut-records'
import { AppWindows, type AppWindowLifecycle, type AppWindowsOptions } from './app-windows'
import { appShortcutId } from './launcher-files'
import { forgetApp, registerAppShortcutIpc, removeAppShortcut } from './ipc'
import type { AppWindowPermissionRequest } from '@solus/desktop-main/mac-permissions'
import type { AppLaunchers } from './launchers'

const log = createLogger('main', 'app-desktop')

const LOGIN_ITEMS_SETTINGS_URL = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'
const SCREEN_RECORDING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
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
  setAppIcon(target: AppShortcutTarget, png: Buffer): void
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
  /** For the session's display-media handler: an app page's `getDisplayMedia` gets the system's audio, or nothing. */
  displayMediaRequest(request: Electron.DisplayMediaRequestHandlerHandlerRequest, callback: (streams: Electron.Streams) => void): void
  /** An app the person allowed to start at login opens with no window each time Solus starts. */
  openAppsThatStartAtLogin(): void
}

/** Tells every window of Solus that a list it shows changed. */
function broadcastToWindows(channel: string): void {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(channel)
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
  registerAppDesktopIpc(parts, created)
  ipcMain.handle('solus:app-forget', (_event, rawTarget) => forgetApp({
    records,
    launchers,
    forgetAnswers: (target) => parts.desktop.forget(target),
    shortcutsChanged: () => broadcastToWindows('solus:app-shortcuts-changed'),
  }, targetSchema.parse(rawTarget)))
  return {
    windows: created,
    desktop: parts.desktop,
    permissionRequest: appWindowPermissionRequest(parts.desktop, created),
    displayMediaRequest: appDisplayMediaRequest(parts.desktop, created),
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

  /** The trays of the apps, for the place of their popovers. */
  const trays = new Map<string, Tray>()
  /** Each open app's own icon, from its window's page; its tray shows it on every system. */
  const appIcons = new Map<string, NativeImage>()

  function trayIcon(target: AppShortcutTarget): NativeImage {
    const own = appIcons.get(appShortcutId(target))
    if (own) return own.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE, quality: 'best' })
    const iconPath = launchers.windowIdentity(target, '').iconPath
    if (iconPath && existsSync(iconPath)) return nativeImage.createFromPath(iconPath).resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE, quality: 'best' })
    // macOS shows the title alone; Windows and Linux need an image.
    return isMac ? nativeImage.createEmpty() : deps.solusTrayIcon()
  }

  const broadcast = broadcastToWindows

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
    systemAudioSupported: systemAudioSupported(platform.id, Number(release().split('.')[0])),
    floatingSupported: !isNativeWayland(platform.id, process.env, app.commandLine.getSwitchValue('ozone-platform')),
    async systemAudioAccess() {
      if (!isMac || systemPreferences.getMediaAccessStatus('screen') === 'granted') return true
      // macOS lists Solus under Screen & System Audio Recording only after it asked once.
      const { response } = await dialog.showMessageBox({
        type: 'none',
        message: 'Allow Solus to record system audio.',
        detail: 'An app asked for the audio that this computer plays. Turn on Solus in System Settings > Privacy & Security > Screen & System Audio Recording, then quit and reopen Solus, and try again.',
        buttons: ['Open System Settings', 'Not Now'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (response === 0) {
        await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => [])
        await shell.openExternal(SCREEN_RECORDING_SETTINGS_URL)
      }
      return false
    },
    globalShortcuts: {
      isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator),
      register: (accelerator, onPress) => globalShortcut.register(accelerator, onPress),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    createTray(target, onClick) {
      const key = appShortcutId(target)
      const tray = new Tray(trayIcon(target))
      trays.set(key, tray)
      let menu: Menu | null = null
      let hasPopover = false
      // A click opens the menu-bar page where there is one. With none, a Windows click opens the app, and
      // macOS and Linux show the menu. A Linux tray icon (StatusNotifierItem) often gives no click at all:
      // its menu then has the page's item (`appTrayMenuTemplate`).
      tray.on('click', () => {
        if (hasPopover || platform.trayShowsOnClick) onClick()
      })
      // macOS: with a popover, the menu is on a right click (Executor's `showTray`).
      tray.on('right-click', () => {
        if (isMac && hasPopover && menu) tray.popUpContextMenu(menu)
      })
      return {
        setTitle(text) {
          if (isMac) tray.setTitle(text)
          tray.setToolTip(text)
        },
        setMenu(template, isPopover) {
          menu = Menu.buildFromTemplate(template)
          hasPopover = isPopover
          tray.setContextMenu(isMac && isPopover ? null : menu)
        },
        destroy() {
          if (trays.get(key) === tray) trays.delete(key)
          tray.destroy()
        },
      }
    },
    togglePopover(target, name, page) {
      const tray = trays.get(appShortcutId(target))
      deps.windows().togglePopover({ ...target, name }, page, tray && !tray.isDestroyed() ? tray.getBounds() : null)
    },
    closePopover: (target) => deps.windows().closePopover(target),
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
      appIcons.delete(appShortcutId(target))
      for (const window of windowMenus.keys()) if (window.isDestroyed()) windowMenus.delete(window)
      if (isMac && !BrowserWindow.getFocusedWindow()) restoreSolusMenu()
    },
  }
  /** The page of an app window sent the app's icon: an item it shows now takes it. */
  function setAppIcon(target: AppShortcutTarget, png: Buffer): void {
    const image = nativeImage.createFromBuffer(png)
    if (image.isEmpty()) return
    appIcons.set(appShortcutId(target), image)
    trays.get(appShortcutId(target))?.setImage(trayIcon(target))
  }

  return { desktop, lifecycle, setAppIcon }
}

const menuBarPageSchema = z.object({ width: z.number().int().min(200).max(640), height: z.number().int().min(120).max(720) }).nullable()
/** A PNG of the app's icon, as the page draws it: at most 2 MiB. */
const iconSchema = z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= 2 * 1024 * 1024)
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
function registerAppDesktopIpc({ desktop, setAppIcon }: AppDesktopParts, windows: AppWindows): void {
  // From the Solus page of an app window, never from a popover: what its app's active version has.
  ipcMain.on('solus:app-menu-bar-page', (event, rawPage) => {
    const target = windows.targetOf(event.sender)
    const page = menuBarPageSchema.safeParse(rawPage)
    if (!target || windows.isPopover(event.sender) || !page.success) return
    void desktop.menuBarPageChanged(target, page.data)
  })
  ipcMain.on('solus:app-window-icon', (event, rawPng) => {
    const target = windows.targetOf(event.sender)
    const png = iconSchema.safeParse(rawPng)
    if (!target || windows.isPopover(event.sender) || !png.success) return
    setAppIcon(target, Buffer.from(png.data))
  })
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
}

/**
 * What a `getDisplayMedia` of a page gets (Executor's `displayMediaRequest`).
 * Only an app's frame in its app window or popover, with the `systemAudio`
 * grant, gets the system's audio: with its own frame as the video, which the
 * page drops. Any other page, and Solus's own pages, get nothing: no screen
 * of this computer goes to a page through this handler.
 */
function appDisplayMediaRequest(desktop: AppDesktop, windows: AppWindows): AppWindowsRuntime['displayMediaRequest'] {
  return (request, callback) => {
    const frame = request.frame
    const contents = frame ? webContents.fromFrame(frame) : undefined
    const target = contents ? windows.targetOf(contents) : null
    const isAppFrame = frame !== null && frame.parent !== null
    if (!frame || !target || !isAppFrame || !request.audioRequested || !desktop.allowsSystemAudio(target)
      || (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted')) {
      log.info('app_system_audio_refused', { appId: target?.appId ?? null })
      callback({})
      return
    }
    log.info('app_system_audio_given', { appId: target.appId, host: target.host })
    callback({ video: frame, audio: 'loopback' })
  }
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
