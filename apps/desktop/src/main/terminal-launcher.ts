import { execFile, execFileSync } from 'child_process'
import { basename } from 'path'
import { createLogger } from '@solus/server/logger'
import type { ResolvedTerminal, TerminalAppId, TerminalLaunchRequest } from '@solus/contracts/types'
import { hostCliEnv, warmCliPath } from '@solus/server/cli-env'
import { TERMINAL_APPS, terminalApp, type TerminalApp } from '@solus/desktop-main/terminal-apps'
import { findAppBundle } from '@solus/desktop-main/mac-apps'

const log = createLogger('terminal-launcher', 'terminal-launcher.ts')

const TMUX_SESSION_NAME = 'solus'
const ATTACH_COMMAND = `exec tmux attach-session -t ${TMUX_SESSION_NAME}`

function createTmuxWindow(command: string, cwd?: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', TMUX_SESSION_NAME], {
      env: hostCliEnv(),
      timeout: 2000,
      stdio: 'ignore',
    })
  } catch {
    try {
      const args = ['new-session', '-d', '-s', TMUX_SESSION_NAME]
      if (cwd) args.push('-c', cwd)
      args.push(command)
      execFileSync('tmux', args, { env: hostCliEnv(), timeout: 5000 })
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
    execFileSync('tmux', args, { env: hostCliEnv(), timeout: 5000 })
    log.info('tmux_window_opened', { sessionName: TMUX_SESSION_NAME, command, cwd })
    return true
  } catch (err) {
    log.error('tmux_new_window_failed', { error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/** A short read-only probe. Join PATH warmup before using the CLI environment
 *  so a first inspection cannot start a second, synchronous login-shell probe. */
async function probeOutput(file: string, args: string[], timeout: number): Promise<string | null> {
  await warmCliPath()
  return new Promise((resolve) => {
    execFile(file, args, { env: hostCliEnv(), timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      resolve(error ? null : stdout)
    })
  })
}

/**
 * Process ids of the tmux clients already attached to the shared session. An
 * empty list is the only reliable signal that nothing can show the new window.
 */
async function attachedClientPids(): Promise<number[]> {
  const output = await probeOutput('tmux', ['list-clients', '-t', TMUX_SESSION_NAME, '-F', '#{client_pid}'], 2000)
  if (output === null) return []
  return output
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

/** Read the process tree once for all attached clients. Starting a separate
 *  `ps` for each parent made terminal inspection slow on deep shell trees. */
async function attachedTerminalBundle(clientPids: readonly number[]): Promise<string | null> {
  if (process.platform !== 'darwin') return null
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

/**
 * Which terminal "Open in terminal" will actually use. The clients read this to
 * name and badge the action, so it answers with what will happen rather than
 * with what is configured.
 */
export async function resolveTerminal(fallbackTerminalId: TerminalAppId): Promise<ResolvedTerminal> {
  const startedAt = performance.now()
  const clientPids = await attachedClientPids()
  if (clientPids.length > 0) {
    const bundle = await attachedTerminalBundle(clientPids)
    // Basename minus `.app` is the app's own display name, which covers the
    // terminals Solus cannot launch itself — Warp attaches like any other.
    const known = bundle
      ? TERMINAL_APPS.find((app) => app.macAppBundle === basename(bundle))
      : undefined
    const resolved: ResolvedTerminal = {
      id: known?.id ?? null,
      name: bundle ? basename(bundle, '.app') : 'Attached terminal',
      source: 'attached',
    }
    log.info('terminal_resolved', { terminalId: resolved.id, source: resolved.source, durationMs: performance.now() - startedAt })
    return resolved
  }

  const app = terminalApp(fallbackTerminalId)
  const resolved: ResolvedTerminal = {
    id: app?.id ?? null,
    name: app ? terminalDisplayName(app) : 'Terminal',
    source: 'fallback',
  }
  log.info('terminal_resolved', { terminalId: resolved.id, source: resolved.source, durationMs: performance.now() - startedAt })
  return resolved
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
async function useAttachedTerminal(): Promise<boolean> {
  const clientPids = await attachedClientPids()
  if (clientPids.length === 0) return false

  const bundle = await attachedTerminalBundle(clientPids)
  if (bundle) {
    try {
      execFileSync('open', [bundle], { timeout: 5000, env: hostCliEnv() })
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
          env: hostCliEnv(),
        })
      } else if (app.macOpenArgs && app.macAppBundle) {
        const bundle = findAppBundle(app.macAppBundle) ?? app.macAppBundle
        execFileSync('open', ['-na', bundle, '--args', ...app.macOpenArgs(ATTACH_COMMAND)], {
          timeout: 5000,
          env: hostCliEnv(),
        })
      } else {
        log.warn('terminal_app_not_launchable', { terminalId: app.id })
        return false
      }
    } else {
      execFileSync(app.linuxBin, app.linuxArgs(ATTACH_COMMAND), { timeout: 5000, env: hostCliEnv() })
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
export async function launchInTerminal(request: TerminalLaunchRequest): Promise<boolean> {
  const { command, fallbackTerminalId, cwd } = request
  log.info('terminal_launch', { fallbackTerminalId, command })

  if (!createTmuxWindow(command, cwd)) return false
  if (await useAttachedTerminal()) return true

  const app = terminalApp(fallbackTerminalId)
  if (!app) {
    log.warn('unknown_terminal', { fallbackTerminalId })
    return false
  }
  return launchTerminalApp(app)
}
