// Electron's bundled Node.js doesn't use the macOS system keychain for TLS.
// Point it at the macOS root CA bundle so the Anthropic SDK can verify certs.
if (!process.env.NODE_EXTRA_CA_CERTS) {
  process.env.NODE_EXTRA_CA_CERTS = '/etc/ssl/cert.pem'
}

import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, Tray, Menu, nativeImage, nativeTheme, shell, systemPreferences, powerSaveBlocker, protocol } from 'electron'
import { join, extname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { syncBundledPlugins } from './agents/plugins'
import { warmCliPath } from './cli-env'
import { createLogger, flushLogs } from './logger'
import type { AppGlobalShortcuts, AppShortcutCombo } from '../shared/types'
import { comboToAccelerator } from '../renderer/lib/keybindings/match'
import { initAutoUpdater } from './updater'
import type { BootedServer } from './server'
import { bootCore, type BootCore } from './boot-core'
import { attachDesktopAttentionNotifications, type DesktopAttentionNotifications } from './desktop-notifications'
import type { WindowDeps } from './server/handlers/window-handlers'
import type { FileDeps } from './server/handlers/file-handlers'
import { mintPairUrl } from './pair-url'
import { destroyAllFinders } from './server/file-finder'
import { warmupTranscription } from './transcription'
import { getInstallationId, issueSessionToken, refreshSessionToken, verifySessionToken } from './server/auth'
import { closeDb } from './db'
import { startSessionIndexer, stopSessionIndexer } from './db/session-indexer'
import { createShutdownCoordinator } from './shutdown-coordinator'

const SPACES_DEBUG = process.env.SOLUS_DEBUG === '1' || process.env.SOLUS_SPACES_DEBUG === '1'
const isHeadless = process.argv.includes('--headless')
const isPairUrl = process.argv.includes('pair-url')
const isDevMode = Boolean(process.env.ELECTRON_RENDERER_URL)

const log = createLogger('main', 'index.ts')

// Privileged custom scheme for rendering local image artifacts (from Codex's
// ImageGeneration tool) inside sandboxed iframes / <img>. Must be registered
// before app ready. `supportFetchAPI` lets ArtifactView fetch SVG bytes to feed
// into srcdoc.
protocol.registerSchemesAsPrivileged([
  { scheme: 'solus-artifact', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

/** Image MIME types served over solus-artifact://, keyed by lowercased extension. */
const ARTIFACT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

/** Decode the absolute file path from a solus-artifact://local/?p=<encoded> URL,
 *  validate it, and stream the bytes; 404/415 otherwise. */
async function handleArtifactRequest(request: Request): Promise<Response> {
  try {
    const filePath = new URL(request.url).searchParams.get('p')
    if (!filePath) return new Response('Missing path', { status: 400 })
    const mime = ARTIFACT_MIME[extname(filePath).toLowerCase()]
    if (!mime) return new Response('Unsupported type', { status: 415 })
    if (!existsSync(filePath)) return new Response('Not found', { status: 404 })
    const data = await readFile(filePath)
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: { 'Content-Type': mime, 'Content-Security-Policy': "default-src 'none'; img-src data: *; style-src 'unsafe-inline'" },
    })
  } catch (err: any) {
    log.warn(`solus-artifact request failed: ${err?.message ?? err}`)
    return new Response('Error', { status: 500 })
  }
}

let forceQuit = false

// The pill window is created lazily on first summon so its hidden renderer does
// not compete with the editor's first paint. The editor is the default boot
// surface; once mounted, both are clients of the same server broadcast stream.
let mainWindow: BrowserWindow | null = null
let editorWindow: BrowserWindow | null = null
// Last Solus window the user focused — the target for dialogs, screenshots,
// and design mode when no window currently holds focus (e.g. mid-capture).
let lastFocusedWindow: BrowserWindow | null = null
// Window whose opacity design mode zeroed, so restore hits the same one.
let designModeWindow: BrowserWindow | null = null
let designModeWindowBounds: Electron.Rectangle | null = null
let powerSaveBlockerId: number | null = null

// Hold the app-suspension blocker only while compute is actually happening
// (an agent turn or a managed dev-server process). Holding it for the app's
// lifetime disables macOS App Nap entirely, which keeps the machine warm at
// idle. Re-synced on every control-plane active-work flip and run-status
// broadcast; idempotent, so extra calls are free.
function syncPowerSaveBlocker(): void {
  if (isHeadless || isTestMode || !core) return
  const shouldBlock = core.controlPlane.hasActiveWork() || core.runManager.hasActiveRuns()
  const isBlocking = powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)
  if (shouldBlock === isBlocking) return
  if (shouldBlock) {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    log.info(`Power save blocker started (id=${powerSaveBlockerId})`)
  } else if (powerSaveBlockerId !== null) {
    powerSaveBlocker.stop(powerSaveBlockerId)
    log.info(`Power save blocker stopped (id=${powerSaveBlockerId})`)
    powerSaveBlockerId = null
  }
}

let tray: Tray | null = null
let screenshotCounter = 0
let designModeCounter = 0
let pasteCounter = 0
let toggleSequence = 0
let currentViewMode: 'pill' | 'editor' = 'editor'
let booted: BootedServer | null = null
let core: BootCore | null = null
// Resolves with the booted core once bootCore finishes; rejects if boot fails.
// The renderer's first IPC (getLocalConnection) awaits this instead of racing
// window creation against server boot — the window is now created before boot
// so its bundle loads in parallel, and the connection resolves when ready.
let resolveBoot!: (core: BootCore) => void
let rejectBoot!: (err: unknown) => void
const bootPromise = new Promise<BootCore>((resolve, reject) => {
  resolveBoot = resolve
  rejectBoot = reject
})
let desktopAttentionNotifications: DesktopAttentionNotifications | null = null
// True while the renderer's current text selection lives inside the conversation
// view. Pushed from the renderer on selectionchange so the native context menu
// can offer "Quote in reply" only for conversation output (not docs/diffs/etc).
let quoteContextActive = false
let hiddenUntilTrayShow = false
let pendingPillShowSource: string | null = null
let sessionIndexerStarted = false
let sessionIndexerStartTimer: ReturnType<typeof setTimeout> | null = null

const shutdownCoordinator = createShutdownCoordinator({
  shutdown: async () => {
    forceQuit = true
    await core?.shutdown()
  },
  quit: () => app.quit(),
  forceQuit: () => app.exit(0),
  onError: (error) => log.error(`shutdown failed: ${error}`),
})

process.on('SIGINT', shutdownCoordinator.requestQuit)
process.on('SIGTERM', shutdownCoordinator.requestQuit)

const LOCAL_CONNECTION_CHANNEL = 'solus:local-connection'
const LOCAL_DEVICE_LABEL = 'This Mac'
const LOCAL_TOKEN_REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000
let localSessionToken: string | null = null

// ─── OS summon shortcuts (Alt+Space / ⌘⇧K by default) ───
//
// Editable per-device. Main is the single source of truth (kept out of the
// renderer's settings.keybindings) so they apply before the renderer loads and
// can be re-registered live. Persisted as plain JSON in userData.

const DEFAULT_APP_SHORTCUTS: AppGlobalShortcuts = {
  primary: { alt: true, code: 'Space' },
  secondary: { mod: true, shift: true, code: 'KeyK' },
}

let currentAppShortcuts: AppGlobalShortcuts = DEFAULT_APP_SHORTCUTS

function appShortcutsPath(): string {
  return join(app.getPath('userData'), 'app-shortcuts.json')
}

function isCombo(v: unknown): v is AppShortcutCombo {
  return !!v && typeof v === 'object' && typeof (v as AppShortcutCombo).code === 'string'
}

function loadAppShortcuts(): AppGlobalShortcuts {
  try {
    const raw = readFileSync(appShortcutsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (isCombo(parsed?.primary) && isCombo(parsed?.secondary)) {
      return { primary: parsed.primary, secondary: parsed.secondary }
    }
  } catch {}
  return DEFAULT_APP_SHORTCUTS
}

function saveAppShortcuts(shortcuts: AppGlobalShortcuts): void {
  try {
    writeFileSync(appShortcutsPath(), JSON.stringify(shortcuts, null, 2), { mode: 0o600 })
  } catch (err: any) {
    log.warn(`Failed to persist app shortcuts: ${err?.message ?? err}`)
  }
}

/**
 * Unregister the previous summon accelerators and register the new ones.
 * Returns the accelerators that failed to register (caller offers a restart).
 * Only the two summon accelerators are touched — no other globalShortcut state.
 *
 * Each key has a dedicated window: primary always toggles the pill (the
 * assistant summon), secondary always toggles the editor. Deterministic —
 * what a key does never depends on which window the user last touched.
 */
function applyAppGlobalShortcuts(shortcuts: AppGlobalShortcuts): { failed: string[] } {
  const prevAccels = [
    comboToAccelerator(currentAppShortcuts.primary),
    comboToAccelerator(currentAppShortcuts.secondary),
  ]
  for (const accel of prevAccels) {
    if (accel && globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel)
  }

  const failed: string[] = []
  const bindings: Array<[AppShortcutCombo, (accel: string) => void]> = [
    [shortcuts.primary, (accel) => togglePillWindow(`shortcut ${accel}`)],
    [shortcuts.secondary, (accel) => toggleEditorWindow(`shortcut ${accel}`)],
  ]
  for (const [combo, handler] of bindings) {
    const accel = comboToAccelerator(combo)
    if (!accel) { failed.push(combo.code); continue }
    try {
      const ok = globalShortcut.register(accel, () => handler(accel))
      if (!ok) {
        log.warn(`Global shortcut "${accel}" registration failed — another app may claim it`)
        failed.push(accel)
      }
    } catch (err: any) {
      log.warn(`Global shortcut "${accel}" registration threw: ${err?.message ?? err}`)
      failed.push(accel)
    }
  }

  currentAppShortcuts = shortcuts
  return { failed }
}

function createTemplateMenuIcon(svg: string): Electron.NativeImage {
  const icon = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  )
  icon.setTemplateImage(true)
  return icon
}

// Phosphor "Quotes" icon as a 16x16 template image (black+transparent so
// macOS inverts it automatically for dark/light menus).
const quoteInReplyIcon = createTemplateMenuIcon(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 256 256"><path fill="#000" d="M116,72v88a48.05,48.05,0,0,1-48,48H64a8,8,0,0,1,0-16H68a32,32,0,0,0,32-32v-8H48a16,16,0,0,1-16-16V72A16,16,0,0,1,48,56h52A16,16,0,0,1,116,72Zm96-16H160a16,16,0,0,0-16,16v64a16,16,0,0,0,16,16h52v8a32,32,0,0,1-32,32h-4a8,8,0,0,0,0,16h4a48.05,48.05,0,0,0,48-48V72A16,16,0,0,0,212,56Z"/></svg>'
)

const isTestMode = process.env.SOLUS_TEST_MODE === '1'

// ─── Window registry + view-mode geometry ───
// The pill window fills the cursor display's work area: a transparent canvas
// with the pill UI positioned by CSS. It floats while active so the summon
// shortcut can surface Solus above a full-screen Space, then drops regular
// always-on-top behavior on blur so outside clicks let the clicked app cover
// it normally. The editor window is a standard OS window (native frame
// behavior, Dock/alt-tab presence, normal Spaces membership) — none of the
// pill's level/workspace juggling applies to it.

function workAreaBoundsForCursor(): Electron.Rectangle {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { x, y, width, height } = display.workArea
  return { x, y, width, height }
}

function isLive(win: BrowserWindow | null): win is BrowserWindow {
  return !!win && !win.isDestroyed()
}

function allWindows(): BrowserWindow[] {
  return [mainWindow, editorWindow].filter(isLive)
}

/** The window the user is in: focused, else last-focused live, else the pill. */
function activeWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && allWindows().includes(focused)) return focused
  if (isLive(lastFocusedWindow)) return lastFocusedWindow
  return isLive(mainWindow) ? mainWindow : null
}

