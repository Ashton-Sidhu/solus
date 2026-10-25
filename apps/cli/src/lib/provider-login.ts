import { spawn } from 'node:child_process'
import type { Provider } from './onboarding'
import { windowsSystemTool } from './runtime'

/** The exit code of `cmd.exe` when it cannot find the command. */
const WINDOWS_COMMAND_NOT_FOUND = 9009

/**
 * How to start the provider's own sign-in. On Windows an npm install puts
 * `claude.cmd` or `codex.cmd` on PATH, and Node does not start a `.cmd`
 * without a shell. `cmd.exe /d /s /c` finds the `.exe` or the `.cmd` through
 * PATHEXT. A shell is safe here only because the command line is a constant:
 * no part of it comes from the user.
 */
export function providerLoginCommand(provider: Provider, platform: NodeJS.Platform) {
  const display = provider === 'claude-code' ? 'claude auth login' : 'codex login --device-auth'
  const [file, ...args] = display.split(' ')
  if (platform === 'win32') return { file: windowsSystemTool('cmd.exe'), args: ['/d', '/s', '/c', display], display }
  return { file, args, display }
}

/** The provider's own sign-in, in this terminal, as the account the service runs as. */
export function setUpProvider(provider: Provider): Promise<boolean> {
  const { file, args, display } = providerLoginCommand(provider, process.platform)
  const name = display.split(' ')[0]
  const notInstalled = (reason: string) => console.log(`${name} is not installed on this server (${reason}). Install it, then run \`${display}\`.`)
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'inherit' })
    child.once('error', (error) => {
      notInstalled(error.message)
      resolve(false)
    })
    child.once('exit', (code) => {
      if (process.platform === 'win32' && code === WINDOWS_COMMAND_NOT_FOUND) notInstalled('not found on PATH')
      resolve(code === 0)
    })
  })
}
