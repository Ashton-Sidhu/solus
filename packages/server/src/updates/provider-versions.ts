import { execFile } from 'node:child_process'
import type { SetupAgent } from '@solus/contracts/types'
import { getCliEnv } from '../cli-env'

export function parseProviderVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0] ?? null
}

export function readProviderVersion(agent: SetupAgent): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(agent, ['--version'], { env: getCliEnv(), timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error?.code === 'ENOENT') return resolve(null)
      if (error) return reject(new Error(`Could not read ${agent} version: ${error.message}`))
      const version = parseProviderVersion(stdout)
      if (!version) return reject(new Error(`${agent} returned an unknown version.`))
      resolve(version)
    })
  })
}
