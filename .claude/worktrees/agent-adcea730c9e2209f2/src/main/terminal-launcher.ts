import { execFileSync, execFile } from 'child_process'
import { createLogger } from './logger'
import type { TerminalLaunchRequest, TerminalAppId } from '../shared/types'
import { getCliEnv } from './cli-env'

const log = createLogger('terminal-launcher', 'terminal-launcher.ts')

interface TmuxLaunchResult {
  sessionName: string
  clientTty: string | null
}

const TERMINAL_PROCESS_NAMES: Record<TerminalAppId, string> = {
  'default-terminal': 'Terminal',
  'ghostty': 'Ghostty',
}

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function tryTmux(command: string, cwd?: string): TmuxLaunchResult | null {
  try {
    const sessionName = getAttachedTmuxSession()
    if (!sessionName) return null

    const clientTty = getTmuxClientTty(sessionName)
    const targetWindow = getHighestTmuxWindowTarget(sessionName)
    const fullCmd = cwd ? `cd "${cwd}" && ${command}` : command
    const args = ['new-window', '-a', '-t', targetWindow ?? sessionName]
    if (cwd) args.push('-c', cwd)
    args.push(fullCmd)
    execFileSync('tmux', args, { env: getCliEnv(), timeout: 5000 })
    log.info(`Opened tmux window in session "${sessionName}": ${fullCmd}`)

    return { sessionName, clientTty }
  } catch (err) {
    log.error(`tmux new-window failed; falling back to configured terminal: ${err}`)
    return null
  }
}

function getAttachedTmuxSession(): string | null {
  try {
    const session = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_attached}'], {
      env: getCliEnv(),
      encoding: 'utf8',
      timeout: 2000,
    }).trim().split('\n').find((line) => {
      const [, attached] = line.split('\t')
      return Number(attached) > 0
    })?.split('\t')[0]
    return session || null
  } catch (err) {
    log.error(`tmux list-sessions failed: ${err}`)
    return null
  }
}

function getHighestTmuxWindowTarget(sessionName: string): string | null {
  try {
    const highestWindowIndex = execFileSync('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_index}'], {
      env: getCliEnv(),
      encoding: 'utf8',
      timeout: 2000,
    }).trim().split('\n').reduce<number | null>((highest, index) => {
      const parsed = Number(index)
      if (!Number.isInteger(parsed)) return highest
      return highest === null || parsed > highest ? parsed : highest
    }, null)
    return highestWindowIndex === null ? null : `${sessionName}:${highestWindowIndex}`
  } catch (err) {
    log.error(`tmux list-windows failed for session "${sessionName}": ${err}`)
    return null
  }
}

function runAppleScript(script: string): boolean {
  try {
    execFileSync('/usr/bin/osascript', ['-e', script], { timeout: 5000, env: getCliEnv() })
    return true
  } catch (err) {
    log.error(`AppleScript failed: ${err}`)
    return false
  }
}

function runAppleScriptAsync(script: string): void {
  execFile('/usr/bin/osascript', ['-e', script], { env: getCliEnv() }, (err) => {
    if (err) log.error(`AppleScript failed: ${err}`)
  })
}

function getTmuxClientTty(sessionName: string): string | null {
  try {
    const tty = execFileSync('tmux', ['list-clients', '-t', sessionName, '-F', '#{client_tty}'], {
      env: getCliEnv(),
      encoding: 'utf8',
      timeout: 2000,
    }).trim().split('\n').find(Boolean)
    return tty || null
  } catch (err) {
    log.error(`tmux list-clients failed for session "${sessionName}": ${err}`)
    return null
  }
}

function focusRunningTerminalProcess(terminalId: TerminalAppId): void {
  if (process.platform !== 'darwin') return
  const processName = TERMINAL_PROCESS_NAMES[terminalId]
  if (!processName) return

  runAppleScriptAsync(`tell application "System Events"
  if exists process "${escapeForAppleScript(processName)}" then
    set frontmost of process "${escapeForAppleScript(processName)}" to true
  end if
end tell`)
}

function focusTerminalTabByTty(tty: string): void {
  if (process.platform !== 'darwin') return
  const escapedTty = escapeForAppleScript(tty)

  runAppleScriptAsync(`tell application "System Events"
  if not (exists process "Terminal") then return
end tell
tell application "Terminal"
  repeat with terminalWindow in windows
    repeat with terminalTab in tabs of terminalWindow
      if tty of terminalTab is "${escapedTty}" then
        set selected tab of terminalWindow to terminalTab
        set index of terminalWindow to 1
        tell application "System Events" to set frontmost of process "Terminal" to true
        return
      end if
    end repeat
  end repeat
end tell`)
}

function focusTmuxTerminal(result: TmuxLaunchResult, terminalId: TerminalAppId): void {
  if (result.clientTty) focusTerminalTabByTty(result.clientTty)
  else focusRunningTerminalProcess(terminalId)
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
      log.error(`Ghostty launch failed: ${err}`)
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
    log.error(`Linux terminal launch failed: ${err}`)
    return false
  }
}

const LAUNCHERS: Record<TerminalAppId, (command: string, cwd?: string) => boolean> = {
  'default-terminal': launchInDefaultTerminal,
  'ghostty': launchInGhostty,
}

export function launchInTerminal(request: TerminalLaunchRequest): boolean {
  const { command, terminalId, cwd } = request
  log.info(`Launching in ${terminalId}: ${command}`)

  const tmuxResult = tryTmux(command, cwd)
  if (tmuxResult) {
    focusTmuxTerminal(tmuxResult, terminalId)
    return true
  }

  const launcher = LAUNCHERS[terminalId]
  if (!launcher) {
    log.warn(`Unknown terminal: ${terminalId}`)
    return false
  }

  const launched = launcher(command, cwd)
  if (!launched) {
    log.warn('Terminal launch returned false', { terminalId, command, cwd })
  }
  return launched
}