function isAppVisible(): boolean {
  return allWindows().some((win) => win.isVisible())
}

function setPillWindowLevel(active: boolean): void {
  if (!isLive(mainWindow)) return

  if (active) {
    // The pill floats while active, including over macOS full-screen Spaces,
    // then drops back on blur so outside clicks can put the clicked app above it.
    mainWindow.setAlwaysOnTop(true, 'floating')
  } else {
    mainWindow.setAlwaysOnTop(false)
  }
}

function focusPillWindow(): void {
  if (!isLive(mainWindow)) return
  setPillWindowLevel(true)
  mainWindow.moveTop()
  if (process.platform === 'darwin') app.focus({ steal: true })
  mainWindow.focus()
  mainWindow.webContents.focus()
  booted?.server.broadcast('window-shown', windowCursorRelative())
}

function focusEditorWindow(): void {
  if (!isLive(editorWindow)) return
  if (process.platform === 'darwin') app.focus({ steal: true })
  editorWindow.focus()
  editorWindow.webContents.focus()
  booted?.server.broadcast('window-shown', null)
}

// Cursor position relative to the window's content area, in DIPs (matches CSS px).
// Returned alongside window-shown so the renderer can seed the click-through
// state from the actual cursor location — otherwise a first click on the pill
// races mousemove and passes through to whatever's behind Solus.
function windowCursorRelative(): { x: number; y: number } | null {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const cursor = screen.getCursorScreenPoint()
  const bounds = mainWindow.getContentBounds()
  return { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
}

function snapshotWindowState(reason: string): void {
  if (!SPACES_DEBUG) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    log.debug(`[spaces] ${reason} window=none`)
    return
  }

  const b = mainWindow.getBounds()
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const visibleOnAll = mainWindow.isVisibleOnAllWorkspaces()
  const wcFocused = mainWindow.webContents.isFocused()

  log.info(
    `[spaces] ${reason} ` +
    `vis=${mainWindow.isVisible()} focused=${mainWindow.isFocused()} wcFocused=${wcFocused} ` +
    `alwaysOnTop=${mainWindow.isAlwaysOnTop()} allWs=${visibleOnAll} ` +
    `bounds=(${b.x},${b.y},${b.width}x${b.height}) ` +
    `cursor=(${cursor.x},${cursor.y}) display=${display.id} ` +
    `workArea=(${display.workArea.x},${display.workArea.y},${display.workArea.width}x${display.workArea.height})`
  )
}

