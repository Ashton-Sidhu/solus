import { execFile as execFileCb, execFileSync } from 'child_process'
import { promisify } from 'util'
import { getCliEnv } from '../cli-env'

const execFileAsync = promisify(execFileCb)

const DEFAULT_TIMEOUT = 60_000
/** Node caps stdout at 1 MiB, which a plain `git commit` exceeds as soon as it
 *  prints a `create mode` line per file for a few thousand new files. Git's
 *  metadata output is cheap to hold, so the default is raised well above any
 *  realistic status/commit/push report. */
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024

export interface GitExecOptions {
  /** Extra env vars merged over the inherited CLI env. */
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
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    env: getCliEnv(opts.env),
  }).trim()
}

export async function runAsync(bin: string, args: string[], cwd: string, opts: GitExecOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, {
    cwd,
    encoding: 'utf-8',
    timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    env: getCliEnv(opts.env),
    signal: opts.signal,
  })
  return opts.raw ? stdout : stdout.trim()
}
