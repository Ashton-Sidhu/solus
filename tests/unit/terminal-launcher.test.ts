import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

type ExecCall = { file: string; args: string[] }

const execCalls: ExecCall[] = []
let hasSession = true
let failSessionCreation = false
/** tmux clients attached to the shared session, as `[clientPid, ...]`. */
let attachedClientPids: number[] = []
/** `pid -> "<ppid> <comm>"`, the process tree `ps` reports for those clients. */
let processTree: Record<number, string> = {}

const execFileSync = mock((file: string, args: string[]) => {
  execCalls.push({ file, args })
  if (file === 'tmux' && args[0] === 'has-session' && !hasSession) throw new Error('no session')
  if (file === 'tmux' && args[0] === 'new-session' && failSessionCreation) throw new Error('tmux unavailable')
  if (file === 'tmux' && args[0] === 'list-clients') return attachedClientPids.join('\n')
  if (file === '/bin/ps') {
    const line = processTree[Number(args.at(-1))]
    if (!line) throw new Error('no such process')
    return line
  }
  return Buffer.from('')
})

mock.module('child_process', () => ({ execFileSync }))
mock.module('@solus/server/cli-env', () => ({ getCliEnv: () => ({ PATH: '/usr/bin:/bin' }) }))
mock.module('@solus/server/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {} }),
}))
// Stands in for the filesystem probe, so a launch asserts one fixed bundle path.
mock.module('@solus/desktop-main/mac-apps', () => ({
  findAppBundle: (bundleName: string) => `/Applications/${bundleName}`,
}))

let launchInTerminal: typeof import('@solus/desktop-main/terminal-launcher')['launchInTerminal']
let resolveTerminal: typeof import('@solus/desktop-main/terminal-launcher')['resolveTerminal']

beforeAll(async () => {
  ;({ launchInTerminal, resolveTerminal } = await import('@solus/desktop-main/terminal-launcher'))
})

beforeEach(() => {
  execCalls.length = 0
  hasSession = true
  failSessionCreation = false
  attachedClientPids = []
  processTree = {}
})

const ATTACH_COMMAND = 'exec tmux attach-session -t solus'

function expectFallbackTerminalAttached(): void {
  const terminalCall = execCalls.at(-1)
  if (process.platform === 'darwin') {
    expect(terminalCall).toEqual({
      file: 'open',
      args: ['-na', '/Applications/Ghostty.app', '--args', '-e', '/bin/zsh', '-c', ATTACH_COMMAND],
    })
  } else {
    expect(terminalCall).toEqual({ file: 'ghostty', args: ['-e', '/bin/sh', '-c', ATTACH_COMMAND] })
  }
}