function scheduleToggleSnapshots(toggleId: number, phase: 'show' | 'hide'): void {
  if (!SPACES_DEBUG) return
  const probes = [0, 100, 400, 1200]
  for (const delay of probes) {
    setTimeout(() => {
      snapshotWindowState(`toggle#${toggleId} ${phase} +${delay}ms`)
    }, delay)
  }
}

// ─── Window Creation ───

/** Load the renderer with the window's mode in the URL. The renderer reads
 *  `?mode=` at bootstrap so each window mounts exactly one layout. */
function loadRenderer(win: BrowserWindow, mode: 'pill' | 'editor'): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.searchParams.set('mode', mode)
    win.loadURL(url.toString())
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { mode } })
  }
}

function createPillWindow(options: { showWhenReady?: boolean; source?: string } = {}): BrowserWindow {
  const bounds = workAreaBoundsForCursor()

  mainWindow = new BrowserWindow({
    ...bounds,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),  // NSPanel — non-activating, joins all spaces
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    backgroundColor: '#00000000',
    show: false,
    icon: join(__dirname, '../../resources/icon.icns'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (!isTestMode) {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    mainWindow.setAlwaysOnTop(true, 'floating')

    const handleDisplayChange = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const windowBounds = mainWindow.getBounds()
      const currentDisplay = screen.getDisplayNearestPoint({ x: windowBounds.x, y: windowBounds.y })
      const { x, y, width, height } = currentDisplay.workArea
      if (windowBounds.x === x && windowBounds.y === y && windowBounds.width === width && windowBounds.height === height) return
      mainWindow.setBounds({ x, y, width, height }, false)
    }
    screen.on('display-metrics-changed', handleDisplayChange)
    screen.on('display-added', handleDisplayChange)
    screen.on('display-removed', handleDisplayChange)
  }

  if (options.showWhenReady) pendingPillShowSource = options.source ?? 'pill ready'

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow?.isVisible()) booted?.server.broadcast('window-hidden')
    if (!isTestMode && process.env.ELECTRON_RENDERER_URL) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('blur', () => {
    setPillWindowLevel(false)
  })
  mainWindow.on('hide', () => booted?.server.broadcast('window-hidden'))
  attachContextMenu(mainWindow)

  if (SPACES_DEBUG) {
    mainWindow.on('show', () => snapshotWindowState('event window show'))
    mainWindow.on('hide', () => snapshotWindowState('event window hide'))
    mainWindow.on('focus', () => snapshotWindowState('event window focus'))
    mainWindow.on('blur', () => snapshotWindowState('event window blur'))
    mainWindow.webContents.on('focus', () => snapshotWindowState('event webContents focus'))
    mainWindow.webContents.on('blur', () => snapshotWindowState('event webContents blur'))
  }

  loadRenderer(mainWindow, 'pill')
  return mainWindow
}

