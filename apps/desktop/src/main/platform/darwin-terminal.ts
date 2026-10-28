import { execFileSync } from 'child_process'
import { basename } from 'path'
import { hostCliEnv } from '@solus/server/cli-env'
import { createLogger } from '@solus/server/logger'
import { findAppBundle } from '@solus/desktop-main/mac-apps'
import { TERMINAL_APPS, terminalApp } from '@solus/desktop-main/terminal-apps'
import { probeOutput, type TerminalApps } from '@solus/desktop-main/terminal-launcher'

const log = createLogger('terminal-launcher', 'darwin-terminal.ts')

/** Read the process tree once for all attached clients, and walk up to the
 *  `.app` bundle that draws one. Starting a separate `ps` for each parent made
 *  terminal inspection slow on deep shell trees. */
async function attachedBundle(clientPids: readonly number[]): Promise<string | null> {
  const output = await probeOutput('/bin/ps', ['-axo', 'pid=,ppid=,comm='], 2000)
  if (output === null) return null
  const processes = new Map<number, { parentPid: number; command: string }>()
  for (const line of output.split('\n')) {
    const parsed = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    if (parsed) processes.set(Number(parsed[1]), { parentPid: Number(parsed[2]), command: parsed[3] })
  }
  for (const clientPid of clientPids) {
    let current = clientPid
    for (let depth = 0; depth < 12 && current > 1; depth++) {
      const process = processes.get(current)
      if (!process) break
      const bundle = /^(.*?\.app)\//.exec(process.command)
      if (bundle) return bundle[1]
      current = process.parentPid
    }
  }
  return null
}

/** Terminal apps on macOS: found by bundle, started with `open` or AppleScript. */
export const macTerminalApps: TerminalApps = {
  async attachedApp(clientPids) {
    const bundle = await attachedBundle(clientPids)
    if (!bundle) return null
    // Basename minus `.app` is the app's own display name, which covers the
    // terminals Solus cannot launch itself — Warp attaches like any other.
    return {
      name: basename(bundle, '.app'),
      id: TERMINAL_APPS.find((app) => app.macAppBundle === basename(bundle))?.id ?? null,
      raise() {
        try {
          execFileSync('open', [bundle], { timeout: 5000, env: hostCliEnv() })
          log.info('attached_terminal_raised', { bundle })
        } catch (err) {
          log.warn('attached_terminal_raise_failed', { bundle, error: err instanceof Error ? err.message : String(err) })
        }
      },
    }
  },

  // Settings lists only installed apps, and the system terminal is always there.
  available: async (id) => terminalApp(id),

  async start(app, command) {
    try {
      if (app.macAppleScript) {
        execFileSync('/usr/bin/osascript', ['-e', app.macAppleScript(command)], { timeout: 5000, env: hostCliEnv() })
      } else if (app.macOpenArgs && app.macAppBundle) {
        const bundle = findAppBundle(app.macAppBundle) ?? app.macAppBundle
        execFileSync('open', ['-na', bundle, '--args', ...app.macOpenArgs(command)], { timeout: 5000, env: hostCliEnv() })
      } else {
        log.warn('terminal_app_not_launchable', { terminalId: app.id })
        return false
      }
      return true
    } catch (err) {
      log.error('fallback_terminal_launch_failed', { terminalId: app.id, error: err instanceof Error ? err.message : String(err) })
      return false
    }
  },

  // "Default Terminal" is a role; on macOS the app has a name of its own.
  displayName: (app) => (app.id === 'default-terminal' ? 'Terminal' : app.name),
}