describe('launchInTerminal', () => {
  test('opens a window in the shared session and falls back to the configured terminal when nothing is attached', () => {
    // WHY: with no attached client the tmux window is invisible until some terminal attaches to it.
    const launched = launchInTerminal({ command: 'bun run dev', fallbackTerminalId: 'ghostty', cwd: '/tmp/project' })

    expect(launched).toBe(true)
    expect(execCalls.slice(0, 2)).toEqual([
      { file: 'tmux', args: ['has-session', '-t', 'solus'] },
      { file: 'tmux', args: ['new-window', '-t', 'solus', '-c', '/tmp/project', 'bun run dev'] },
    ])
    expectFallbackTerminalAttached()
  })

  test('creates the shared session before falling back when it does not exist', () => {
    hasSession = false

    const launched = launchInTerminal({ command: 'exec /bin/zsh -l', fallbackTerminalId: 'ghostty', cwd: '/tmp/project' })

    expect(launched).toBe(true)
    expect(execCalls.slice(0, 2)).toEqual([
      { file: 'tmux', args: ['has-session', '-t', 'solus'] },
      {
        file: 'tmux',
        args: ['new-session', '-d', '-s', 'solus', '-c', '/tmp/project', 'exec /bin/zsh -l'],
      },
    ])
    expectFallbackTerminalAttached()
  })

  test('attaches Apple Terminal or the system terminal when it is the configured fallback', () => {
    const launched = launchInTerminal({ command: 'pwd', fallbackTerminalId: 'default-terminal', cwd: '/tmp/project' })

    expect(launched).toBe(true)
    const terminalCall = execCalls.at(-1)
    if (process.platform === 'darwin') {
      expect(terminalCall?.file).toBe('/usr/bin/osascript')
      expect(terminalCall?.args.join('\n')).toContain(`do script "${ATTACH_COMMAND}"`)
    } else {
      expect(terminalCall).toEqual({
        file: 'x-terminal-emulator',
        args: ['-e', '/bin/sh', '-c', ATTACH_COMMAND],
      })
    }
  })

  test.each([
    ['iterm2' as const],
    ['wezterm' as const],
    ['kitty' as const],
    ['alacritty' as const],
  ])('launches %s already attached to the shared session', (fallbackTerminalId) => {
    // WHY: a fallback that comes up in a plain shell leaves the user staring at
    // the wrong window while their agent runs in a session they cannot see.
    const launched = launchInTerminal({ command: 'pwd', fallbackTerminalId, cwd: '/tmp/project' })

    expect(launched).toBe(true)
    const terminalCall = execCalls.at(-1)
    expect(terminalCall?.args.join(' ')).toContain(ATTACH_COMMAND)
  })

  test('reuses a terminal that already holds the session instead of launching another one', () => {
    // WHY: a second client fights the first over the session size, which is what
    // made every "Open in terminal" pile up unusable windows.
    attachedClientPids = [4242]
    processTree = {
      4242: '4200 /usr/local/bin/tmux',
      4200: '1 /Applications/WezTerm.app/Contents/MacOS/wezterm-gui',
    }

    const launched = launchInTerminal({ command: 'pwd', fallbackTerminalId: 'ghostty', cwd: '/tmp/project' })

    expect(launched).toBe(true)
    expect(execCalls.some((call) => call.args.includes('/Applications/Ghostty.app'))).toBe(false)
    expect(execCalls.some((call) => call.file === '/usr/bin/osascript')).toBe(false)
    if (process.platform === 'darwin') {
      // The detected terminal is raised whatever it is, not only the two Solus can launch.
      expect(execCalls.at(-1)).toEqual({ file: 'open', args: ['/Applications/WezTerm.app'] })
    }
  })

  test('still reuses an attached terminal whose application cannot be identified', () => {
    // WHY: an ssh or non-bundle client is still a live view of the session; a
    // fallback launch would attach a competing second client.
    attachedClientPids = [7]
    processTree = { 7: '1 /usr/bin/tmux' }

    const launched = launchInTerminal({ command: 'pwd', fallbackTerminalId: 'ghostty', cwd: '/tmp/project' })

    expect(launched).toBe(true)
    expect(execCalls.some((call) => call.args.includes('/Applications/Ghostty.app'))).toBe(false)
  })

  test('does not report success when the tmux session cannot be created', () => {
    hasSession = false
    failSessionCreation = true

    const launched = launchInTerminal({ command: 'pwd', fallbackTerminalId: 'ghostty', cwd: '/tmp/project' })

    expect(launched).toBe(false)
    expect(execCalls).toHaveLength(2)
  })
})

describe('resolveTerminal', () => {
  test('names the terminal already attached to the shared session', () => {
    // WHY: the clients badge the action with this. Naming the configured
    // fallback while a different terminal holds the session is the stale label
    // that sent users looking in the wrong window.
    attachedClientPids = [4242]
    processTree = {
      4242: '4200 /usr/local/bin/tmux',
      4200: '1 /Applications/WezTerm.app/Contents/MacOS/wezterm-gui',
    }

    const resolved = resolveTerminal('ghostty')

    if (process.platform === 'darwin') {
      expect(resolved).toEqual({ id: 'wezterm', name: 'WezTerm', source: 'attached' })
    } else {
      expect(resolved.source).toBe('attached')
    }
  })

  test('names a terminal it can see but cannot launch', () => {
    // WHY: Warp runs no startup command so it is not in the catalog, but a Warp
    // user with the session already open should still see their own terminal.
    attachedClientPids = [99]
    processTree = { 99: '90 /usr/local/bin/tmux', 90: '1 /Applications/Warp.app/Contents/MacOS/stable' }

    const resolved = resolveTerminal('ghostty')

    expect(resolved.source).toBe('attached')
    if (process.platform === 'darwin') {
      // Solus cannot launch Warp, but it can show the user their own terminal.
      expect(resolved.id).toBeNull()
      expect(resolved.name).toBe('Warp')
    }
  })

  test('falls back to the configured terminal when nothing is attached', () => {
    const resolved = resolveTerminal('ghostty')

    expect(resolved.id).toBe('ghostty')
    expect(resolved.name).toBe('Ghostty')
    expect(resolved.source).toBe('fallback')
  })

  test('calls the system terminal by its own name on macOS', () => {
    // WHY: "Default Terminal" is a role, not what the user sees in their Dock.
    const resolved = resolveTerminal('default-terminal')

    expect(resolved.name).toBe(process.platform === 'darwin' ? 'Terminal' : 'Default Terminal')
    expect(resolved.source).toBe('fallback')
  })
})
