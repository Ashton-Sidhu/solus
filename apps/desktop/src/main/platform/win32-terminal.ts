/**
 * "Open in terminal" on Windows (docs/plans/windows.md §5.12). Windows has no
 * tmux, so each request opens its own window: a Windows Terminal tab when it is
 * installed, else a PowerShell console. The command runs in PowerShell, which
 * reads the single-quoted arguments the callers write.
 */

/** The Windows programs a launch can use; null when one is not installed. */
export interface WindowsTerminalPrograms {
  windowsTerminal: string | null
  /** PowerShell 7 (`pwsh.exe`) when installed, else Windows PowerShell. */
  powershell: string
}

export interface WindowsTerminalLaunch {
  file: string
  args: string[]
  /** What the clients call the terminal. */
  name: 'Windows Terminal' | 'PowerShell'
}

/** The program and arguments that open `command` in `cwd`. An empty command opens a shell. */
export function windowsTerminalLaunch(programs: WindowsTerminalPrograms, command: string, cwd: string | undefined): WindowsTerminalLaunch {
  const shellArgs = command ? ['-NoExit', '-Command', command] : ['-NoExit']
  if (programs.windowsTerminal) {
    const args = cwd ? ['-d', cwd] : []
    // Windows Terminal splits its own command line at `;`, whatever the quoting.
    args.push(programs.powershell, ...shellArgs.map((arg) => arg.replace(/;/g, '\\;')))
    return { file: programs.windowsTerminal, args, name: 'Windows Terminal' }
  }
  return { file: programs.powershell, args: shellArgs, name: 'PowerShell' }
}
