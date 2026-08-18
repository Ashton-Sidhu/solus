import type { TerminalAppId } from '../shared/types'

/**
 * The terminals Solus can open and drive. An entry earns its place only if the
 * app can be told to run one command on launch — the fallback always has to come
 * up already attached to the shared tmux session, so a terminal that ignores a
 * startup command would strand the user in an unrelated shell.
 *
 * Warp is the notable absence: it deliberately exposes no way to run a command
 * from the command line. A Warp user is still served by the reuse path, which
 * needs no cooperation from the app.
 */
export interface TerminalApp {
  id: TerminalAppId
  name: string
  /** Application bundle probed on macOS. Absent means "always available". */
  macAppBundle?: string
  /** Arguments after `open -na <bundle> --args`, running `command` on launch. */
  macOpenArgs?: (command: string) => string[]
  /** Used instead of `macOpenArgs` when the app only takes a command by script. */
  macAppleScript?: (command: string) => string
  /** Executable probed with `which` and run on Linux. */
  linuxBin: string
  linuxArgs: (command: string) => string[]
}

/** Every launcher runs the command through a shell so one argument stays one
 *  argument, whatever the terminal does with the rest of its command line. */
const macShell = (command: string): string[] => ['/bin/zsh', '-c', command]
const linuxShell = (command: string): string[] => ['/bin/sh', '-c', command]

export const TERMINAL_APPS: TerminalApp[] = [
  {
    id: 'default-terminal',
    name: 'Default Terminal',
    macAppleScript: (command) => `tell application "Terminal"
  activate
  do script "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
end tell`,
    linuxBin: 'x-terminal-emulator',
    linuxArgs: (command) => ['-e', ...linuxShell(command)],
  },
  {
    id: 'ghostty',
    name: 'Ghostty',
    macAppBundle: 'Ghostty.app',
    macOpenArgs: (command) => ['-e', ...macShell(command)],
    linuxBin: 'ghostty',
    linuxArgs: (command) => ['-e', ...linuxShell(command)],
  },
  {
    id: 'iterm2',
    name: 'iTerm',
    macAppBundle: 'iTerm.app',
    macAppleScript: (command) => `tell application "iTerm"
  activate
  create window with default profile command "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
end tell`,
    // iTerm2 is macOS only; the probe below never finds this binary elsewhere.
    linuxBin: 'iterm2',
    linuxArgs: (command) => ['-e', ...linuxShell(command)],
  },
  {
    id: 'wezterm',
    name: 'WezTerm',
    macAppBundle: 'WezTerm.app',
    macOpenArgs: (command) => ['start', '--', ...macShell(command)],
    linuxBin: 'wezterm',
    linuxArgs: (command) => ['start', '--', ...linuxShell(command)],
  },
  {
    id: 'kitty',
    name: 'kitty',
    macAppBundle: 'kitty.app',
    // kitty takes the program to run as its trailing arguments, with no flag.
    macOpenArgs: (command) => macShell(command),
    linuxBin: 'kitty',
    linuxArgs: (command) => linuxShell(command),
  },
  {
    id: 'alacritty',
    name: 'Alacritty',
    macAppBundle: 'Alacritty.app',
    macOpenArgs: (command) => ['-e', ...macShell(command)],
    linuxBin: 'alacritty',
    linuxArgs: (command) => ['-e', ...linuxShell(command)],
  },
]

export function terminalApp(id: TerminalAppId): TerminalApp | undefined {
  return TERMINAL_APPS.find((app) => app.id === id)
}