/** Default editor bounds: a centered card on the cursor display, matching the
 *  92% × 90% the in-window editor shell used before the split. */
function editorDefaultBounds(): Electron.Rectangle {
  const { x, y, width, height } = workAreaBoundsForCursor()
  const w = Math.round(width * 0.92)
  const h = Math.round(height * 0.9)
  return {
    x: x + Math.round((width - w) / 2),
    y: y + Math.round((height - h) / 2),
    width: w,
    height: h,
  }
}

/** Create the editor window: a standard OS window (resizable, Dock/alt-tab
 *  presence, native shadow), lazily on first switch to editor mode. Closing it
 *  hides it — the window (and its bounds) live for the rest of the app run,
 *  so reopening is instant; a fresh launch starts at the default bounds. */
function createEditorWindow(): BrowserWindow {
  editorWindow = new BrowserWindow({
    ...editorDefaultBounds(),
    minWidth: 640,
    minHeight: 480,
    // Frameless look with real traffic lights on macOS; standard frame elsewhere.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18181b' : '#fafafa',
    show: false,
    icon: join(__dirname, '../../resources/icon.icns'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  editorWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault()
      editorWindow?.hide()
    }
  })
  editorWindow.on('hide', () => {
    booted?.server.broadcast('window-hidden')
  })

  attachContextMenu(editorWindow)

  editorWindow.once('ready-to-show', () => {
    if (!isTestMode && process.env.ELECTRON_RENDERER_URL) {
      editorWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  loadRenderer(editorWindow, 'editor')
  return editorWindow
}

function showPillWindow(source = 'unknown', options: { fromTrayShow?: boolean } = {}): void {
  if (isTestMode) return
  if (hiddenUntilTrayShow && !options.fromTrayShow) return
  if (options.fromTrayShow) hiddenUntilTrayShow = false
  if (!isLive(mainWindow)) {
    createPillWindow({ showWhenReady: true, source })
    return
  }
  // A first-summon pill exists but is still mounting. Its renderer-ready IPC
  // will complete the show with the real interactive UI.
  if (pendingPillShowSource) {
    pendingPillShowSource = source
    return
  }

  const toggleId = ++toggleSequence

  mainWindow.setBounds(workAreaBoundsForCursor(), false)

  if (SPACES_DEBUG) {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    log.debug(`[spaces] showWindow#${toggleId} source=${source} alwaysOnTop=${mainWindow.isAlwaysOnTop()} display=${display.id}`)
  }

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (SPACES_DEBUG) snapshotWindowState(`showWindow#${toggleId} pre-show`)

  mainWindow.show()
  focusPillWindow()
  if (SPACES_DEBUG) scheduleToggleSnapshots(toggleId, 'show')
}

/** On macOS, `app.hide()` returns focus to the previous app — but it hides
 *  every Solus window, so only do it when no other window stays visible. */
function hidePillWindow(_source = 'unknown'): void {
  if (!mainWindow) return
  mainWindow.hide()
  if (process.platform === 'darwin' && !isAppVisible()) app.hide()
}

function showEditorWindow(): void {
  if (isTestMode) return
  if (!isLive(editorWindow)) {
    createEditorWindow() // shows + focuses when the renderer is ready
    return
  }
  editorWindow.show()
  focusEditorWindow()
}

function hideEditorWindow(): void {
  if (!isLive(editorWindow)) return
  editorWindow.hide()
  if (process.platform === 'darwin' && !isAppVisible()) app.hide()
}

/** Primary summon key: always the pill. Summoning over a visible editor works —
 *  the pill floats above it, which is the assistant-over-workspace flow. */
function togglePillWindow(source = 'unknown'): void {
  if (hiddenUntilTrayShow) return
  if (!isLive(mainWindow)) {
    showPillWindow(source)
    return
  }

  const toggleId = ++toggleSequence
  if (SPACES_DEBUG) {
    log.debug(`[spaces] toggle#${toggleId} source=${source} start`)
    snapshotWindowState(`toggle#${toggleId} pre`)
  }

  if (mainWindow.isVisible()) {
    hidePillWindow(source)
    if (SPACES_DEBUG) scheduleToggleSnapshots(toggleId, 'hide')
  } else {
    showPillWindow(source)
  }
}

/** Secondary summon key: always the editor, creating it on first use.
 *  Visible-but-unfocused means focus it, not hide it. */
function toggleEditorWindow(_source = 'unknown'): void {
  if (hiddenUntilTrayShow || isTestMode) return
  if (!isLive(editorWindow)) {
    createEditorWindow() // shows + focuses when the renderer is ready
    return
  }
  const shouldHide =
    editorWindow.isVisible() && (editorWindow.isFocused() || editorWindow.webContents.isFocused())
  if (shouldHide) hideEditorWindow()
  else showEditorWindow()
}

/** Tray "Show Solus" / app activate: surface the current mode's window. */
function showCurrentModeWindow(source: string, options: { fromTrayShow?: boolean } = {}): void {
  if (currentViewMode === 'editor') {
    if (hiddenUntilTrayShow && !options.fromTrayShow) return
    if (options.fromTrayShow) hiddenUntilTrayShow = false
    showEditorWindow()
    return
  }
  showPillWindow(source, options)
}

/** Switch to the given mode's window (toggles when omitted). Shows/creates the
 *  target and hides the window being left. Asymmetric when both are visible:
 *  entering the editor always hides the pill (promotion is substitutive — a
 *  pill lingering over the workspace is clutter), while entering the pill
 *  leaves the editor visible (it's a place; the pill floats above it). */
function switchMode(target?: 'pill' | 'editor'): void {
  const next = target ?? (currentViewMode === 'pill' ? 'editor' : 'pill')
  const leaving = next === 'editor' ? mainWindow : editorWindow
  const entering = next === 'editor' ? editorWindow : mainWindow
  const bothVisible = isLive(leaving) && leaving.isVisible() && isLive(entering) && entering.isVisible()
  // Direct hide, not hidePill/hideEditorWindow: the entering window keeps (or
  // is about to take) focus, so no app.hide() focus-return is wanted here.
  const hideLeaving = () => {
    if ((next === 'editor' || !bothVisible) && isLive(leaving) && leaving.isVisible()) leaving.hide()
  }

  currentViewMode = next

  if (next === 'editor' && !isLive(editorWindow)) {
    // First switch: don't blank the screen while the editor window boots —
    // hide the pill only once the editor has actually shown.
    createEditorWindow().once('show', hideLeaving)
    return
  }

  if (next === 'pill' && !isLive(mainWindow)) {
    // Keep the editor visible until the lazily-created pill has painted.
    createPillWindow({ showWhenReady: true, source: 'switch-mode' }).once('show', hideLeaving)
    return
  }

  if (next === 'editor') showEditorWindow()
  else showPillWindow('switch-mode')
  hideLeaving()
}

function hideAppWindow(): void {
  mainWindow?.hide()
  editorWindow?.hide()
  if (process.platform === 'darwin') app.hide()
}

function hideUntilTrayShow(): void {
  hiddenUntilTrayShow = true
  hidePillWindow('tray dev hide until shown')
  hideEditorWindow()
}

/** Restore + focus the window a capture flow hid (screenshot). */
function showAndFocusActiveWindow(): void {
  if (isTestMode) return
  const win = activeWindow()
  if (!isLive(win)) return
  if (win === mainWindow) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.show()
    focusPillWindow()
  } else {
    win.show()
    focusEditorWindow()
  }
}

/** Design mode zeroes the active window's opacity for capture; remember which
 *  one so `restoreDesignModeWindow` restores the same window. */
function setActiveWindowOpacity(o: number): void {
  const win = o < 1 ? activeWindow() : (designModeWindow ?? activeWindow())
  if (!isLive(win)) return
  if (o < 1) designModeWindow = win
  win.setOpacity(o)
}

function expandDesignModeWindow(bounds: Electron.Rectangle): void {
  if (!isLive(designModeWindow)) return
  if (!designModeWindowBounds) designModeWindowBounds = designModeWindow.getBounds()
  designModeWindow.setBounds(bounds, false)
}

function designModeCaptureRegion(): { x: number; y: number; width: number; height: number } {
  const win = activeWindow()
  if (!isLive(win)) return { x: 0, y: 0, width: 0, height: 0 }
  const windowBounds = win.getBounds()
  const display = screen.getDisplayNearestPoint({ x: windowBounds.x, y: windowBounds.y })
  return display.workArea
}

/** Native context menu (copy/cut/paste + "Quote in reply"), attached to each window. */
function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const menuItems: Electron.MenuItemConstructorOptions[] = []

    if (params.selectionText) {
      menuItems.push({ label: 'Copy', role: 'copy' })
    }
    if (params.isEditable) {
      if (params.selectionText) {
        menuItems.push({ label: 'Cut', role: 'cut' })
      }
      menuItems.push({ label: 'Paste', role: 'paste' })
      menuItems.push({ type: 'separator' })
      menuItems.push({ label: 'Select All', role: 'selectAll' })
    } else if (params.selectionText) {
      menuItems.push({ type: 'separator' })
      menuItems.push({ label: 'Select All', role: 'selectAll' })
    }

    // Conversation output only: let the user pull a selected snippet into the
    // composer as a markdown blockquote to address that specific text.
    if (quoteContextActive && params.selectionText && !params.isEditable) {
      menuItems.push({ type: 'separator' })
      menuItems.push({
        label: 'Quote in reply',
        icon: quoteInReplyIcon,
        click: () => win.webContents.send('solus:quote-selection', params.selectionText),
      })
    }

    if (menuItems.length > 0) {
      Menu.buildFromTemplate(menuItems).popup({ window: win })
    }
  })
}

