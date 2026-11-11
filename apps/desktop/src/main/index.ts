import { DesktopActivityBadges } from './activity-badges'
import { attachContextMenu } from './context-menu'
import { initialWindowBounds } from './window-platform'
import { HtmlFullscreen } from './html-fullscreen'
import { secureStorage } from './secure-storage'
import { desktopPlatform } from './platform/desktop-platform'

import { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, nativeTheme, safeStorage, shell, powerSaveBlocker, protocol } from 'electron'
import { join } from 'path'
import { readFileSync, statSync, writeFileSync } from 'fs'
import { importLoginShellEnv, warmCliPath } from '@solus/server/cli-env'
import { createLogger, flushLogs } from '@solus/server/logger'
import type { AppGlobalShortcuts, AppShortcutCombo } from '@solus/contracts/types'
import { clampZoomFactor } from '@solus/contracts/zoom'
import { comboToAccelerator } from '@solus/workspace-ui/lib/keybindings/match'
import { registerUpdateIpc } from '@solus/desktop-main/updates/ipc'
import type { BootCore } from '@solus/server/boot-core'
import { clientNotificationRequestSchema, showDesktopNotification } from '@solus/desktop-main/desktop-notifications'
import type { WindowDeps } from '@solus/server/transport/handlers/window-handlers'
import type { FileDeps } from '@solus/desktop-main/server/handlers/file-handlers'
import { mintPairUrl } from '@solus/desktop-main/pair-url'
import { destroyAllFinders } from '@solus/server/files/file-finder'
import { registerBrowserHeadlessHost } from './browser/headless-window'
import { registerBrowserRecordingEncoderHost } from './browser/recording-encoder-window'
import { registerBrowserWebviewHost } from './browser/webview-driver'
import { forwardGuestShortcuts, preserveApplicationReloadShortcut } from './browser/guest-shortcuts'
import { guardBrowserPartition } from './browser/guard-browser-partition'
import type { GuestShortcut } from '@solus/contracts/host-api'
import { getInstallationId, issueSessionToken, refreshSessionToken, verifySessionToken } from '@solus/server/admission/auth'
import { closeDb } from '@solus/server/db'
import { closeDatabase } from '@solus/server/db/database'
import { createShutdownCoordinator } from '@solus/desktop-main/shutdown-coordinator'
import { watchLauncher } from '@solus/desktop-main/launcher-watch'
import { handleLocalVideoRequest } from '@solus/desktop-main/local-video-protocol'
import { LOCAL_DEVICE_LABEL } from '@solus/server/transport/server'
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@solus/contracts/rpc'
import { shareDialogLogSchema } from '@solus/contracts/sharing'
import { consumeClientAttachmentRead } from '@solus/desktop-main/client-attachment-read'
import { configurePlatformServices } from '@solus/server/platform/services'
import { registerAccountIpc } from '@solus/desktop-main/account/ipc'
import type { AccountSession } from '@solus/desktop-main/account/account-session'
import { presentAccountToLocalHost } from '@solus/desktop-main/account/local-host-client'
import { LocalOwnerToken } from '@solus/desktop-main/local-owner-token'
import { desktopServerPort } from '@solus/desktop-main/server-port'
import { readLocalHostEnabled, writeLocalHostEnabled } from '@solus/desktop-main/local-host-setting'
import { ensureScreenCaptureAccess, handleMicrophoneRequests } from '@solus/desktop-main/mac-permissions'
import { markStartup, traceRendererMarks } from '@solus/desktop-main/startup-trace'
import { z } from 'zod'

// Every static import above has now evaluated, so this is the main bundle's
// module-graph cost — the first item on the startup critical path.
markStartup('main.evaluated')

const isHeadless = process.argv.includes('--headless')
const skipOnboarding = process.argv.includes('--skip-onboarding') || process.env.SOLUS_SKIP_ONBOARDING === '1'
const isPairUrl = process.argv.includes('pair-url')
const isDevMode = Boolean(process.env.ELECTRON_RENDERER_URL)

desktopPlatform.prepare(app)
// A second launch would boot a second server against the same data folder.
if (desktopPlatform.singleInstance && !isHeadless && !isPairUrl && process.env.SOLUS_TEST_MODE !== '1') {
  if (!app.requestSingleInstanceLock()) app.exit(0)
  app.on('second-instance', () => {
    hiddenUntilTrayShow = false
    if (app.isReady()) showMainWindow()
    else app.once('ready', () => showMainWindow())
  })
}

const log = createLogger('main', 'index.ts')
const bootStartedAt = Date.now()

// A headless app exists to be a host, so only the windowed app reads the setting.
const localHostSettingPath = join(app.getPath('userData'), 'local-host.json')
const isLocalHostEnabled = isHeadless || isPairUrl || readLocalHostEnabled(localHostSettingPath)

configurePlatformServices({
  appInfo: {
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    logsPath: app.getPath('logs'),
    userDataPath: app.getPath('userData'),
    version: app.getVersion(),
  },
  openExternal: (url) => shell.openExternal(url),
  trashItem: (path) => shell.trashItem(path),
  safeStorage: secureStorage(safeStorage),
})

