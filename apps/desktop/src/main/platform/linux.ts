import { execFile } from 'child_process'
import { copyFile, mkdir, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { nativeImage } from 'electron'
import type { DetectedTerminal } from '@solus/contracts/types'
import { LINUX_KEYS } from '@solus/workspace-ui/lib/keybindings/key-platform'
import { findOnPath } from '@solus/server/cli-env'
import { createLogger } from '@solus/server/logger'
import { requestLinuxScreenshot } from '@solus/desktop-main/capture/linux-screenshot'
import { TERMINAL_APPS } from '@solus/desktop-main/terminal-apps'
import { loginShellCommand, tmuxTerminal } from '@solus/desktop-main/terminal-launcher'
import type { DesktopPlatform } from './desktop-platform'
import { linuxTerminalApps } from './linux-terminal'
import { LINUX_LINK_MIME_TYPE, linuxAppLaunchers, linuxAutostartEntry, linuxAutostartPath, writeLinuxLinkHandler } from './linux-app-launchers'

const log = createLogger('main', 'platform-linux')
const tmux = tmuxTerminal(linuxTerminalApps)

export const linuxPlatform: DesktopPlatform = {
  id: 'linux',
  keys: LINUX_KEYS,

  prepare(app) {
    app.setDesktopName('com.solus.app.desktop')
    app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
  },
  ready() {},
  singleInstance: true,
  quitsWhenWindowsClose: true,
  windowOptions: {},

  bringToFront() {},
  hideApp() {},
  holdsHiddenUntilTrayShow: false,

  trayIcon: (appPath) => nativeImage.createFromPath(join(appPath, 'resources/icon.png')),
  trayShowsOnClick: false,
  setActivityBadge(app, _window, count) {
    app.setBadgeCount(count)
  },
  appBadgesOnOwnWindow: false,
  async setOpenAtLogin(_app, isOn, install) {
    // Electron has no login item on Linux: a desktop reads `~/.config/autostart` (XDG Autostart).
    const entry = linuxAutostartPath(install)
    if (!isOn) {
      await rm(entry, { force: true })
      return 'done'
    }
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, linuxAutostartEntry(install), { mode: 0o644 })
    return 'done'
  },

  terminal: {
    resolve: tmux.resolve,
    launch: tmux.launch,
    async detect(cliPath) {
      const terminals: DetectedTerminal[] = []
      for (const app of TERMINAL_APPS) {
        // The system terminal is a role: it is offered when any terminal can fill it.
        if (app.id === 'default-terminal') {
          if (await linuxTerminalApps.available(app.id)) terminals.push({ id: app.id, name: linuxTerminalApps.displayName(app) })
        } else if (findOnPath(app.linuxBin, cliPath)) terminals.push({ id: app.id, name: app.name })
      }
      return terminals
    },
    shellCommand: (env) => loginShellCommand(env, '/bin/sh'),
    hidesAppAfterLaunch: false,
  },

  editors: {
    detect(app, cliPath) {
      const binPath = findOnPath(app.bin, cliPath)
      return binPath ? { id: app.id, name: app.name, isTerminal: app.isTerminal, binPath } : null
    },
    open(app, filePaths, cliPath) {
      const binPath = findOnPath(app.bin, cliPath)
      if (!binPath) { log.warn('editor_not_installed', { editorId: app.id }); return Promise.resolve(false) }
      return new Promise<boolean>((resolve) => {
        execFile(binPath, [...(app.args ?? []), ...filePaths], (err: Error | null) => {
          if (err) log.error('open_editor_failed', { editorId: app.id, error: err.message })
          resolve(!err)
        })
      })
    },
  },

  appLaunchers: linuxAppLaunchers,
  async registerLinkScheme(_app, install) {
    if (!install.isPackaged) return
    const entryName = await writeLinuxLinkHandler(install)
    // xdg-mime writes the choice to the person's `mimeapps.list`; a desktop without it keeps the entry, which names the scheme.
    await new Promise<void>((resolve) => {
      execFile('xdg-mime', ['default', entryName, LINUX_LINK_MIME_TYPE], { timeout: 5_000 }, (error) => {
        if (error) log.warn('link_scheme_register_failed', { error: error.message })
        resolve()
      })
    })
  },

  async captureScreen(path, signal) {
    // The desktop's Screenshot portal asks the user for a region and writes a file.
    const source = await requestLinuxScreenshot(signal)
    if (!source) return false
    await copyFile(source, path)
    return true
  },
}