// ─── Native-only IPC handlers (don't go through SolusServer) ───

interface PersistedLocalSessionToken {
  token?: string
}

function localSessionTokenFile(): string {
  return join(app.getPath('userData'), 'local-session-token.json')
}

function readPersistedLocalSessionToken(): string | null {
  try {
    const file = localSessionTokenFile()
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PersistedLocalSessionToken
    return typeof parsed.token === 'string' ? parsed.token : null
  } catch {
    return null
  }
}

function writePersistedLocalSessionToken(token: string): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(localSessionTokenFile(), JSON.stringify({ token }, null, 2), { mode: 0o600 })
  } catch (err) {
    log.warn(`failed to persist local session token: ${err}`)
  }
}

function verifiedLocalSessionToken(token: string): string | null {
  const session = verifySessionToken(token)
  if (!session || session.deviceLabel !== LOCAL_DEVICE_LABEL) return null
  if (Date.now() - session.issuedAt <= LOCAL_TOKEN_REFRESH_AFTER_MS) return token
  const refreshed = refreshSessionToken(token)
  if (!refreshed) return token
  localSessionToken = refreshed
  writePersistedLocalSessionToken(refreshed)
  return refreshed
}

function getLocalSessionToken(): string {
  if (localSessionToken) {
    const verified = verifiedLocalSessionToken(localSessionToken)
    if (verified) return verified
  }

  const persisted = readPersistedLocalSessionToken()
  if (persisted) {
    const verified = verifiedLocalSessionToken(persisted)
    if (verified) {
      localSessionToken = verified
      return verified
    }
  }

  localSessionToken = issueSessionToken(LOCAL_DEVICE_LABEL)
  writePersistedLocalSessionToken(localSessionToken)
  return localSessionToken
}

