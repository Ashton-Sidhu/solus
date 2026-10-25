import { execFile as execFileCb, execFileSync, spawn } from 'child_process'
import { promisify } from 'util'
import { launchedProcess, launchProcess } from '../cli-env'
import { currentIdentity } from '../vault/acting-scope'
import { withBareRepositoryGuard } from './bare-repository-guard'
import { GitUnavailableError, isGitUsable } from './git-availability'

const execFileAsync = promisify(execFileCb)

const DEFAULT_TIMEOUT = 60_000
/** Node caps stdout at 1 MiB, which a plain `git commit` exceeds as soon as it
 *  prints a `create mode` line per file for a few thousand new files. Git's
 *  metadata output is cheap to hold, so the default is raised well above any
 *  realistic status/commit/push report. */
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024
/** Background reads (status refresh, snapshots) run beside the user's own git
 *  commands. Without this, `git status` takes `.git/index.lock` to save its
 *  refreshed index, and the user's `git checkout` or `git commit` fails. Commands
 *  that must write the index take the lock regardless. A caller's env wins. */
const GIT_DEFAULT_ENV: NodeJS.ProcessEnv = { GIT_OPTIONAL_LOCKS: '0' }

export interface GitExecOptions {
  /** Extra env vars merged over the acting identity's environment. They cannot change the identity. */
  env?: NodeJS.ProcessEnv
  /** Stops the spawned process when the owning setup is interrupted. */
  signal?: AbortSignal
  /** Timeout in ms. Defaults to 60s. */
  timeout?: number
  /** Max stdout bytes. Defaults to 64 MiB; raise for whole-repo diffs. */
  maxBuffer?: number
  /** Return stdout verbatim. Defaults to trimming — which is wrong whenever the
   *  output is file content, where trailing blank lines are meaningful. */
  raw?: boolean
}

export function git(args: string[], cwd: string, opts: GitExecOptions = {}): string {
  if (!isGitUsable()) throw new GitUnavailableError()
  const run = launchProcess('git', withBareRepositoryGuard('git', args), { ...GIT_DEFAULT_ENV, ...opts.env })
  return execFileSync(run.file, run.args, {
    cwd,
    encoding: 'utf-8',
    timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    env: run.env,
  }).trim()
}

async function launched(bin: string, args: string[], opts: GitExecOptions) {
  if (bin === 'git' && !isGitUsable()) throw new GitUnavailableError()
  // The acting identity's environment, with a member's author once known: a
  // partial clone can turn any git command into a fetch, so every one acts as someone.
  const launch = await currentIdentity(`${bin} ${args[0] ?? ''}`.trim()).launchOptions(bin === 'git' ? { ...GIT_DEFAULT_ENV, ...opts.env } : opts.env)
  return launchedProcess(launch, bin, withBareRepositoryGuard(bin, args))
}

export async function runAsync(bin: string, args: string[], cwd: string, opts: GitExecOptions = {}): Promise<string> {
  const run = await launched(bin, args, opts)
  const { stdout } = await execFileAsync(run.file, run.args, {
    cwd,
    encoding: 'utf-8',
    timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    env: run.env,
    signal: opts.signal,
  })
  return opts.raw ? stdout : stdout.trim()
}

/** The part of stderr that a failed streamed command keeps for its error. */
const STDERR_TAIL_CHARS = 8_192

/**
 * `runAsync` for a command that reports progress on stderr. Each line goes to
 * `onStderrLine` as it arrives; git ends a rewritten progress line with `\r`,
 * so `\r` and `\n` both end a line. Resolves with stdout, like `runAsync`.
 */
export async function runStreamed(
  bin: string,
  args: string[],
  cwd: string,
  opts: GitExecOptions & { onStderrLine: (line: string) => void },
): Promise<string> {
  const run = await launched(bin, args, opts)
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER
  return new Promise<string>((resolve, reject) => {
    const child = spawn(run.file, run.args, {
      cwd,
      env: run.env,
      signal: opts.signal,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderrTail = ''
    let partialLine = ''
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > maxBuffer) child.kill()
    })
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
      const lines = (partialLine + chunk).split(/[\r\n]/)
      partialLine = lines.pop() ?? ''
      for (const line of lines) if (line) opts.onStderrLine(line)
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (partialLine) opts.onStderrLine(partialLine)
      if (code === 0) resolve(opts.raw ? stdout : stdout.trim())
      else reject(new Error(`Command failed: ${bin} ${args.join(' ')}${signal ? ` (${signal})` : ''}\n${stderrTail.trim()}`))
    })
  })
}

/** Whether a revision resolves to a commit object in this repository. */
export function gitCommitExists(cwd: string, revision: string): Promise<boolean> {
  return runAsync('git', ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], cwd)
    .then(() => true, () => false)
}
