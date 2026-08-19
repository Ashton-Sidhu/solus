import { execFileSync } from 'child_process'
import { basename } from 'path'
import { createLogger } from '@solus/server/logger'
import type { ResolvedTerminal, TerminalAppId, TerminalLaunchRequest } from '@solus/contracts/types'
import { getCliEnv } from '@solus/server/cli-env'
import { TERMINAL_APPS, terminalApp, type TerminalApp } from '@solus/desktop-main/terminal-apps'
import { findAppBundle } from '@solus/desktop-main/mac-apps'

const log = createLogger('terminal-launcher', 'terminal-launcher.ts')

const TMUX_SESSION_NAME = 'solus'
const ATTACH_COMMAND = `exec tmux attach-session -t ${TMUX_SESSION_NAME}`

function createTmuxWindow(command: string, cwd?: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', TMUX_SESSION_NAME], {
      env: getCliEnv(),
      timeout: 2000,
      stdio: 'ignore',
    })
  } catch {
    try {
      const args = ['new-session', '-d', '-s', TMUX_SESSION_NAME]
      if (cwd) args.push('-c', cwd)
      args.push(command)
      execFileSync('tmux', args, { env: getCliEnv(), timeout: 5000 })
      log.info('tmux_session_created', { sessionName: TMUX_SESSION_NAME, command, cwd })
      return true
    } catch (createErr) {
      log.error('tmux_session_create_failed', {
        error: createErr instanceof Error ? createErr.message : String(createErr),
      })
      return false
    }
  }

  try {
    const args = ['new-window', '-t', TMUX_SESSION_NAME]
    if (cwd) args.push('-c', cwd)
    args.push(command)
    execFileSync('tmux', args, { env: getCliEnv(), timeout: 5000 })
    log.info('tmux_window_opened', { sessionName: TMUX_SESSION_NAME, command, cwd })
    return true
  } catch (err) {
    log.error('tmux_new_window_failed', { error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/**
 * Process ids of the tmux clients already attached to the shared session. An
 * empty list is the only reliable signal that nothing can show the new window.
 */
function attachedClientPids(): number[] {
  try {
    const output = execFileSync(
      'tmux',
      ['list-clients', '-t', TMUX_SESSION_NAME, '-F', '#{client_pid}'],
      { env: getCliEnv(), timeout: 2000, encoding: 'utf8' },
    )
    return output
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

/**
 * Walks the parent chain of a tmux client up to the application bundle that
 * draws its window, so any terminal the user already runs can be raised —
 * not only the two Solus knows how to launch.
 */
function appBundleForPid(pid: number): string | null {
  let current = pid
  for (let depth = 0; depth < 12 && current > 1; depth++) {
    let line: string
    try {
      line = execFileSync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(current)], {
        timeout: 2000,
        encoding: 'utf8',
      }).trim()
    } catch {
      return null
    }
    const parsed = /^(\d+)\s+(.+)$/.exec(line)
    if (!parsed) return null
    const bundle = /^(.*?\.app)\//.exec(parsed[2])
    if (bundle) return bundle[1]
    current = Number(parsed[1])
  }
  return null
}

/** The application bundle of the first attached client we can identify. */
function attachedTerminalBundle(): string | null {
  if (process.platform !== 'darwin') return null
  for (const clientPid of attachedClientPids()) {
    const bundle = appBundleForPid(clientPid)
    if (bundle) return bundle
  }
  return null
}

/**
 * Which terminal "Open in terminal" will actually use. The clients read this to
 * name and badge the action, so it answers with what will happen rather than
 * with what is configured.
 */
export function resolveTerminal(fallbackTerminalId: TerminalAppId): ResolvedTerminal {
  if (attachedClientPids().length > 0) {
    const bundle = attachedTerminalBundle()
    // Basename minus `.app` is the app's own display name, which covers the
    // terminals Solus cannot launch itself — Warp attaches like any other.
    const known = bundle
      ? TERMINAL_APPS.find((app) => app.macAppBundle === basename(bundle))
      : undefined
    return {
      id: known?.id ?? null,
      name: bundle ? basename(bundle, '.app') : 'Attached terminal',
      source: 'attached',
    }
  }

  const app = terminalApp(fallbackTerminalId)
  return {
    id: app?.id ?? null,
    name: app ? terminalDisplayName(app) : 'Terminal',
    source: 'fallback',
  }
}

/** "Default Terminal" is a role; on macOS the app has a name of its own. */
export function terminalDisplayName(app: TerminalApp): string {
  return process.platform === 'darwin' && app.id === 'default-terminal' ? 'Terminal' : app.name
}

/**
 * Raises the terminal that already holds the shared session. Returns false only
 * when no client is attached, because a second client would fight the first one
 * over the session's size — the long-standing "open in terminal" breakage.
 */
function useAttachedTerminal(): boolean {
  const clientPids = attachedClientPids()
  if (clientPids.length === 0) return false

  const bundle = attachedTerminalBundle()
  if (bundle) {
    try {
      execFileSync('open', [bundle], { timeout: 5000, env: getCliEnv() })
      log.info('attached_terminal_raised', { bundle })
    } catch (err) {
      log.warn('attached_terminal_raise_failed', {
        bundle,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  log.info('attached_terminal_reused', { clients: clientPids.length })
  return true
}

/** Starts the fallback terminal already attached to the shared session. */
function launchTerminalApp(app: TerminalApp): boolean {
  try {
    if (process.platform === 'darwin') {
      if (app.macAppleScript) {
        execFileSync('/usr/bin/osascript', ['-e', app.macAppleScript(ATTACH_COMMAND)], {
          timeout: 5000,
          env: getCliEnv(),
        })
      } else if (app.macOpenArgs && app.macAppBundle) {
        const bundle = findAppBundle(app.macAppBundle) ?? app.macAppBundle
        execFileSync('open', ['-na', bundle, '--args', ...app.macOpenArgs(ATTACH_COMMAND)], {
          timeout: 5000,
          env: getCliEnv(),
        })
      } else {
        log.warn('terminal_app_not_launchable', { terminalId: app.id })
        return false
      }
    } else {
      execFileSync(app.linuxBin, app.linuxArgs(ATTACH_COMMAND), { timeout: 5000, env: getCliEnv() })
    }
    return true
  } catch (err) {
    log.error('fallback_terminal_launch_failed', {
      terminalId: app.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Opens a window in the shared tmux session, then shows it wherever the user is
 * already working: an attached terminal is raised, and only an unattached
 * session falls back to launching the terminal chosen in Settings.
 */
export function launchInTerminal(request: TerminalLaunchRequest): boolean {
  const { command, fallbackTerminalId, cwd } = request
  log.info('terminal_launch', { fallbackTerminalId, command })

  if (!createTmuxWindow(command, cwd)) return false
  if (useAttachedTerminal()) return true

  const app = terminalApp(fallbackTerminalId)
  if (!app) {
    log.warn('unknown_terminal', { fallbackTerminalId })
    return false
  }
  return launchTerminalApp(app)
}