// Privileged custom scheme the renderer fetches a video on this computer
// through, to upload it to a remote host. Must be registered before app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'solus-local-video', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

let forceQuit = false

let mainWindow: BrowserWindow | null = null
/** Whether the app, not the user, made the main window fullscreen. */
let mainWindowHtmlFullscreen = new HtmlFullscreen()
let powerSaveBlockerId: number | null = null

// Hold the app-suspension blocker only while an agent turn is active. Holding
// it for the app's lifetime disables macOS App Nap entirely, which keeps the
// machine warm at idle.
function syncPowerSaveBlocker(): void {
  if (isHeadless || isTestMode || !core) return
  const shouldBlock = core.sessionRuntime.statuses.hasActiveWork()
  const isBlocking = powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)
  if (shouldBlock === isBlocking) return
  if (shouldBlock) {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    log.info('power_save_blocker_started', { blockerId: powerSaveBlockerId })
  } else if (powerSaveBlockerId !== null) {
    powerSaveBlocker.stop(powerSaveBlockerId)
    log.info('power_save_blocker_stopped', { blockerId: powerSaveBlockerId })
    powerSaveBlockerId = null
  }
}

let tray: Tray | null = null
/** The version of a downloaded update, while one waits for a restart. */
let readyUpdateVersion: string | null = null
let screenshotCounter = 0
let pasteCounter = 0
let core: BootCore | null = null
// Resolves with the booted core once bootCore finishes, or with null when the
// local host is off; rejects if boot fails.
// The renderer's first IPC (getLocalConnection) awaits this instead of racing
// window creation against server boot — the window is now created before boot
// so its bundle loads in parallel, and the connection resolves when ready.
let resolveBoot!: (core: BootCore | null) => void
let rejectBoot!: (error: Error) => void
const bootPromise = new Promise<BootCore | null>((resolve, reject) => {
  resolveBoot = resolve
  rejectBoot = reject
})
// The tab whose conversation owns the renderer's current text selection. Pushed
// on selectionchange so native context-menu actions keep their exact source.
let quoteContextTabId: string | null = null
/** The Solus shortcuts a focused browser page gives up; the renderer names them. */
let guestShortcuts: GuestShortcut[] = []
let hiddenUntilTrayShow = false
let sessionIndexerStartTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Analytics is a quit-path concern in this process: one event on the way out,
 * and the flush that follows it. A static import loaded posthog-node before the
 * window existed — the last heavy dependency in this file that did.
 */
let analytics: Promise<typeof import('@solus/server/analytics')> | null = null

function captureQuitEvent(uptimeMs: number): void {
  analytics ??= import('@solus/server/analytics')
  void analytics
    .then((m) => m.captureServerEvent('app_quit', { uptime_ms: uptimeMs }))
    .catch((err: Error) => log.warn('analytics_load_failed', { error: err.message }))
}

const shutdownCoordinator = createShutdownCoordinator({
  shutdown: async () => {
    forceQuit = true
    // Only flush a client that a capture actually created. Loading the module
    // here to shut it down would be the import this file just stopped making.
    const flushAnalytics = analytics?.then((m) => m.shutdownAnalytics()) ?? Promise.resolve()
    // Same reasoning, one module over: importing otel for its quit path pulled
    // the tracer, its context manager and the resource detector in ahead of the
    // window. By the time anything needs shutting down, boot has loaded it.
    const stopOtel = core ? import('@solus/server/otel').then((m) => m.shutdownOtel()) : undefined
    await Promise.all([core?.shutdown(), flushAnalytics, stopOtel])
  },
  quit: () => app.quit(),
  forceQuit: () => app.exit(0),
  onError: (error) => log.error('shutdown_failed', { error: error instanceof Error ? error.message : String(error) }),
})

// Electron handles SIGINT, SIGTERM and SIGHUP itself and turns them into
// app.quit(), so a `process.on` signal listener never runs in this process.
// Those signals reach before-quit below like any other quit request. A dead
// launcher sends no signal at all: `kill <pid>` on electron-vite leaves this
// process orphaned, so the dev app watches for that and quits the same way.
if (isDevMode) {
  watchLauncher({
    launcherPid: process.ppid,
    readParentPid: () => process.ppid,
    onLauncherGone: () => {
      log.info('dev_launcher_gone')
      app.quit()
    },
  })
}

const LOCAL_CONNECTION_CHANNEL = 'solus:local-connection'

// ─── OS summon shortcut (Alt+Space on macOS, Alt+Shift+Space elsewhere) ───
//
// Editable per-device. Main is the single source of truth (kept out of the
// renderer's settings.keybindings) so they apply before the renderer loads and
// can be re-registered live. Persisted as plain JSON in userData.

const DEFAULT_APP_SHORTCUTS: AppGlobalShortcuts = {
  toggle: desktopPlatform.keys.summonCombo,
}

