import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { nativeImage } from 'electron'
import type { DetectedTerminal } from '@solus/contracts/types'
import { MAC_KEYS } from '@solus/workspace-ui/lib/keybindings/key-platform'
import { findOnPath } from '@solus/server/cli-env'
import { createLogger } from '@solus/server/logger'
import { findAppBundle } from '@solus/desktop-main/mac-apps'
import { TERMINAL_APPS } from '@solus/desktop-main/terminal-apps'
import { loginShellCommand, tmuxTerminal } from '@solus/desktop-main/terminal-launcher'
import type { DesktopPlatform } from './desktop-platform'
import { macTerminalApps } from './darwin-terminal'

const log = createLogger('main', 'platform-darwin')
const tmux = tmuxTerminal(macTerminalApps)

export const darwinPlatform: DesktopPlatform = {
  id: 'darwin',
  keys: MAC_KEYS,

  prepare() {
    // Electron's bundled Node.js doesn't use the macOS system keychain for TLS.
    // Point it at the macOS root CA bundle so the Anthropic SDK can verify certs.
    process.env.NODE_EXTRA_CA_CERTS ??= '/etc/ssl/cert.pem'
  },
  ready(app) {
    app.dock?.setIcon(join(__dirname, '../../resources/icon.png'))
  },
  singleInstance: false,
  quitsWhenWindowsClose: false,
  windowOptions: {
    // Edge-to-edge content with native traffic lights,
    // centred on the 40px titlebar row (`--solus-titlebar-height`).
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 13 },
  },

  bringToFront(app) {
    app.focus({ steal: true })
  },
  hideApp(app) {
    app.hide()
  },
  holdsHiddenUntilTrayShow: true,

  trayIcon(appPath) {
    const icon = nativeImage.createFromPath(join(appPath, 'resources/trayTemplate.png'))
    icon.setTemplateImage(true)
    return icon
  },
  trayShowsOnClick: false,
  setActivityBadge(app, _window, count) {
    app.setBadgeCount(count)
  },

  terminal: {
    resolve: tmux.resolve,
    launch: tmux.launch,
    async detect() {
      const terminals: DetectedTerminal[] = []
      for (const app of TERMINAL_APPS) {
        // The system terminal has no bundle to probe: it is always there, and
        // it has a name of its own.
        if (app.id === 'default-terminal') terminals.push({ id: app.id, name: macTerminalApps.displayName(app) })
        else if (app.macAppBundle && findAppBundle(app.macAppBundle)) terminals.push({ id: app.id, name: app.name })
      }
      return terminals
    },
    shellCommand: (env) => loginShellCommand(env, '/bin/zsh'),
    hidesAppAfterLaunch: true,
  },

  editors: {
    detect(app, cliPath) {
      // Either proof of installation counts. Most GUI editors ship their shell
      // command as an opt-in step, so requiring it hid apps the user has.
      const binPath = findOnPath(app.bin, cliPath)
      const appPath = app.macAppBundle ? findAppBundle(app.macAppBundle) : null
      return binPath || appPath ? { id: app.id, name: app.name, isTerminal: app.isTerminal, binPath } : null
    },
    open(app, filePaths, cliPath) {
      const appPath = app.macAppBundle ? findAppBundle(app.macAppBundle) : null
      // `open -a` both launches and raises, so the bundle path needs no separate
      // activate step the way the shell command does.
      const binPath = findOnPath(app.bin, cliPath)
      const [bin, binArgs] = binPath
        ? [binPath, [...(app.args ?? []), ...filePaths]]
        : appPath
          ? ['open', ['-a', appPath, ...filePaths]]
          : [null, []]
      if (!bin) { log.warn('editor_not_installed', { editorId: app.id }); return Promise.resolve(false) }
      return new Promise<boolean>((resolve) => {
        execFile(bin, binArgs, (err: Error | null) => {
          if (err) { log.error('open_editor_failed', { editorId: app.id, error: err.message }); resolve(false); return }
          if (bin !== 'open' && appPath) execFile('open', ['-a', appPath], () => {})
          resolve(true)
        })
      })
    },
  },

  captureScreen(path, signal) {
    return new Promise<boolean>((resolve, reject) => {
      execFile('/usr/sbin/screencapture', ['-i', path], { timeout: 120_000, signal }, (error) => {
        if (error) reject(error)
        // A cancelled selection writes no file.
        else resolve(existsSync(path))
      })
    })
  },
}