ipcMain.handle(LOCAL_CONNECTION_CHANNEL, async () => {
  // The renderer window is created before the server finishes booting, so this
  // first call may arrive early; await boot rather than throwing. A boot failure
  // rejects the promise — the renderer renders its boot-error card in that case.
  const { port } = (await bootPromise).booted
  return {
    port,
    token: getLocalSessionToken(),
    installationId: getInstallationId(),
  }
})

function scheduleSessionIndexer(): void {
  if (sessionIndexerStarted || sessionIndexerStartTimer) return
  // The renderer reports after its first real idle window. Keep a small cushion
  // between renderer hydration and the disk-heavy transcript sweep.
  sessionIndexerStartTimer = setTimeout(() => {
    sessionIndexerStartTimer = null
    sessionIndexerStarted = true
    startSessionIndexer()
  }, 750)
  sessionIndexerStartTimer.unref?.()
}

ipcMain.on('solus:renderer-mounted', (_event, mode: unknown) => {
  if (mode !== 'pill' && mode !== 'editor') return
  scheduleSessionIndexer()
})

ipcMain.on('solus:renderer-ready', (event, mode: unknown) => {
  if (mode === 'editor') {
    if (!isLive(editorWindow) || editorWindow.webContents !== event.sender) return
    if (!isTestMode) {
      editorWindow.show()
      focusEditorWindow()
    }
    return
  }
  if (mode !== 'pill' || !pendingPillShowSource) return
  if (!isLive(mainWindow) || mainWindow.webContents !== event.sender) return
  const source = pendingPillShowSource
  pendingPillShowSource = null
  showPillWindow(source)
})

