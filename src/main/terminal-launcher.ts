import { execFileSync } from 'child_process'
import { createLogger } from './logger'
import type { TerminalLaunchRequest, TerminalAppId } from '../shared/types'
import { getCliEnv } from './cli-env'

const log = createLogger('terminal-launcher', 'terminal-launcher.ts')

const TMUX_SESSION_NAME = 'solus'

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

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

function runAppleScript(script: string): boolean {
  try {
    execFileSync('/usr/bin/osascript', ['-e', script], { timeout: 5000, env: getCliEnv() })
    return true
  } catch (err) {
    log.error('applescript_failed', { error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

function launchInDefaultTerminal(command: string, cwd?: string): boolean {
  if (process.platform === 'darwin') {
    const cdPrefix = cwd ? `cd \\"${escapeForAppleScript(cwd)}\\" && ` : ''
    const fullCmd = `${cdPrefix}${escapeForAppleScript(command)}`
    return runAppleScript(`tell application "Terminal"
  activate
  do script "${fullCmd}"
end tell`)
  }

  return launchOnLinux(command, 'default-terminal', cwd)
}

function launchInGhostty(command: string, cwd?: string): boolean {
  if (process.platform === 'darwin') {
    try {
      const fullCmd = cwd ? `cd "${cwd}" && ${command}` : command
      const args = ['-na', 'Ghostty.app', '--args', '-e', '/bin/zsh', '-c', fullCmd]
      execFileSync('open', args, { timeout: 5000, env: getCliEnv() })
      return true
    } catch (err) {
      log.error('ghostty_launch_failed', { error: err instanceof Error ? err.message : String(err) })
      return false
    }
  }

  return launchOnLinux(command, 'ghostty', cwd)
}

function launchOnLinux(command: string, terminalId: TerminalAppId, cwd?: string): boolean {
  try {
    if (terminalId === 'ghostty') {
      const args = ['-e', command]
      if (cwd) args.unshift(`--working-directory=${cwd}`)
      execFileSync('ghostty', args, { timeout: 5000, env: getCliEnv() })
    } else {
      const args = cwd ? ['--working-directory', cwd, '-e', command] : ['-e', command]
      execFileSync('x-terminal-emulator', args, { timeout: 5000, env: getCliEnv() })
    }
    return true
  } catch (err) {
    log.error('linux_terminal_launch_failed', { error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

const LAUNCHERS = {
  'default-terminal': launchInDefaultTerminal,
  'ghostty': launchInGhostty,
} satisfies Record<TerminalAppId, (command: string, cwd?: string) => boolean>

export function launchInTerminal(request: TerminalLaunchRequest): boolean {
  const { command, terminalId, cwd } = request
  log.info('terminal_launch', { terminalId, command })

  const launcher = LAUNCHERS[terminalId]
  if (!launcher) {
    log.warn('unknown_terminal', { terminalId })
    return false
  }

  if (!createTmuxWindow(command, cwd)) return false

  const launched = launcher(`exec tmux attach-session -t ${TMUX_SESSION_NAME}`)
  if (!launched) {
    log.warn('terminal_launch_returned_false', { terminalId, command, cwd })
  }
  return launched
}
