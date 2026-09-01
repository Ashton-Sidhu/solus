import { execFile as execFileCb, execFileSync } from 'child_process'
import { promisify } from 'util'
import { getCliEnv } from '../cli-env'

const execFileAsync = promisify(execFileCb)

const DEFAULT_TIMEOUT = 60_000

export interface GitExecOptions {
  /** Extra env vars merged over the inherited CLI env. */
  env?: NodeJS.ProcessEnv
  /** Timeout in ms. Defaults to 60s. */
  timeout?: number
  /** Max stdout bytes. Defaults to Node's 1 MiB; raise for whole-repo diffs. */
  maxBuffer?: number
}

export function git(args: string[], cwd: string, opts: GitExecOptions = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    env: getCliEnv(opts.env),
  }).trim()
}

export async function runAsync(bin: string, args: string[], cwd: string, opts: GitExecOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, {
    cwd,
    encoding: 'utf-8',
    timeout: opts.timeout ?? DEFAULT_TIMEOUT,
    maxBuffer: opts.maxBuffer,
    env: getCliEnv(opts.env),
  })
  return stdout.trim()
}
