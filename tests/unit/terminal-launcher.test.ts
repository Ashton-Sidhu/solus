import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

type ExecCall = { file: string; args: string[] }

const execCalls: ExecCall[] = []
let hasSession = true
let failSessionCreation = false

const execFileSync = mock((file: string, args: string[]) => {
  execCalls.push({ file, args })
  if (file === 'tmux' && args[0] === 'has-session' && !hasSession) throw new Error('no session')
  if (file === 'tmux' && args[0] === 'new-session' && failSessionCreation) throw new Error('tmux unavailable')
  return Buffer.from('')
})

mock.module('child_process', () => ({ execFileSync }))
mock.module('../../src/main/cli-env', () => ({ getCliEnv: () => ({ PATH: '/usr/bin:/bin' }) }))
mock.module('../../src/main/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {} }),
}))

let launchInTerminal: typeof import('../../src/main/terminal-launcher')['launchInTerminal']

beforeAll(async () => {
  ;({ launchInTerminal } = await import('../../src/main/terminal-launcher'))
})

beforeEach(() => {
  execCalls.length = 0
  hasSession = true
  failSessionCreation = false
})

function expectConfiguredTerminalAttached(): void {
  const attachCommand = 'exec tmux attach-session -t solus'
  const terminalCall = execCalls.at(-1)
  if (process.platform === 'darwin') {
    expect(terminalCall).toEqual({
      file: 'open',
      args: ['-na', 'Ghostty.app', '--args', '-e', '/bin/zsh', '-c', attachCommand],
    })
  } else {
    expect(terminalCall).toEqual({ file: 'ghostty', args: ['-e', attachCommand] })
  }
}

describe('launchInTerminal', () => {
  test('opens a command window and attaches the configured terminal to the existing session', () => {
    // WHY: a tmux window created in another terminal is invisible unless the configured terminal attaches to it.
    const launched = launchInTerminal({ command: 'bun run dev', terminalId: 'ghostty', cwd: '/tmp/project' })

    expect(launched).toBe(true)
    expect(execCalls.slice(0, 2)).toEqual([
      { file: 'tmux', args: ['has-session', '-t', 'solus'] },
      { file: 'tmux', args: ['new-window', '-t', 'solus', '-c', '/tmp/project', 'bun run dev'] },
    ])
    expectConfiguredTerminalAttached()
  })

  test('creates the shared session before attaching when it does not exist', () => {
    hasSession = false

    const launched = launchInTerminal({ command: 'exec /bin/zsh -l', terminalId: 'ghostty', cwd: '/tmp/project' })

    expect(launched).toBe(true)
    expect(execCalls.slice(0, 2)).toEqual([
      { file: 'tmux', args: ['has-session', '-t', 'solus'] },
      {
        file: 'tmux',
        args: ['new-session', '-d', '-s', 'solus', '-c', '/tmp/project', 'exec /bin/zsh -l'],
      },
    ])
    expectConfiguredTerminalAttached()
  })

  test('attaches Apple Terminal or the system terminal to the shared session', () => {
    const launched = launchInTerminal({ command: 'pwd', terminalId: 'default-terminal', cwd: '/tmp/project' })

    expect(launched).toBe(true)
    const terminalCall = execCalls.at(-1)
    if (process.platform === 'darwin') {
      expect(terminalCall?.file).toBe('/usr/bin/osascript')
      expect(terminalCall?.args.join('\n')).toContain('do script "exec tmux attach-session -t solus"')
    } else {
      expect(terminalCall).toEqual({
        file: 'x-terminal-emulator',
        args: ['-e', 'exec tmux attach-session -t solus'],
      })
    }
  })

  test('does not report success when the tmux session cannot be created', () => {
    hasSession = false
    failSessionCreation = true

    const launched = launchInTerminal({ command: 'pwd', terminalId: 'ghostty', cwd: '/tmp/project' })

    expect(launched).toBe(false)
    expect(execCalls).toHaveLength(2)
  })
})
