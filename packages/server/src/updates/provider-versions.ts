import { execFile } from 'node:child_process'
import { hostCliEnv, startableCommand } from '../cli-env'

export function parseProviderVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0] ?? null
}

export function readExecutableVersion(binary: string, env = hostCliEnv(), timeout = 5_000): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const command = startableCommand(binary, env)
    execFile(command.file, [...command.args, '--version'], { env, timeout, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error?.code === 'ENOENT') return resolve(null)
      if (error) return reject(new Error('Could not read the agent executable version.'))
      const version = parseProviderVersion(stdout)
      if (!version) return reject(new Error('The agent executable returned an unknown version.'))
      resolve(version)
    })
  })
}
