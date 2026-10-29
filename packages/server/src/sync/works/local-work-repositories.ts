import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { hostCliEnv } from '../../cli-env'
import { withUserScope } from '../../vault/acting-scope'
import type { WorkRepositoryAccess } from './git-work-transport'

const execute = promisify(execFile)

/** Private, bare repositories under the configured Solus data directory. */
export class LocalWorkRepositories implements WorkRepositoryAccess {
  constructor(private readonly root: string, private readonly signal?: AbortSignal) {}

  private path(repository: string): string {
    if (!/^work-[a-f0-9]{48}$/.test(repository)) throw new Error('Invalid local work repository name.')
    return join(this.root, `${repository}.git`)
  }

  private async git(repository: string, args: string[]): Promise<string> {
    return withUserScope(null, async () => {
      const env = hostCliEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' })
      for (const key of Object.keys(env)) if (key.startsWith('GIT_TRACE') || key === 'GIT_CURL_VERBOSE') delete env[key]
      try {
        const result = await execute('git', ['--git-dir', this.path(repository), '-c', 'core.hooksPath=/dev/null', ...args], {
          env, signal: this.signal, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
        })
        return result.stdout
      } catch { throw new Error('The local work repository could not be read or initialized.') }
    })
  }

  async remote(repository: string): Promise<{ url: string }> {
    await mkdir(this.path(repository), { recursive: true, mode: 0o700 })
    await this.git(repository, ['init', '--bare', '--initial-branch=main'])
    return { url: pathToFileURL(this.path(repository)).href }
  }

  async readFile(repository: string, commit: string, path: string): Promise<string> {
    if (!/^[a-f0-9]{40}$/.test(commit) || !/^bodies\/[a-f0-9]{64}$/.test(path)) throw new Error('Invalid local work body reference.')
    return this.git(repository, ['show', `${commit}:${path}`])
  }

  async remove(repository: string): Promise<void> {
    await rm(this.path(repository), { recursive: true, force: true })
  }
}