// OS-level click-through is preload-only — it operates on the Electron window
// directly and isn't relevant for browser clients.
ipcMain.on('solus:set-quote-context', (_event, active: boolean) => {
  quoteContextActive = !!active
})

ipcMain.on('solus:set-ignore-mouse-events', (event, ignore: boolean, options?: { forward?: boolean; focus?: boolean }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(ignore, options || {})
    if (options?.focus && !ignore && !win.isAlwaysOnTop() && !win.webContents.isFocused()) {
      if (process.platform === 'darwin') app.focus({ steal: true })
      win.focus()
      win.webContents.focus()
    }
  }
})

function restoreDesignModeWindow(): void {
  const win = designModeWindow ?? mainWindow
  if (!isLive(win)) return
  if (win === mainWindow) {
    // Pill-only level/workspace juggling; the editor is a normal window.
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setOpacity(1)
    focusPillWindow()
  } else {
    win.setOpacity(1)
    focusEditorWindow()
  }
  if (SPACES_DEBUG) {
    log.info('[spaces] design-mode overlay ready, window shown')
    snapshotWindowState('design-mode restore')
  }
}

function exitDesignModeWindow(): void {
  const win = designModeWindow
  const bounds = designModeWindowBounds
  designModeWindow = null
  designModeWindowBounds = null
  if (!isLive(win)) return
  if (bounds) win.setBounds(bounds, false)
  if (win === mainWindow) focusPillWindow()
  else focusEditorWindow()
}

// ─── Permission preflight (macOS) ───