let currentAppShortcuts: AppGlobalShortcuts = DEFAULT_APP_SHORTCUTS

function appShortcutsPath(): string {
  return join(app.getPath('userData'), 'app-shortcuts.json')
}

const appShortcutComboSchema = z.object({
  code: z.string(),
  alt: z.boolean().optional(),
  mod: z.boolean().optional(),
  shift: z.boolean().optional(),
  ctrl: z.boolean().optional(),
  meta: z.boolean().optional(),
})

const appGlobalShortcutsSchema = z.object({
  toggle: appShortcutComboSchema,
})

function loadAppShortcuts(): AppGlobalShortcuts {
  try {
    const raw = readFileSync(appShortcutsPath(), 'utf-8')
    const parsed = appGlobalShortcutsSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
  } catch {}
  return DEFAULT_APP_SHORTCUTS
}

function saveAppShortcuts(shortcuts: AppGlobalShortcuts): void {
  try {
    writeFileSync(appShortcutsPath(), JSON.stringify(shortcuts, null, 2), { mode: 0o600 })
  } catch (err: any) {
    log.warn('app_shortcuts_persist_failed', { error: String(err?.message ?? err) })
  }
}

/**
 * Unregister the previous summon accelerators and register the new ones.
 * Returns the accelerators that failed to register (caller offers a restart).
 * Only the summon accelerator is touched — no other globalShortcut state.
 */
interface AppliedAppGlobalShortcuts {
  failed: string[]
}

function applyAppGlobalShortcuts(shortcuts: AppGlobalShortcuts): AppliedAppGlobalShortcuts {
  const prevAccels = [comboToAccelerator(currentAppShortcuts.toggle, desktopPlatform.keys)]
  for (const accel of prevAccels) {
    if (accel && globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel)
  }

  const failed: string[] = []
  const bindings: Array<[AppShortcutCombo, (accel: string) => void]> = [
    [shortcuts.toggle, () => toggleMainWindow()],
  ]
  for (const [combo, handler] of bindings) {
    const accel = comboToAccelerator(combo, desktopPlatform.keys)
    if (!accel) { failed.push(combo.code); continue }
    try {
      const ok = globalShortcut.register(accel, () => handler(accel))
      if (!ok) {
        log.warn('global_shortcut_registration_failed', { accelerator: accel })
        failed.push(accel)
      }
    } catch (err: any) {
      log.warn('global_shortcut_registration_threw', { accelerator: accel, error: String(err?.message ?? err) })
      failed.push(accel)
    }
  }

  currentAppShortcuts = shortcuts
  return { failed }
}

const isTestMode = process.env.SOLUS_TEST_MODE === '1'

// ─── Window geometry ───

function isLive(win: BrowserWindow | null): win is BrowserWindow {
  return !!win && !win.isDestroyed()
}

function sendNativeEvent(channel: string, ...payload: unknown[]): void {
  if (isLive(mainWindow)) mainWindow.webContents.send(channel, ...payload)
}

/** Rebuilt whenever a downloaded update starts or stops waiting for a restart. */
function buildTrayMenu(restartToUpdate: () => void): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'Show Solus', click: () => showMainWindow({ fromTrayShow: true }) },
  ]
  if (isDevMode) {
    template.push({ label: 'Hide Solus Until Shown', click: hideUntilTrayShow })
  }
  if (readyUpdateVersion) {
    template.push({ type: 'separator' })
    template.push({ label: `Restart to update Solus ${readyUpdateVersion}`, click: restartToUpdate })
  }
  template.push({ label: 'Quit', click: () => { app.quit() } })
  return Menu.buildFromTemplate(template)
}

/** The tray icon, kept for the app's lifetime. */
function createTray(menu: Menu): Tray {
  const created = new Tray(desktopPlatform.trayIcon(app.getAppPath()))
  if (desktopPlatform.trayShowsOnClick) created.on('click', () => showMainWindow({ fromTrayShow: true }))
  created.setToolTip('Solus')
  created.setContextMenu(menu)
  return created
}

function setActivityBadge(count: number): void {
  desktopPlatform.setActivityBadge(app, workspaceWindow(), count)
}

/** The live workspace window, when the desktop client has one. */
function workspaceWindow(): BrowserWindow | null {
  return isLive(mainWindow) ? mainWindow : null
}

function isAppVisible(): boolean {
  return isLive(mainWindow) && mainWindow.isVisible()
}

function focusMainWindow(): void {
  if (!isLive(mainWindow)) return
  desktopPlatform.bringToFront(app, mainWindow)
  mainWindow.focus()
  mainWindow.webContents.focus()
  sendNativeEvent('solus:window-shown')
}

// ─── Window Creation ───

function loadRenderer(win: BrowserWindow): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    if (skipOnboarding) {
      const url = new URL(process.env.ELECTRON_RENDERER_URL)
      url.searchParams.set('skip-onboarding', '')
      win.loadURL(url.toString())
    } else {
      win.loadURL(process.env.ELECTRON_RENDERER_URL)
    }
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), skipOnboarding
      ? { query: { 'skip-onboarding': '' } }
      : undefined)
  }
}

