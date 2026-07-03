// Electron's bundled Node.js doesn't use the macOS system keychain for TLS.
// Point it at the macOS root CA bundle so the Anthropic SDK can verify certs.
if (!process.env.NODE_EXTRA_CA_CERTS) {
  process.env.NODE_EXTRA_CA_CERTS = '/etc/ssl/cert.pem'
}

import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, Tray, Menu, nativeImage, nativeTheme, shell, systemPreferences, powerSaveBlocker, protocol } from 'electron'
import { join, extname } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { ControlPlane } from './control-plane'
import { RunManager } from './run/run-manager'
import { createBackends } from './agents/backend-registry'
import { syncBundledPlugins } from './agents/plugins'
import { createLogger, flushLogs } from './logger'
import type { AgentId, IpcContext, AppGlobalShortcuts, AppShortcutCombo } from '../shared/types'
import { comboToAccelerator } from '../renderer/lib/keybindings/match'
import { initAutoUpdater } from './updater'
import { bootServer, type BootedServer } from './server'
import { attachElectronIpcTransport } from './transports/electron-ipc'
import type { WindowDeps } from './server/handlers/window-handlers'
import type { FileDeps } from './server/handlers/file-handlers'
import { mintPairUrl } from './pair-url'
import { destroyAllFinders } from './server/file-finder'
import { warmupTranscription } from './transcription'

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

// The pill window (kept as `mainWindow` — it's the boot window and the summon
// surface). The editor is a second, standard OS window created lazily on first
// switch; both are clients of the same SolusServer broadcast stream.
let mainWindow: BrowserWindow | null = null
let editorWindow: BrowserWindow | null = null
// Last Solus window the user focused — the target for dialogs, screenshots,
// and design mode when no window currently holds focus (e.g. mid-capture).
let lastFocusedWindow: BrowserWindow | null = null
// Window whose opacity design mode zeroed, so restore hits the same one.
let designModeWindow: BrowserWindow | null = null
let powerSaveBlockerId: number | null = null
let tray: Tray | null = null
let screenshotCounter = 0
let designModeCounter = 0
let pasteCounter = 0
let toggleSequence = 0
let currentViewMode: 'pill' | 'editor' = 'pill'
let booted: BootedServer | null = null
// True while the renderer's current text selection lives inside the conversation
// view. Pushed from the renderer on selectionchange so the native context menu
// can offer "Quote in reply" only for conversation output (not docs/diffs/etc).
let quoteContextActive = false
let detachIpc: (() => void) | null = null
let hiddenUntilTrayShow = false

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
const controlPlane = new ControlPlane(createBackends())
const runManager = new RunManager({
  broadcast: (status) => booted?.server.broadcast('run-status', status),
  broadcastLog: (batch) => booted?.server.broadcast('run-log', batch),
})

const DEFAULT_AGENT_ID: AgentId = 'claude-code'

function agentIdFromContext(ctx?: IpcContext): AgentId {
  return ctx?.session.provider ?? ctx?.settings.activeAgent ?? DEFAULT_AGENT_ID
}

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

