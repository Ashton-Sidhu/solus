import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitRepository } from './git-repository'

export type CheckedPushResult =
  | { status: 'accepted'; head: string }
  | { status: 'refused'; head: string | null }
  /** `remoteMessage`: the lines of a refused push that the remote wrote, with no line that holds the token. */
  | { status: 'failed'; reason: 'transport' | 'timeout'; remoteMessage?: string }

/** The most text of a refused push that `checkedPush` answers. */
const REMOTE_MESSAGE_CHARS = 4_096

export interface GitRemoteOptions {
  gitDir: string
  remote: string
  token?: string
  signal?: AbortSignal
  timeoutMs: number
  outputLimitBytes?: number
}

/** The remote of one bare repository. Session callers must give a long hard timeoutMs and a suitable outputLimitBytes. */
export class GitRemote {
  /** The local repository at `gitDir`. Its Git processes have the credential and the time limit of this remote. */
  readonly repository: GitRepository

  private constructor(
    private readonly options: GitRemoteOptions,
    private readonly root: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly deadline: AbortSignal,
  ) {
    this.repository = new GitRepository(options.gitDir, { deadline, outputLimitBytes: options.outputLimitBytes, env })
  }

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
      const env = { GIT_ASKPASS: askpass,
        SOLUS_GIT_HOST: url.host, SOLUS_GIT_TOKEN: options.token?.split('?expires=')[0],
        GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'always',
        GIT_CONFIG_KEY_2: 'http.lowSpeedLimit', GIT_CONFIG_VALUE_2: '1',
        GIT_CONFIG_KEY_3: 'http.lowSpeedTime', GIT_CONFIG_VALUE_3: '60',
      }
      const deadline = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs)
      return new GitRemote(options, root, env, deadline)
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }

  async close(): Promise<void> { await rm(this.root, { recursive: true, force: true }) }

  async remoteHead(): Promise<string | null> {
    const refs = (await this.repository.git(['ls-remote', this.options.remote, 'refs/heads/main'])).trim()
    return refs ? refs.split(/\s+/)[0]! : null
  }

  async checkedPush(commit: string, expectedHead: string | null): Promise<CheckedPushResult> {
    try {
      const head = await this.remoteHead()
      if (head === commit) return { status: 'accepted', head: commit }
      if (head !== expectedHead) return { status: 'refused', head }
      const lines: string[] = []
      const token = this.env.SOLUS_GIT_TOKEN
      try {
        await this.repository.git(['push', `--force-with-lease=refs/heads/main:${expectedHead ?? ''}`, this.options.remote, `${commit}:refs/heads/main`], {
          onDiagnosticLine: (line) => { if (!token || !line.includes(token)) lines.push(line) },
        })
      } catch {
        if (this.deadline.aborted) return { status: 'failed', reason: 'timeout' }
        const afterFailure = await this.remoteHead()
        if (afterFailure === commit) return { status: 'accepted', head: commit }
        if (afterFailure !== expectedHead) return { status: 'refused', head: afterFailure }
        return { status: 'failed', reason: 'transport', remoteMessage: lines.join('\n').slice(-REMOTE_MESSAGE_CHARS) }
      }
      const confirmed = await this.remoteHead()
      if (confirmed === commit) return { status: 'accepted', head: commit }
      if (confirmed !== expectedHead) return { status: 'refused', head: confirmed }
      return { status: 'failed', reason: 'transport' }
    } catch {
      return { status: 'failed', reason: this.deadline.aborted ? 'timeout' : 'transport' }
    }
  }
}