/** Create the standard desktop window. Closing it hides it so reopening is
 * instant; a fresh launch starts at the default bounds. */
function createMainWindow(): BrowserWindow {
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    ...initialWindowBounds(screen),
    minWidth: 640,
    minHeight: 480,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#21201d' : '#fbfaf6',
    show: false,
    icon: join(app.getAppPath(), 'resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The browser pane's native surface. `webviewTag` widens a window's
      // attack surface, so it is enabled only in this desktop window.
      // `WebContentsView` is Electron's preferred replacement but composites
      // above the DOM, which would put every modal, palette, and toast behind
      // the guest; `<webview>` stays in the page's own z-order.
      webviewTag: true,
      // A browser page that asks for fullscreen fills its pane's surface. Without
      // this, Electron also puts the whole Solus window into OS fullscreen. The
      // app's own fullscreen elements reach OS fullscreen through
      // `solus:html-fullscreen`.
      disableHtmlFullscreenWindowResize: true,
    },
    ...desktopPlatform.windowOptions,
  }
  mainWindow = new BrowserWindow(windowOptions)
  const mainContents = mainWindow.webContents
  mainContents.once('dom-ready', () => markStartup('renderer.domReady'))
  mainContents.once('did-finish-load', () => markStartup('renderer.didFinishLoad'))
  // A renderer that dies or hangs leaves nothing in its own console, so the
  // reason is written here, where it survives the restart.
  mainContents.on('render-process-gone', (_event, details) => {
    log.error('renderer_process_gone', { reason: details.reason, exitCode: details.exitCode })
  })
  // The history swipe reads these as the fingers touching and lifting.
  mainContents.on('input-event', (_event, input) => {
    if (input.type === 'gestureScrollBegin') sendNativeEvent('solus:trackpad-scroll', 'begin')
    else if (input.type === 'gestureScrollEnd') sendNativeEvent('solus:trackpad-scroll', 'end')
  })
  mainWindow.on('unresponsive', () => log.warn('renderer_unresponsive'))
  mainWindow.on('responsive', () => log.info('renderer_responsive'))

  const reloadMain = (): void => {
    if (mainContents.isDestroyed()) return
    log.info('application_reload_shortcut')
    mainContents.reload()
  }

  // Do not depend on Electron's default application menu for a development
  // reload. It is not present in every menu shape.
  preserveApplicationReloadShortcut(mainContents, reloadMain)

  // A link clicked in page content would otherwise load in this window and
  // replace the workspace with a blank page.
  mainContents.on('will-navigate', (event) => {
    if (event.url.startsWith(new URL(mainContents.getURL()).origin)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(event.url)) void shell.openExternal(event.url)
  })

  // A browser guest is untrusted page content: it renders whatever the dev
  // server serves. Strip any preload or Node access the tag asked for, whatever
  // the renderer wrote on the element.
  mainContents.on('will-attach-webview', (_event, webPreferences, params) => {
    guardBrowserPartition(params.partition)
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.disableHtmlFullscreenWindowResize = true
  })
  mainContents.on('did-attach-webview', (_event, browserContents) => {
    // Electron applies menu shortcuts to the focused WebContents. A browser
    // guest therefore steals Cmd/Ctrl+R from the workspace while it has focus.
    preserveApplicationReloadShortcut(browserContents, reloadMain)
    // For the same reason, the renderer's keybinding listener never sees a key
    // pressed in the guest.
    forwardGuestShortcuts(browserContents, () => guestShortcuts, (shortcut) => {
      sendNativeEvent('solus:guest-shortcut', shortcut)
    })
  })

  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('hide', () => {
    sendNativeEvent('solus:window-hidden')
  })
  const htmlFullscreen = new HtmlFullscreen()
  mainWindowHtmlFullscreen = htmlFullscreen
  // On macOS the window reports fullscreen until its exit animation ends.
  mainWindow.on('leave-full-screen', () => htmlFullscreen.windowLeftFullScreen())

  attachContextMenu(mainWindow, () => quoteContextTabId)

  mainWindow.once('ready-to-show', () => {
    if (!isTestMode && process.env.ELECTRON_RENDERER_URL) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  loadRenderer(mainWindow)
  armBootShellDeadline()
  return mainWindow
}

/**
 * A launch that mounts promptly shows its first real app frame and the static
 * boot shell is never surfaced — that is the intent, and it still holds.
 *
 * A launch that does not get there used to leave the user with a bouncing dock
 * icon and no window at all: a cold start on this hardware takes over four
 * seconds to mount. Past this deadline the branded shell is better than
 * nothing, so the window comes up and the app fills it in when it is ready.
 *
 * Measured from window creation because that is when the renderer starts
 * loading. The value sits above a warm relaunch (~1.2 s to first frame here)
 * and below a cold start (~4.3 s), so the shell appears on the launches that
 * are actually slow and on no others.
 */
const BOOT_SHELL_DEADLINE_MS = 2_000
let bootShellDeadline: ReturnType<typeof setTimeout> | null = null

function armBootShellDeadline(): void {
  if (isTestMode) return
  clearBootShellDeadline()
  bootShellDeadline = setTimeout(() => {
    bootShellDeadline = null
    if (!isLive(mainWindow) || mainWindow.isVisible()) return
    log.info('boot_shell_deadline_reached', { deadlineMs: BOOT_SHELL_DEADLINE_MS })
    markStartup('window.shownOnDeadline')
    mainWindow.show()
    focusMainWindow()
  }, BOOT_SHELL_DEADLINE_MS)
  bootShellDeadline.unref?.()
}

function clearBootShellDeadline(): void {
  if (!bootShellDeadline) return
  clearTimeout(bootShellDeadline)
  bootShellDeadline = null
}

function showMainWindow(options: { fromTrayShow?: boolean } = {}): void {
  if (isTestMode) return
  if (hiddenUntilTrayShow && !options.fromTrayShow) return
  if (options.fromTrayShow) hiddenUntilTrayShow = false
  if (!isLive(mainWindow)) {
    createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  focusMainWindow()
}

function hideMainWindow(): void {
  if (!isLive(mainWindow)) return
  mainWindow.hide()
  desktopPlatform.hideApp(app)
}

/** Show, focus, or hide the desktop workspace. */
function toggleMainWindow(): void {
  if (hiddenUntilTrayShow || isTestMode) return
  if (!isLive(mainWindow)) {
    createMainWindow()
    return
  }
  const shouldHide =
    mainWindow.isVisible() && (mainWindow.isFocused() || mainWindow.webContents.isFocused())
  if (shouldHide) hideMainWindow()
  else showMainWindow()
}

function hideAppWindow(): void {
  mainWindow?.hide()
  desktopPlatform.hideApp(app)
}

function hideUntilTrayShow(): void {
  hiddenUntilTrayShow = desktopPlatform.holdsHiddenUntilTrayShow
  hideMainWindow()
}

/** Restore + focus the workspace after a capture flow hid it. */
function showAndFocusWorkspaceWindow(): void {
  if (isTestMode) return
  if (!isLive(mainWindow)) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  focusMainWindow()
}

// ─── Native-only IPC handlers (don't go through SolusServer) ───

// The window's own credential for this host, kept with the keychain (local-owner-token.ts).
let localOwnerToken: LocalOwnerToken | null = null

function getLocalSessionToken(): string {
  localOwnerToken ??= new LocalOwnerToken({
    file: join(app.getPath('userData'), 'local-session-token.bin'),
    legacyFile: join(app.getPath('userData'), 'local-session-token.json'),
    cipher: safeStorage,
    issue: () => issueSessionToken(LOCAL_DEVICE_LABEL).token,
    issuedAt: (token) => {
      const session = verifySessionToken(token)
      return session?.deviceLabel === LOCAL_DEVICE_LABEL ? session.issuedAt : null
    },
    refresh: refreshSessionToken,
    now: () => Date.now(),
  })
  return localOwnerToken.current()
}

// The Solus account lives in main: the session token is keychain-encrypted here and
// the renderer receives only the account state. Re-verified on boot and on focus.
let accountSession: AccountSession | null = null
if (!isHeadless && !isPairUrl) {
  accountSession = registerAccountIpc(sendNativeEvent)
  app.on('browser-window-focus', () => void accountSession?.verify('focus'))
}

ipcMain.handle(LOCAL_CONNECTION_CHANNEL, async () => {
  // The renderer window is created before the server finishes booting, so this
  // first call may arrive early; await boot rather than throwing. A boot failure
  // rejects the promise — the renderer renders its boot-error card in that case.
  const booted = await bootPromise
  if (!booted) return null
  return {
    port: booted.booted.port,
    token: getLocalSessionToken(),
    installationId: getInstallationId(),
  }
})

// Native, not RPC: with the local host off there is no server to ask
// (docs/plans/desktop-remote-only.md). The relaunch takes the normal quit path,
// so a running host shuts down cleanly first.
ipcMain.handle('solus:set-local-host-enabled', (_event, rawEnabled) => {
  const enabled = z.boolean().parse(rawEnabled)
  if (enabled === isLocalHostEnabled) return
  writeLocalHostEnabled(localHostSettingPath, enabled)
  log.info('local_host_setting_changed', { enabled })
  app.relaunch()
  app.quit()
})

const externalUrlSchema = z.string().regex(/^https?:\/\//i)
const attachmentReadSchema = z.tuple([z.string(), z.string()])

ipcMain.handle('solus:open-external', async (_event, input, options?: { hideAppAfterOpen?: boolean }) => {
  const parsedUrl = externalUrlSchema.safeParse(input)
  if (!parsedUrl.success) return false
  try {
    await shell.openExternal(parsedUrl.data)
    if (options?.hideAppAfterOpen) hideAppWindow()
    return true
  } catch {
    return false
  }
})

const activityBadges = new DesktopActivityBadges()
const activityBadgeSenders = new Set<number>()
const activityBadgeSchema = z.array(z.string().max(1024)).max(100000)
ipcMain.handle('solus:set-activity-badge', (event, input) => {
  const parsed = activityBadgeSchema.safeParse(input)
  if (!parsed.success) return
  if (parsed.data.length > 0 && isLive(mainWindow) && mainWindow.isFocused()) {
    event.sender.send('solus:activity-acknowledged')
    return
  }
  if (!activityBadgeSenders.has(event.sender.id)) {
    const senderId = event.sender.id
    activityBadgeSenders.add(senderId)
    event.sender.once('destroyed', () => {
      activityBadgeSenders.delete(senderId)
      setActivityBadge(activityBadges.remove(senderId))
    })
  }
  setActivityBadge(activityBadges.update(event.sender.id, parsed.data))
})

ipcMain.handle('solus:show-notification', (_event, request) => {
  const parsed = clientNotificationRequestSchema.safeParse(request)
  if (!parsed.success) return false
  return showDesktopNotification(parsed.data, (route) => {
    showMainWindow({ fromTrayShow: true })
    sendNativeEvent('solus:open-route', route)
  })
})

const notificationSoundLogSchema = z.object({
  event: z.enum(['notification_sound_play_requested', 'notification_sound_play_failed']),
  sessionId: z.string(),
  agentSessionId: z.string().nullable(),
  trigger: z.enum([
    'turn_settled',
    'permission_request',
    'question_request',
    'plan',
    'work_created',
    'artifact_created',
    'automation_saved',
    'task_created',
    'agent_conversation_new_card',
    'agent_conversation_needs_attention',
  ]),
  error: z.string().optional(),
})

ipcMain.on('solus:log-notification-sound', (_event, row) => {
  const parsed = notificationSoundLogSchema.safeParse(row)
  if (!parsed.success) return
  log.info(parsed.data.event, parsed.data)
})

ipcMain.on('solus:log-share-dialog', (_event, row) => {
  const parsed = shareDialogLogSchema.safeParse(row)
  if (!parsed.success) return
  log.info(parsed.data.event, parsed.data)
})

ipcMain.handle('solus:read-attachment-bytes', async (_event, rawPath, rawMime) => {
  const request = attachmentReadSchema.safeParse([rawPath, rawMime])
  if (!request.success) throw new Error('Invalid attachment read request.')
  const [path, mime] = request.data
  if (!/^[a-z0-9][a-z0-9!#$&^_.+/-]{0,126}$/i.test(mime)) {
    throw new Error('Invalid attachment MIME type.')
  }
  const allowedPath = consumeClientAttachmentRead(path)
  if (!allowedPath) throw new Error('The attachment was not selected in the file dialog.')
  const file = statSync(allowedPath)
  if (!file.isFile()) throw new Error('Only files can be attached.')
  if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
    throw new Error('Attachment exceeds the 10 MB limit.')
  }
  const buffer = readFileSync(allowedPath)
  return {
    dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
    size: buffer.length,
  }
})

function scheduleSessionIndexer(): void {
  if (sessionIndexerStartTimer) return
  // The renderer reports after its first real idle window. Keep a small cushion
  // between renderer hydration and the disk-heavy transcript sweep. The core
  // owns the sweep and starts it once; the renderer mounts only after it booted.
  sessionIndexerStartTimer = setTimeout(() => {
    sessionIndexerStartTimer = null
    core?.startSessionIndex()
  }, 750)
  sessionIndexerStartTimer.unref?.()
}

ipcMain.on('solus:renderer-mounted', () => {
  markStartup('renderer.mounted')
  scheduleSessionIndexer()
})

ipcMain.on('solus:renderer-ready', (event) => {
  if (!isLive(mainWindow) || mainWindow.webContents !== event.sender) return
  markStartup('renderer.ready')
  traceRendererMarks(mainWindow.webContents)
  clearBootShellDeadline()
  if (!isTestMode && !mainWindow.isVisible()) {
    mainWindow.show()
    focusMainWindow()
  }
})

ipcMain.on('solus:html-fullscreen', (event, rawFullscreen) => {
  if (!isLive(mainWindow) || mainWindow.webContents !== event.sender) return
  const fullscreen = z.boolean().safeParse(rawFullscreen)
  if (!fullscreen.success) return
  const next = mainWindowHtmlFullscreen.request(fullscreen.data, mainWindow.isFullScreen())
  if (next !== null) mainWindow.setFullScreen(next)
})

ipcMain.on('solus:set-quote-context', (_event, tabId: string | null) => {
  quoteContextTabId = tabId || null
})

const guestShortcutsSchema = z.array(z.object({
  code: z.string(),
  alt: z.boolean(),
  shift: z.boolean(),
  meta: z.boolean(),
  ctrl: z.boolean(),
}))

ipcMain.on('solus:set-guest-shortcuts', (_event, rawShortcuts) => {
  const shortcuts = guestShortcutsSchema.safeParse(rawShortcuts)
  if (shortcuts.success) guestShortcuts = shortcuts.data
})

ipcMain.on('solus:set-zoom-factor', (event, rawFactor) => {
  const factor = z.number().safeParse(rawFactor)
  if (!factor.success) return
  event.sender.setZoomFactor(clampZoomFactor(factor.data))
})

/**
 * Loads the server graph and boots the local host. False when boot failed; the
 * renderer then shows its boot-error card.
 *
 * Loaded here rather than at module scope, and deliberately after the
 * window exists. `bootCore` reaches 279 of the main process's 342 eager
 * modules and nearly every heavy dependency it has — ws, hono,
 * Octokit, google-auth-library, the Claude SDK — so a static import made
 * all of it evaluate before Electron was even ready, delaying the window
 * and therefore the renderer behind it. None of it is needed to open a
 * window, and the renderer's first IPC already awaits `bootPromise`, so
 * the server graph now loads beside the renderer instead of ahead of it.
 * Transcription comes with it: both of its exports are used only from here
 * down, and its model downloader reaches posthog-node — the one heavy
 * dependency still eager once the server graph moved.
 */
async function bootLocalHost(
  windowDeps: WindowDeps | undefined,
  fileDeps: FileDeps | undefined,
): Promise<boolean> {
  const serverGraphLoadStartedAt = performance.now()
  const [
    { bootCore },
    { prepareTranscriptionModel, transcribeAudio },
    { registerFileHandlers },
    { readMdmPolicy },
  ] = await Promise.all([
    import('@solus/server/boot-core'),
    import('@solus/desktop-main/transcription'),
    import('@solus/desktop-main/server/handlers/file-handlers'),
    import('@solus/server/host/policy/mdm-policy'),
  ])
  log.info('server_graph_loaded', { elapsedMs: Math.round(performance.now() - serverGraphLoadStartedAt) })

  let bootedCore: BootCore
  try {
    // A machine policy this build cannot enforce stops the app before the
    // host opens anything; the boot-error card names the source (plans/030 §5.1).
    await readMdmPolicy()
    bootedCore = await bootCore({
      windowDeps,
      registerHostHandlers: fileDeps
        ? (server) => registerFileHandlers(server, fileDeps)
        : undefined,
      requireAuth: process.env.SOLUS_REQUIRE_AUTH === '1',
      port: desktopServerPort(),
      staticDir: join(__dirname, '../client'),
      transcribeAudio,
      // A window paints first; a headless app has none and sweeps at once.
      deferSessionIndex: !isHeadless,
    })
  } catch (err) {
    // Unblock the renderer's getLocalConnection with the failure so it can show
    // its boot-error card instead of hanging on the pending bootPromise.
    rejectBoot(err instanceof Error ? err : new Error(String(err)))
    log.error('core_boot_failed', { error: err instanceof Error ? err.message : String(err) })
    return false
  }
  core = bootedCore
  // Main is the account client of its own host: it presents its token there (ADR 0001 §2.2 rule 10).
  if (accountSession) presentAccountToLocalHost(accountSession, bootedCore.booted.localClient)
  markStartup('core.booted')
  resolveBoot(bootedCore)
  bootedCore.sessionRuntime.on('active-work-changed', syncPowerSaveBlocker)
  syncPowerSaveBlocker()
  if (!isTestMode) void prepareTranscriptionModel()
  return true
}

// ─── App Lifecycle ───

if (isPairUrl) {
  app.whenReady().then(async () => {
    try {
      const r = await mintPairUrl()
      process.stdout.write(`URL:  ${r.url}\nCode: ${r.code}\nExpires in: ${r.expiresIn}\n`)
    } catch (err: any) {
      process.stderr.write(`Error: ${err.message}\n`)
      app.exit(1)
    }
    app.quit()
  })
} else {
  app.whenReady().then(async () => {
    markStartup('app.ready')
    protocol.handle('solus-local-video', handleLocalVideoRequest)
    if (isLocalHostEnabled) {
      // Teach the server how to render a browser page — in a renderer's
      // `<webview>` when a pane is showing it, and in a window that is never shown
      // when nothing is. Must precede boot: a client can attach a surface, and an
      // agent can drive a page, as soon as the browser domain answers.
      registerBrowserWebviewHost()
      registerBrowserHeadlessHost()
      registerBrowserRecordingEncoderHost()

      // Resolve the login-shell PATH off the main thread now, so agent-binary
      // lookup is warm. The Codex app-server itself remains lazy: starting it here
      // costs a persistent child process even for Claude-only workspaces.
      void warmCliPath()
        .catch((err) => log.warn('cli_path_warmup_failed', { error: err instanceof Error ? err.message : String(err) }))
    }
    // A Dock launch has none of the user's shell profile. Take the allowed
    // variables (SOLUS_DATA_DIR, SSH_AUTH_SOCK, ...) from the login shell; the
    // server graph is awaited on it below, because its modules read them as
    // they evaluate. Tests keep the environment they were launched with.
    const loginShellEnv = isTestMode || !isLocalHostEnabled
      ? Promise.resolve()
      : importLoginShellEnv()
        .then((names) => { if (names.length > 0) log.info('login_shell_env_imported', { names }) })
        .catch((err) => log.warn('login_shell_env_import_failed', { error: err instanceof Error ? err.message : String(err) }))

    desktopPlatform.ready(app)

    const windowDeps: WindowDeps | undefined = isHeadless ? undefined : {
      isAppVisible,
      getAppGlobalShortcuts: () => currentAppShortcuts,
      setAppGlobalShortcuts: (shortcuts) => {
        const result = applyAppGlobalShortcuts(shortcuts)
        saveAppShortcuts(shortcuts)
        return result
      },
      restartApp: () => {
        app.relaunch()
        app.exit(0)
      },
    }

    const fileDeps: FileDeps | undefined = isHeadless ? undefined : {
      getWorkspaceWindow: workspaceWindow,
      hideAppWindow,
      showAndFocusWorkspaceWindow,
      bumpScreenshotCounter: () => ++screenshotCounter,
      bumpPasteCounter: () => ++pasteCounter,
      ensureScreenCaptureAccess: isTestMode ? async () => true : ensureScreenCaptureAccess,
    }

    // Create the renderer window BEFORE booting the server so the renderer
    // bundle — the longest single startup item — loads in parallel with server
    // boot. The renderer's first IPC (getLocalConnection) awaits bootPromise, so
    // it blocks only until the server is actually ready.
    if (!isHeadless) {
      createMainWindow()
      markStartup('window.created')
    }

    await loginShellEnv
    const { hostPolicyStore, HostPolicyStore, useHostPolicyStore } = await import('@solus/server/host/policy/host-policy-store')

    if (isLocalHostEnabled) {
      if (!await bootLocalHost(windowDeps, fileDeps)) return
    } else {
      try {
        // No host runs here, but the update feed still follows a machine policy (plans/030 §6.8).
        const { readMdmPolicy } = await import('@solus/server/host/policy/mdm-policy')
        useHostPolicyStore(new HostPolicyStore({ mdm: await readMdmPolicy(), standing: () => null }))
      } catch (err) {
        rejectBoot(err instanceof Error ? err : new Error(String(err)))
        log.error('machine_policy_read_failed', { error: err instanceof Error ? err.message : String(err) })
        return
      }
      log.info('local_host_off')
      resolveBoot(null)
    }

    if (!isHeadless) {
      nativeTheme.on('updated', () => {
        sendNativeEvent('solus:theme-changed', nativeTheme.shouldUseDarkColors)
      })

      app.on('browser-window-focus', (_e, win) => {
        if (!isLive(mainWindow) || win !== mainWindow) return
        activityBadges.acknowledge()
        setActivityBadge(0)
        sendNativeEvent('solus:activity-acknowledged')
      })

      const updates = registerUpdateIpc({
        broadcast: sendNativeEvent,
        // The embedded host runs in this process; its store holds the MDM and cloud host policies.
        policy: {
          current: () => hostPolicyStore().current(),
          onChanged: (listener) => hostPolicyStore().onChanged(listener),
        },
        onBeforeQuitAndInstall: () => {
          forceQuit = true
          void core?.shutdown()
        },
        onStatusChange: (status) => {
          const version = status.state.kind === 'ready' ? status.state.release.version : null
          if (version === readyUpdateVersion) return
          readyUpdateVersion = version
          tray?.setContextMenu(buildTrayMenu(updates.restartToUpdate))
        },
      })

      if (!isTestMode) handleMicrophoneRequests()

      if (!isTestMode) {
        currentAppShortcuts = loadAppShortcuts()
        applyAppGlobalShortcuts(currentAppShortcuts)

        tray = createTray(buildTrayMenu(updates.restartToUpdate))

        app.on('activate', () => {
          showMainWindow()
        })
      }
    }
  })
}

app.on('before-quit', (event) => {
  // Auto-update sets forceQuit before calling quitAndInstall and must not be
  // intercepted. All ordinary quit paths get one bounded cleanup attempt.
  if (forceQuit || shutdownCoordinator.isQuitting) return
  event.preventDefault()
  // The quit event is the host's; with no host, the analytics graph stays unloaded.
  if (core) captureQuitEvent(Math.max(0, Date.now() - bootStartedAt))
  shutdownCoordinator.requestQuit()
})

app.on('will-quit', () => {
  if (sessionIndexerStartTimer) {
    clearTimeout(sessionIndexerStartTimer)
    sessionIndexerStartTimer = null
  }
  void closeDatabase()
  closeDb()
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId)
  }
  globalShortcut.unregisterAll()
  tray?.destroy()
  tray = null
  destroyAllFinders()
  flushLogs()
})

app.on('window-all-closed', () => {
  if (desktopPlatform.quitsWhenWindowsClose) app.quit()
})
