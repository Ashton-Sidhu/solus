import { spawn } from 'child_process'
import { hostCliEnv } from '@solus/server/cli-env'
import { createLogger } from '@solus/server/logger'
import { TERMINAL_APPS, terminalApp, type TerminalApp } from '@solus/desktop-main/terminal-apps'
import { probeOutput, type TerminalApps } from '@solus/desktop-main/terminal-launcher'

const log = createLogger('terminal-launcher', 'linux-terminal.ts')

/** Terminal apps on Linux: found on PATH, started as a detached process. */
export const linuxTerminalApps: TerminalApps = {
  // A Linux process tree names no app bundle, so an attached client is shown
  // where it is and named generically.
  attachedApp: async () => null,

  /** Resolve the default role from installed terminals; explicit choices stay explicit. */
  async available(id) {
    const candidates = id === 'default-terminal' ? TERMINAL_APPS : [terminalApp(id)].filter((app): app is TerminalApp => !!app)
    for (const app of candidates) {
      if (await probeOutput('/usr/bin/which', [app.linuxBin], 2000)) return app
    }
    return undefined
  },

  /** Answers when the terminal starts; it keeps running after Solus is done with it. */
  start(app, command) {
    return new Promise<boolean>((resolve) => {
      const child = spawn(app.linuxBin, app.linuxArgs(command), { detached: true, stdio: 'ignore', env: hostCliEnv() })
      child.once('error', (error) => {
        log.error('fallback_terminal_launch_failed', { terminalId: app.id, error: error.message })
        resolve(false)
      })
      child.once('spawn', () => { child.unref(); resolve(true) })
    })
  },

  displayName: (app) => app.name,
}
