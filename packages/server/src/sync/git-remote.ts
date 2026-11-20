import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostCliEnv } from '../cli-env'

export type CheckedPushResult =
  | { status: 'accepted'; head: string }
  | { status: 'refused'; head: string | null }
  | { status: 'failed'; reason: 'transport' | 'timeout' }

export interface GitRemoteOptions {
  gitDir: string
  remote: string
  token?: string
  signal?: AbortSignal
  timeoutMs: number
  outputLimitBytes?: number
  authorDate?: string
}

/** Git operations on a bare repository. Session callers must give a long hard timeoutMs and a suitable outputLimitBytes. */
export class GitRemote {
  private constructor(
    private readonly options: GitRemoteOptions,
    private readonly root: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly deadline: AbortSignal,
  ) {}

  static async open(options: GitRemoteOptions): Promise<GitRemote> {
    let url: URL
    try { url = new URL(options.remote) } catch { throw new Error('Invalid Git remote URL.') }
    if (url.username || url.password || url.search || url.hash || !['https:', 'file:'].includes(url.protocol)) throw new Error('The Git remote must not contain credentials.')
    if (url.protocol === 'file:' && options.token) throw new Error('A file remote cannot use a token.')
    if (url.protocol === 'https:' && !options.token) throw new Error('The Git remote needs a token.')
    const root = await mkdtemp(join(tmpdir(), 'solus-git-remote-'))
    try {
      const askpass = join(root, 'askpass')
      await writeFile(askpass, `#!/bin/sh
case "$1" in
  *"https://$SOLUS_GIT_HOST'"*|*"https://$SOLUS_GIT_HOST/"*|*"https://x@$SOLUS_GIT_HOST'"*|*"https://x@$SOLUS_GIT_HOST/"*) ;;
  *) exit 1 ;;
esac
case "$1" in
  Username*) printf 'x\\n' ;;
  Password*) printf '%s\\n' "$SOLUS_GIT_TOKEN" ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 })
      const env = hostCliEnv({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass,
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        SOLUS_GIT_HOST: url.host, SOLUS_GIT_TOKEN: options.token?.split('?expires=')[0],
        GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
        GIT_CONFIG_KEY_2: 'protocol.file.allow', GIT_CONFIG_VALUE_2: 'always',
        GIT_AUTHOR_NAME: 'Solus', GIT_AUTHOR_EMAIL: 'storage@solus.invalid',
        GIT_COMMITTER_NAME: 'Solus', GIT_COMMITTER_EMAIL: 'storage@solus.invalid',
        GIT_AUTHOR_DATE: options.authorDate, GIT_COMMITTER_DATE: options.authorDate,
      })
      for (const key of Object.keys(env)) if (key.startsWith('GIT_TRACE') || key === 'GIT_CURL_VERBOSE') delete env[key]
      const deadline = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs)
      return new GitRemote(options, root, env, deadline)
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }

  async close(): Promise<void> { await rm(this.root, { recursive: true, force: true }) }

  async git(args: string[], input?: string): Promise<string> {
    const deadline = this.deadline
    const child = spawn('git', ['--git-dir', this.options.gitDir, '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=60', ...args], {
      env: this.env, stdio: 'pipe', signal: deadline,
    })
    const parts: Buffer[] = []
    let bytes = 0
    child.stdout.on('data', (part: Buffer) => {
      bytes += part.length
      if (bytes > (this.options.outputLimitBytes ?? 16 * 1024 * 1024)) child.kill()
      else parts.push(part)
    })
    child.stderr.resume() // Git diagnostics can contain the credential.
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', () => reject(new Error(deadline.aborted ? 'The Git operation timed out.' : 'The Git process could not run.')))
      child.once('close', status => resolve(status ?? 1))
    })
    if (code !== 0) throw new Error(deadline.aborted ? 'The Git operation timed out.' : `The Git ${args[0]} operation failed (${code}).`)
    return Buffer.concat(parts).toString('utf8')
  }

  async remoteHead(): Promise<string | null> {
    const refs = (await this.git(['ls-remote', this.options.remote, 'refs/heads/main'])).trim()
    return refs ? refs.split(/\s+/)[0]! : null
  }

  async checkedPush(commit: string, expectedHead: string | null): Promise<CheckedPushResult> {
    try {
      const head = await this.remoteHead()
      if (head === commit) return { status: 'accepted', head: commit }
      if (head !== expectedHead) return { status: 'refused', head }
      try {
        await this.git(['push', `--force-with-lease=refs/heads/main:${expectedHead ?? ''}`, this.options.remote, `${commit}:refs/heads/main`])
      } catch (error) {
        if (error instanceof Error && error.message === 'The Git operation timed out.') return { status: 'failed', reason: 'timeout' }
        const afterFailure = await this.remoteHead()
        if (afterFailure === commit) return { status: 'accepted', head: commit }
        if (afterFailure !== expectedHead) return { status: 'refused', head: afterFailure }
        return { status: 'failed', reason: 'transport' }
      }
      const confirmed = await this.remoteHead()
      if (confirmed === commit) return { status: 'accepted', head: commit }
      if (confirmed !== expectedHead) return { status: 'refused', head: confirmed }
      return { status: 'failed', reason: 'transport' }
    } catch (error) {
      return { status: 'failed', reason: error instanceof Error && error.message === 'The Git operation timed out.' ? 'timeout' : 'transport' }
    }
  }
}
