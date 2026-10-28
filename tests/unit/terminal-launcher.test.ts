import { EventEmitter } from 'node:events'
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

type ExecCall = { file: string; args: string[] }

const execCalls: ExecCall[] = []
let missingBinaries = new Set<string>()
let spawnFails = false
let lastSpawn: { detached: boolean; stdio: string; env: NodeJS.ProcessEnv } | undefined
let unrefCalled = false
let hasSession = true
let failSessionCreation = false
/** tmux clients attached to the shared session, as `[clientPid, ...]`. */
let attachedClientPids: number[] = []
/** `pid -> "<ppid> <comm>"`, the process tree `ps` reports for those clients. */
let processTree: Record<number, string> = {}
let cliPathReady: Promise<string> = Promise.resolve('/usr/bin:/bin')

const execFileSync = mock((file: string, args: string[]) => {
  execCalls.push({ file, args })
  if (file === 'tmux' && args[0] === 'has-session' && !hasSession) throw new Error('no session')
  if (file === 'tmux' && args[0] === 'new-session' && failSessionCreation) throw new Error('tmux unavailable')
  if (file === 'tmux' && args[0] === 'list-clients') return attachedClientPids.join('\n')
  if (file === '/usr/bin/which') {
    if (missingBinaries.has(args[0])) throw new Error('not installed')
    return '/usr/bin/' + args[0]
  }
  if (file === '/bin/ps') {
    return Object.entries(processTree).map(([pid, line]) => `${pid} ${line}`).join('\n')
  }
  return Buffer.from('')
})

// The read path (which clients are attached, which app draws them) runs off
// the main thread; it answers through the same fake, one tick later.
const execFile = mock((file: string, args: string[], _options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; encoding: string }, callback: (error: Error | null, stdout: string) => void) => {
  let result: string
  try {
    result = String(execFileSync(file, args))
  } catch (error) {
    queueMicrotask(() => callback(error instanceof Error ? error : new Error(String(error)), ''))
    return
  }
  queueMicrotask(() => callback(null, result))
})

const spawn = mock((file: string, args: string[], options: { detached: boolean; stdio: string; env: NodeJS.ProcessEnv }) => {
  lastSpawn = options
  execCalls.push({ file, args })
  const child = Object.assign(new EventEmitter(), { unref: mock(() => { unrefCalled = true }) })
  queueMicrotask(() => spawnFails ? child.emit('error', new Error('spawn failed')) : child.emit('spawn'))
  return child
})
mock.module('child_process', () => ({ execFileSync, execFile, spawn }))
mock.module('@solus/server/cli-env', () => ({ hostCliEnv: () => ({ PATH: '/usr/bin:/bin' }), warmCliPath: () => cliPathReady }))
mock.module('@solus/server/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {} }),
}))
// Stands in for the filesystem probe, so a launch asserts one fixed bundle path.
mock.module('@solus/desktop-main/mac-apps', () => ({
  findAppBundle: (bundleName: string) => `/Applications/${bundleName}`,
}))

// The shared tmux terminal with each operating system's apps, so both run on
// any machine (docs/plans/windows.md §13.3).
type Terminal = ReturnType<typeof import('@solus/desktop-main/terminal-launcher')['tmuxTerminal']>
let mac: Terminal
let linux: Terminal

beforeAll(async () => {
  const { tmuxTerminal } = await import('@solus/desktop-main/terminal-launcher')
  const { macTerminalApps } = await import('@solus/desktop-main/platform/darwin-terminal')
  const { linuxTerminalApps } = await import('@solus/desktop-main/platform/linux-terminal')
  mac = tmuxTerminal(macTerminalApps)
  linux = tmuxTerminal(linuxTerminalApps)
})

beforeEach(() => {
  execCalls.length = 0
  hasSession = true
  missingBinaries = new Set()
  spawnFails = false
  lastSpawn = undefined
  unrefCalled = false
  failSessionCreation = false
  attachedClientPids = []
  processTree = {}
  cliPathReady = Promise.resolve('/usr/bin:/bin')
})

const ATTACH_COMMAND = 'exec tmux attach-session -t solus'
const MAC_GHOSTTY = { file: 'open', args: ['-na', '/Applications/Ghostty.app', '--args', '-e', '/bin/zsh', '-c', ATTACH_COMMAND] }
const LINUX_GHOSTTY = { file: 'ghostty', args: ['-e', '/bin/sh', '-c', ATTACH_COMMAND] }