function createPillWindow(): void {
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

  mainWindow.once('ready-to-show', () => {
    if (!isTestMode) mainWindow?.show()
    booted?.server.broadcast('window-shown', windowCursorRelative())
    if (!isTestMode) {
      void warmupTranscription()
    }
    if (!isTestMode && process.env.ELECTRON_RENDERER_URL) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  app.on('before-quit', () => { forceQuit = true })
  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('blur', () => {
    setPillWindowLevel(false)
  })

  loadRenderer(mainWindow, 'pill')
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

/** The app boots dock-hidden (the pill is a menu-bar-style overlay). The Dock
 *  item appears while the editor window is visible — it's the "traditional
 *  app" surface — and goes away when the editor hides, leaving the pill
 *  summonable without Dock/cmd-tab presence. Dock click lands on the app
 *  `activate` event, which surfaces the current mode's window. */
function updateDockVisibility(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const editorVisible = isLive(editorWindow) && editorWindow.isVisible()
  if (editorVisible) {
    if (!app.dock.isVisible()) void app.dock.show()
  } else {
    app.dock.hide()
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
  editorWindow.on('show', updateDockVisibility)
  editorWindow.on('hide', () => {
    updateDockVisibility()
    booted?.server.broadcast('window-hidden')
  })

  attachContextMenu(editorWindow)

  editorWindow.once('ready-to-show', () => {
    if (!isTestMode) {
      editorWindow?.show()
      focusEditorWindow()
    }
    if (!isTestMode && process.env.ELECTRON_RENDERER_URL) {
      editorWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  loadRenderer(editorWindow, 'editor')
  return editorWindow
}

function showPillWindow(source = 'unknown', options: { fromTrayShow?: boolean } = {}): void {
  if (!mainWindow || isTestMode) return
  if (hiddenUntilTrayShow && !options.fromTrayShow) return
  if (options.fromTrayShow) hiddenUntilTrayShow = false

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
    createEditorWindow() // shows + focuses on ready-to-show
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
  if (!mainWindow) return

  const toggleId = ++toggleSequence
  if (SPACES_DEBUG) {
    log.debug(`[spaces] toggle#${toggleId} source=${source} start`)
    snapshotWindowState(`toggle#${toggleId} pre`)
  }

  const shouldHide = mainWindow.isVisible() && (mainWindow.isFocused() || mainWindow.webContents.isFocused())
  if (shouldHide) {
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
    createEditorWindow() // shows + focuses on ready-to-show
    return
  }
  const shouldHide = editorWindow.isVisible() && (editorWindow.isFocused() || editorWindow.webContents.isFocused())
  if (shouldHide) hideEditorWindow()
  else showEditorWindow()
}

/** Tray "Show Solus" / app activate: surface the current mode's window. */
function showCurrentModeWindow(source: string, options: { fromTrayShow?: boolean } = {}): void {
  if (currentViewMode === 'editor' && isLive(editorWindow)) {
    if (hiddenUntilTrayShow && !options.fromTrayShow) return
    if (options.fromTrayShow) hiddenUntilTrayShow = false
    showEditorWindow()
    return
  }
  showPillWindow(source, options)
}

/** Switch to the given mode's window (toggles when omitted). Shows/creates the
 *  target and hides the window being left unless both were already visible —
 *  then this is just a focus change. No caller until the renderer bootstraps
 *  per-window modes via `?mode=` (Phase 2 of the two-window split). */
function switchMode(target?: 'pill' | 'editor'): void {
  const next = target ?? (currentViewMode === 'pill' ? 'editor' : 'pill')
  const leaving = next === 'editor' ? mainWindow : editorWindow
  const entering = next === 'editor' ? editorWindow : mainWindow
  const bothVisible = isLive(leaving) && leaving.isVisible() && isLive(entering) && entering.isVisible()
  // Direct hide, not hidePill/hideEditorWindow: the entering window keeps (or
  // is about to take) focus, so no app.hide() focus-return is wanted here.
  const hideLeaving = () => {
    if (!bothVisible && isLive(leaving) && leaving.isVisible()) leaving.hide()
  }

  currentViewMode = next

  if (next === 'editor' && !isLive(editorWindow)) {
    // First switch: don't blank the screen while the editor window boots —
    // hide the pill only once the editor has actually shown.
    createEditorWindow().once('show', hideLeaving)
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
  designModeWindow = null
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

    // Install app-bundled plugins into ~/.solus/plugins before any agent runs,
    // so Claude Code and Codex can load them from a real filesystem path.
    syncBundledPlugins()

    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide()
    }

    if (!isHeadless && !isTestMode) {
      powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      log.info(`Power save blocker started (id=${powerSaveBlockerId})`)
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
      restoreDesignModeWindow,
      bumpScreenshotCounter: () => ++screenshotCounter,
      bumpDesignModeCounter: () => ++designModeCounter,
      bumpPasteCounter: () => ++pasteCounter,
      designModeCaptureRegion,
    }

    booted = await bootServer({
      controlPlane,
      windowDeps,
      fileDeps,
      agentIdFromContext,
      runManager,
      requireAuth: process.env.SOLUS_REQUIRE_AUTH === '1',
      staticDir: join(__dirname, '../client'),
    })

    if (!isHeadless) {
      detachIpc = attachElectronIpcTransport(booted.server, allWindows)

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

      createPillWindow()
      snapshotWindowState('after createWindow')
      initAutoUpdater(() => { forceQuit = true })

      mainWindow?.on('hide', () => booted?.server.broadcast('window-hidden'))

      if (!isTestMode) requestPermissions().catch((err: Error) => log.error(`Permission preflight error: ${err.message}`))

      if (SPACES_DEBUG) {
        mainWindow?.on('show', () => snapshotWindowState('event window show'))
        mainWindow?.on('hide', () => snapshotWindowState('event window hide'))
        mainWindow?.on('focus', () => snapshotWindowState('event window focus'))
        mainWindow?.on('blur', () => snapshotWindowState('event window blur'))
        mainWindow?.webContents.on('focus', () => snapshotWindowState('event webContents focus'))
        mainWindow?.webContents.on('blur', () => snapshotWindowState('event webContents blur'))

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

      if (mainWindow) attachContextMenu(mainWindow)

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
        void tray // keep alive for lifetime of the app

        app.on('activate', () => {
          showCurrentModeWindow('app activate')
        })
      }
    }
  })
}

app.on('will-quit', () => {
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId)
  }
  globalShortcut.unregisterAll()
  tray?.destroy()
  tray = null
  runManager.stopAll()
  controlPlane.shutdown()
  destroyAllFinders()
  detachIpc?.()
  void booted?.shutdown()
  flushLogs()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
