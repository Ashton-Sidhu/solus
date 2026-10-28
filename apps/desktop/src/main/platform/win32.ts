import { spawn } from 'child_process'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { desktopCapturer, Menu, nativeImage, screen } from 'electron'
import { WINDOWS_KEYS } from '@solus/workspace-ui/lib/keybindings/key-platform'
import { findOnPath, hostCliEnv, warmCliPath } from '@solus/server/cli-env'
import { createLogger } from '@solus/server/logger'
import { resolveHomePath } from '@solus/server/platform/paths'
import type { EditorApp } from '@solus/desktop-main/editor-apps'
import type { DesktopPlatform } from './desktop-platform'
import { BADGE_PIXELS, badgeBitmap, badgeLabel } from './win32-badge'
import { windowsEditorProgram, windowsInstallRoots } from './win32-editors'
import { windowsTerminalLaunch, type WindowsTerminalPrograms } from './win32-terminal'

const log = createLogger('main', 'platform-win32')

/** The notification area draws 16px icons at 100% scale. Windows scales a
 *  1024px source down badly, so give it one sharp size per common display scale. */
const TRAY_SCALES = [1, 1.25, 1.5, 2]

export const win32Platform: DesktopPlatform = {
  id: 'win32',
  keys: WINDOWS_KEYS,

  prepare(app) {
    // Windows groups taskbar buttons and notifications by this id; it must
    // match the installer's `appId`.
    app.setAppUserModelId('com.solus.app')
  },
  ready() {
    // The default menu bar shows File/Edit/View above the workspace, and its
    // Alt mnemonics take Alt+F, Alt+E, Alt+V, Alt+W, and Alt+H.
    Menu.setApplicationMenu(null)
  },
  singleInstance: true,
  quitsWhenWindowsClose: true,
  windowOptions: {},

  bringToFront(app, window) {
    // Windows refuses focus to a background app; the global shortcut gives it
    // the right to take the foreground, and moveTop raises it above the window
    // that had focus.
    app.focus()
    window.moveTop()
  },
  hideApp() {},
  holdsHiddenUntilTrayShow: false,

  trayIcon(appPath) {
    const source = nativeImage.createFromPath(join(appPath, 'resources/icon.png'))
    const icon = nativeImage.createEmpty()
    for (const scaleFactor of TRAY_SCALES) {
      const size = Math.round(16 * scaleFactor)
      icon.addRepresentation({ scaleFactor, buffer: source.resize({ width: size, height: size, quality: 'best' }).toPNG() })
    }
    return icon
  },
  // A Windows tray icon opens its menu on a right click only.
  trayShowsOnClick: true,
  setActivityBadge(_app, window, count) {
    // `setBadgeCount` does nothing on Windows; the count is an overlay icon on
    // the taskbar button.
    if (!window) return
    if (count === 0) {
      window.setOverlayIcon(null, '')
      return
    }
    const icon = nativeImage.createFromBitmap(badgeBitmap(badgeLabel(count)), { width: BADGE_PIXELS, height: BADGE_PIXELS, scaleFactor: 2 })
    window.setOverlayIcon(icon, `${count} sessions need attention`)
  },

  terminal: {
    // Windows has no tmux: each request opens its own window, and the one
    // terminal choice is named for what it opens.
    async resolve() {
      const { name } = windowsTerminalLaunch(await windowsTerminalPrograms(), '', undefined)
      return { id: 'default-terminal', name, source: 'fallback' }
    },
    async launch(request) {
      log.info('terminal_launch', { fallbackTerminalId: request.fallbackTerminalId, command: request.command })
      const cwd = request.cwd ? resolveHomePath(request.cwd) : undefined
      const launch = windowsTerminalLaunch(await windowsTerminalPrograms(), request.command, cwd)
      // Detached gives a console program its own window.
      return startDetached(launch.file, launch.args, cwd, launch.name)
    },
    async detect() {
      const { name } = await win32Platform.terminal.resolve('default-terminal')
      return [{ id: 'default-terminal', name }]
    },
    // The terminal opens PowerShell in the folder.
    shellCommand: () => '',
    hidesAppAfterLaunch: false,
  },

  editors: {
    detect(app, cliPath) {
      const binPath = app.isTerminal ? findOnPath(app.bin, cliPath) : editorProgram(app, cliPath)
      return binPath ? { id: app.id, name: app.name, isTerminal: app.isTerminal, binPath } : null
    },
    open(app, filePaths, cliPath) {
      const program = editorProgram(app, cliPath)
      if (!program) { log.warn('editor_not_installed', { editorId: app.id }); return Promise.resolve(false) }
      // An editor may run until the user closes it, so this answers when it starts.
      return startDetached(program, [...(app.args ?? []), ...filePaths], undefined, app.name)
    },
  },

  async captureScreen(path) {
    // Windows gives an app no region picker to wait on, so a capture takes the
    // whole display under the pointer at its native pixels.
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const thumbnailSize = {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
    const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0]
    if (!source || source.thumbnail.isEmpty()) throw new Error('Windows returned no image of the display.')
    await writeFile(path, source.thumbnail.toPNG(), { mode: 0o600 })
    return true
  },
}

/** Windows Terminal and PowerShell, from the CLI PATH. Windows Terminal's
 *  `wt.exe` is an app execution alias under WindowsApps, which is on PATH. */
async function windowsTerminalPrograms(): Promise<WindowsTerminalPrograms> {
  const path = await warmCliPath()
  return {
    windowsTerminal: findOnPath('wt.exe', path),
    powershell: findOnPath('pwsh.exe', path) ?? findOnPath('powershell.exe', path) ?? 'powershell.exe',
  }
}

/** A GUI editor's program: its install folder first, because the command on
 *  PATH is a `.cmd` that Node cannot start; then a PATH program. */
function editorProgram(app: EditorApp, cliPath: string): string | null {
  const installed = windowsEditorProgram(app, windowsInstallRoots(process.env))
  if (installed) return installed
  const onPath = findOnPath(app.bin, cliPath)
  return onPath && /\.exe$/i.test(onPath) ? onPath : null
}

function startDetached(file: string, args: string[], cwd: string | undefined, name: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(file, args, { cwd, detached: true, stdio: 'ignore', env: hostCliEnv() })
    child.once('error', (error) => {
      log.error('windows_program_start_failed', { program: name, error: error.message })
      resolve(false)
    })
    child.once('spawn', () => { child.unref(); resolve(true) })
  })
}