describe('the shared tmux session', () => {
  test.each([['macOS', () => mac, MAC_GHOSTTY], ['Linux', () => linux, LINUX_GHOSTTY]] as const)(
    'on %s, opens a window in the session and falls back to the configured terminal when nothing is attached',
    async (_name, terminal, fallbackCall) => {
      // WHY: with no attached client the tmux window is invisible until some terminal attaches to it.
      const launched = await terminal().launch({ command: 'bun run dev', fallbackTerminalId: 'ghostty', cwd: '/tmp/project' })

      expect(launched).toBe(true)
      expect(execCalls.slice(0, 2)).toEqual([
        { file: 'tmux', args: ['has-session', '-t', 'solus'] },
        { file: 'tmux', args: ['new-window', '-t', 'solus', '-c', '/tmp/project', 'bun run dev'] },
      ])
      expect(execCalls.at(-1)).toEqual(fallbackCall)
    },
  )

  test('creates the shared session before falling back when it does not exist', async () => {
    hasSession = false

    const launched = await mac.launch({ command: 'exec /bin/zsh -l', fallbackTerminalId: 'ghostty', cwd: '/tmp/project' })

    expect(launched).toBe(true)
    expect(execCalls.slice(0, 2)).toEqual([
      { file: 'tmux', args: ['has-session', '-t', 'solus'] },
      { file: 'tmux', args: ['new-session', '-d', '-s', 'solus', '-c', '/tmp/project', 'exec /bin/zsh -l'] },
    ])
    expect(execCalls.at(-1)).toEqual(MAC_GHOSTTY)
  })

  test('does not report success when the tmux session cannot be created', async () => {
    hasSession = false
    failSessionCreation = true

    expect(await linux.launch({ command: 'pwd', fallbackTerminalId: 'ghostty', cwd: '/tmp/project' })).toBe(false)
    expect(execCalls).toHaveLength(2)
  })

  test('waits for the shared PATH warmup before starting terminal probes', async () => {
    // WHY: a cold inspection must not invoke the synchronous login-shell fallback.
    let completeWarmup!: (path: string) => void
    cliPathReady = new Promise((resolve) => { completeWarmup = resolve })
    const read = mac.resolve('ghostty')
    await Promise.resolve()
    expect(execCalls).toHaveLength(0)
    completeWarmup('/usr/bin:/bin')
    expect((await read).source).toBe('fallback')
  })

  test('keeps the attached result when a client exits during the process snapshot', async () => {
    // WHY: a missing process is not evidence that tmux has no attached clients.
    attachedClientPids = [4242]
    expect(await mac.resolve('ghostty')).toEqual({ id: null, name: 'Attached terminal', source: 'attached' })
  })
})