async function requestPermissions(): Promise<void> {
  if (process.platform !== 'darwin') return

  try {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone')
    if (micStatus === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone')
    } else if (micStatus === 'denied') {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'Microphone Permission Required',
        message: 'Solus needs Microphone access for voice input.',
        detail: 'Click "Open Settings" to grant access in System Settings > Privacy & Security > Microphone.\n\nYou only need to do this once.',
        buttons: ['Open Settings', 'Skip for Now'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
      }
    }
  } catch (err: any) {
    log.warn(`Permission preflight: microphone check failed — ${err.message}`)
  }

  try {
    const screenStatus = systemPreferences.getMediaAccessStatus('screen')
    if (screenStatus === 'not-determined' || screenStatus === 'denied') {
      const flagFile = join(app.getPath('userData'), 'screen-permission-prompted')
      if (!existsSync(flagFile)) {
        const { response } = await dialog.showMessageBox({
          type: 'info',
          title: 'Screen Recording Permission',
          message: 'Solus needs Screen Recording access to take screenshots.',
          detail: 'Click "Open Settings" to grant access, then relaunch the app.\n\nYou only need to do this once.',
          buttons: ['Open Settings', 'Skip for Now'],
          defaultId: 0,
          cancelId: 1,
        })
        writeFileSync(flagFile, '')
        if (response === 0) {
          shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
        }
      }
    }
  } catch (err: any) {
    log.warn(`Permission preflight: screen check failed — ${err.message}`)
  }
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
    protocol.handle('solus-artifact', handleArtifactRequest)

    // Link app-bundled plugins into ~/.solus/plugins before any agent can run.
    await syncBundledPlugins()

    // Resolve the login-shell PATH off the main thread now, so it's warm before
    // the first RPC (agent-binary lookup) needs it instead of paying up to three
    // sequential login-shell probes synchronously on that first call.
    void warmCliPath()

    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide()
    }

    const windowDeps: WindowDeps | undefined = isHeadless ? undefined : {
      isAppVisible,
      switchMode,
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
      getActiveWindow: activeWindow,
      hideAppWindow,
      showAndFocusActiveWindow,
      setActiveWindowOpacity,
      expandDesignModeWindow,
      restoreDesignModeWindow,
      exitDesignModeWindow,
      bumpScreenshotCounter: () => ++screenshotCounter,
      bumpDesignModeCounter: () => ++designModeCounter,
      bumpPasteCounter: () => ++pasteCounter,
      designModeCaptureRegion,
    }

    // Create the renderer window BEFORE booting the server so the renderer
    // bundle — the longest single startup item — loads in parallel with server
    // boot. The renderer's first IPC (getLocalConnection) awaits bootPromise, so
    // it blocks only until the server is actually ready.
    if (!isHeadless) {
      // The editor is the only production renderer loaded at boot. The hidden
      // pill is created on first summon so it contributes no startup work.
      // E2E mode retains its historical hidden pill test surface.
      if (isTestMode) createPillWindow()
      else if (currentViewMode === 'editor') createEditorWindow()
      snapshotWindowState('after createWindow')
    }

    let bootedCore: BootCore
    try {
      bootedCore = await bootCore({
        windowDeps,
        fileDeps,
        requireAuth: process.env.SOLUS_REQUIRE_AUTH === '1',
        staticDir: join(__dirname, '../client'),
      })
    } catch (err) {
      // Unblock the renderer's getLocalConnection with the failure so it can show
      // its boot-error card instead of hanging on the pending bootPromise.
      rejectBoot(err)
      log.error(`Failed to boot Solus core: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    core = bootedCore
    booted = bootedCore.booted
    resolveBoot(bootedCore)
    bootedCore.controlPlane.on('active-work-changed', syncPowerSaveBlocker)
    bootedCore.booted.server.subscribe('run-status', syncPowerSaveBlocker)
    syncPowerSaveBlocker()
    // Independent of which window (if any) boots first — the editor is now the
    // default boot surface and the pill is created lazily on first summon, so
    // this can no longer live on the pill window's ready-to-show.
    if (!isTestMode) void warmupTranscription()
    if (isHeadless) {
      sessionIndexerStarted = true
      startSessionIndexer()
    }

    if (!isHeadless) {
      desktopAttentionNotifications = attachDesktopAttentionNotifications({
        attention: bootedCore.controlPlane.attention,
        focusWindow: () => showCurrentModeWindow('notification click', { fromTrayShow: true }),
        getTray: () => tray,
        badgeTarget: process.platform === 'darwin' && app.dock ? 'tray' : 'none',
        isActiveAttention: (entry) => bootedCore.controlPlane.isPendingAttentionLive(entry.sessionId),
      })

      nativeTheme.on('updated', () => {
        booted?.server.broadcast('theme-changed', nativeTheme.shouldUseDarkColors)
      })

      // Track the last-focused Solus window for dialog/capture targeting.
      // Each window is mode-locked (?mode= at load), so focus is the mode:
      // tray "Show Solus" and dock-activate follow the surface last touched.
      app.on('browser-window-focus', (_e, win) => {
        if (!allWindows().includes(win)) return
        lastFocusedWindow = win
        currentViewMode = win === editorWindow ? 'editor' : 'pill'
      })

      initAutoUpdater(() => {
        forceQuit = true
        void core?.shutdown()
      })

      if (!isTestMode) requestPermissions().catch((err: Error) => log.error(`Permission preflight error: ${err.message}`))

      if (SPACES_DEBUG) {
        app.on('browser-window-focus', () => snapshotWindowState('event app browser-window-focus'))
        app.on('browser-window-blur', () => snapshotWindowState('event app browser-window-blur'))

        screen.on('display-added', (_e, display) => {
          log.debug(`[spaces] event display-added id=${display.id}`)
          snapshotWindowState('event display-added')
        })
        screen.on('display-removed', (_e, display) => {
          log.debug(`[spaces] event display-removed id=${display.id}`)
          snapshotWindowState('event display-removed')
        })
        screen.on('display-metrics-changed', (_e, display, changedMetrics) => {
          log.debug(`[spaces] event display-metrics-changed id=${display.id} changed=${changedMetrics.join(',')}`)
          snapshotWindowState('event display-metrics-changed')
        })
      }

      if (!isTestMode) {
        currentAppShortcuts = loadAppShortcuts()
        applyAppGlobalShortcuts(currentAppShortcuts)

        const trayIconPath = join(__dirname, '../../resources/trayTemplate.png')
        const trayIcon = nativeImage.createFromPath(trayIconPath)
        trayIcon.setTemplateImage(true)
        tray = new Tray(trayIcon)
        tray.setToolTip('Solus')
        const trayTemplate: Electron.MenuItemConstructorOptions[] = [
          { label: 'Show Solus', click: () => showCurrentModeWindow('tray menu', { fromTrayShow: true }) },
        ]
        if (isDevMode) {
          trayTemplate.push({ label: 'Hide Solus Until Shown', click: hideUntilTrayShow })
        }
        trayTemplate.push({ label: 'Quit', click: () => { app.quit() } })
        tray.setContextMenu(
          Menu.buildFromTemplate(trayTemplate)
        )
        desktopAttentionNotifications?.syncBadge()
        void tray // keep alive for lifetime of the app

        app.on('activate', () => {
          showCurrentModeWindow('app activate')
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
  shutdownCoordinator.requestQuit()
})

app.on('will-quit', () => {
  if (sessionIndexerStartTimer) {
    clearTimeout(sessionIndexerStartTimer)
    sessionIndexerStartTimer = null
  }
  stopSessionIndexer()
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
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