describe('macOS terminals', () => {
  test('attaches Apple Terminal through AppleScript when it is the configured fallback', async () => {
    expect(await mac.launch({ command: 'pwd', fallbackTerminalId: 'default-terminal', cwd: '/tmp/project' })).toBe(true)
    const terminalCall = execCalls.at(-1)
    expect(terminalCall?.file).toBe('/usr/bin/osascript')
    expect(terminalCall?.args.join('\n')).toContain(`do script "${ATTACH_COMMAND}"`)
  })

  test.each([['iterm2' as const], ['wezterm' as const], ['kitty' as const], ['alacritty' as const]])(
    'launches %s already attached to the shared session',
    async (fallbackTerminalId) => {
      // WHY: a fallback that comes up in a plain shell leaves the user staring at
      // the wrong window while their agent runs in a session they cannot see.
      expect(await mac.launch({ command: 'pwd', fallbackTerminalId, cwd: '/tmp/project' })).toBe(true)
      expect(execCalls.at(-1)?.args.join(' ')).toContain(ATTACH_COMMAND)
    },
  )

  test('reuses a terminal that already holds the session instead of launching another one', async () => {
    // WHY: a second client fights the first over the session size, which is what
    // made every "Open in terminal" pile up unusable windows.
    attachedClientPids = [4242]
    processTree = {
      4242: '4200 /usr/local/bin/tmux',
      4200: '1 /Applications/WezTerm.app/Contents/MacOS/wezterm-gui',
    }

    expect(await mac.launch({ command: 'pwd', fallbackTerminalId: 'ghostty', cwd: '/tmp/project' })).toBe(true)
    expect(execCalls.some((call) => call.args.includes('/Applications/Ghostty.app'))).toBe(false)
    expect(execCalls.some((call) => call.file === '/usr/bin/osascript')).toBe(false)
    // The detected terminal is raised whatever it is, not only the ones Solus can launch.
    expect(execCalls.at(-1)).toEqual({ file: 'open', args: ['/Applications/WezTerm.app'] })
  })

  test('still reuses an attached terminal whose application cannot be identified', async () => {
    // WHY: an ssh or non-bundle client is still a live view of the session; a
    // fallback launch would attach a competing second client.
    attachedClientPids = [7]
    processTree = { 7: '1 /usr/bin/tmux' }

    expect(await mac.launch({ command: 'pwd', fallbackTerminalId: 'ghostty', cwd: '/tmp/project' })).toBe(true)
    expect(execCalls.some((call) => call.args.includes('/Applications/Ghostty.app'))).toBe(false)
  })

  test('names the terminal already attached to the shared session', async () => {
    // WHY: the clients badge the action with this. Naming the configured
    // fallback while a different terminal holds the session is the stale label
    // that sent users looking in the wrong window.
    attachedClientPids = [4242]
    processTree = {
      4242: '4200 /usr/local/bin/tmux',
      4200: '1 /Applications/WezTerm.app/Contents/MacOS/wezterm-gui',
    }
    expect(await mac.resolve('ghostty')).toEqual({ id: 'wezterm', name: 'WezTerm', source: 'attached' })
  })

  test('reads tmux once and shares one process snapshot across clients and deep parent trees', async () => {
    // WHY: inspection must not start another subprocess for each shell parent,
    // and an unidentified client must not hide a later identifiable terminal.
    attachedClientPids = [7, 4242]
    processTree = {
      7: '1 /usr/bin/tmux',
      4242: '4200 /usr/local/bin/tmux',
      4200: '4100 /bin/zsh',
      4100: '4000 /bin/zsh',
      4000: '1 /Applications/iTerm.app/Contents/MacOS/iTerm2',
    }

    const resolved = await mac.resolve('ghostty')

    expect(execCalls.filter((call) => call.file === 'tmux' && call.args[0] === 'list-clients')).toHaveLength(1)
    expect(execCalls.filter((call) => call.file === '/bin/ps')).toHaveLength(1)
    expect(resolved).toEqual({ id: 'iterm2', name: 'iTerm', source: 'attached' })
  })

  test('names a terminal it can see but cannot launch', async () => {
    // WHY: Warp runs no startup command so it is not in the catalog, but a Warp
    // user with the session already open should still see their own terminal.
    attachedClientPids = [99]
    processTree = { 99: '90 /usr/local/bin/tmux', 90: '1 /Applications/Warp.app/Contents/MacOS/stable' }
    expect(await mac.resolve('ghostty')).toEqual({ id: null, name: 'Warp', source: 'attached' })
  })

  test('falls back to the configured terminal, and calls the system terminal by its own name', async () => {
    // WHY: "Default Terminal" is a role, not what the user sees in their Dock.
    expect(await mac.resolve('ghostty')).toEqual({ id: 'ghostty', name: 'Ghostty', source: 'fallback' })
    expect((await mac.resolve('default-terminal')).name).toBe('Terminal')
  })
})

describe('Linux terminals', () => {
  test('attaches the system terminal when it is the configured fallback', async () => {
    expect(await linux.launch({ command: 'pwd', fallbackTerminalId: 'default-terminal', cwd: '/tmp/project' })).toBe(true)
    expect(execCalls.at(-1)).toEqual({ file: 'x-terminal-emulator', args: ['-e', '/bin/sh', '-c', ATTACH_COMMAND] })
  })

  test('reuses an attached client without reading a process tree it cannot name', async () => {
    attachedClientPids = [4242]
    expect(await linux.launch({ command: 'pwd', fallbackTerminalId: 'ghostty', cwd: '/tmp/project' })).toBe(true)
    expect(execCalls.some((call) => call.file === '/bin/ps' || call.file === 'ghostty')).toBe(false)
    expect(await linux.resolve('ghostty')).toEqual({ id: null, name: 'Attached terminal', source: 'attached' })
  })

  test('returns on spawn while the terminal stays alive', async () => {
    expect(await linux.launch({ command: 'pwd', fallbackTerminalId: 'ghostty' })).toBe(true)
    expect(lastSpawn?.detached).toBe(true)
    expect(lastSpawn?.stdio).toBe('ignore')
    expect(lastSpawn).not.toHaveProperty('timeout')
    expect(unrefCalled).toBe(true)
  })

  test('uses an installed terminal when the system alternative is missing', async () => {
    missingBinaries.add('x-terminal-emulator')
    expect(await linux.launch({ command: 'pwd', fallbackTerminalId: 'default-terminal' })).toBe(true)
    expect(execCalls.at(-1)?.file).toBe('ghostty')
  })

  test('reports missing selections and spawn failures', async () => {
    missingBinaries.add('ghostty')
    expect(await linux.launch({ command: 'pwd', fallbackTerminalId: 'ghostty' })).toBe(false)
    missingBinaries.clear()
    spawnFails = true
    expect(await linux.launch({ command: 'pwd', fallbackTerminalId: 'ghostty' })).toBe(false)
    expect(unrefCalled).toBe(false)
  })

  test('calls the system terminal "Default Terminal"', async () => {
    expect((await linux.resolve('default-terminal')).name).toBe('Default Terminal')
  })
})
