import { execFile as execFileCb } from 'child_process'
import { resolve as resolvePath } from 'path'
import { promisify } from 'util'
import { launchOptions, launchedProcess } from '../cli-env'
import { currentIdentity } from '../vault/acting-scope'
import { GitUnavailableError, isGitUsable } from './git-availability'
import { runGit, runGitSync, type GitRun, type SyncGitPolicy } from './git-process'

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
/** Solus reads every diff as paths from the repository root. A person's
 *  `diff.relative=true` would cut a diff run from a project in a subdirectory
 *  down to that folder, with paths relative to it. Not `--no-relative`, which
 *  only `diff` takes and Git before 2.28 rejects. */
const GIT_DEFAULT_ARGS = ['-c', 'diff.relative=false'] as const

export interface GitExecOptions {
  /** Extra env vars merged over the acting identity's environment. They cannot change the identity. */
  env?: NodeJS.ProcessEnv
  /** Stops the spawned process when the owning setup is interrupted. */
  signal?: AbortSignal
  /** Timeout in ms. Defaults to 60s; 0 sets no deadline, and only `signal` stops the command. */
  timeout?: number
  /** Max stdout bytes. Defaults to 64 MiB; raise for whole-repo diffs. */
  maxBuffer?: number
  /** Return stdout verbatim. Defaults to trimming — which is wrong whenever the
   *  output is file content, where trailing blank lines are meaningful. */
  raw?: boolean
}

/**
 * The project policy (docs/adr/0005-one-git-process-runner.md): Git on a
 * person's checkout. It reads the person's Git configuration, credential
 * helpers, and signing, and runs as the acting identity.
 */
const projectGit: SyncGitPolicy = {
  name: 'project',
  args: GIT_DEFAULT_ARGS,
  keepsOutput: true,
  // The acting identity's environment, with a member's author once known: a
  // partial clone can turn any git command into a fetch, so every one acts as someone.
  async launchOptions(args, env) {
    if (!isGitUsable()) throw new GitUnavailableError()
    return currentIdentity(`git ${args[0] ?? ''}`.trim()).launchOptions({ ...GIT_DEFAULT_ENV, ...env })
  },
  launchOptionsSync(_args, env) {
    if (!isGitUsable()) throw new GitUnavailableError()
    return launchOptions({ ...GIT_DEFAULT_ENV, ...env })
  },
  // The words of Node's `execFile`, which the clients read.
  failureMessage: (failure, _args, commandLine) => `Command failed: ${commandLine}\n${failure.stderr}`,
}

function projectRun(cwd: string, opts: GitExecOptions): GitRun {
  return { cwd, env: opts.env, signal: opts.signal, timeout: opts.timeout ?? DEFAULT_TIMEOUT, outputLimit: opts.maxBuffer ?? DEFAULT_MAX_BUFFER }
}

export function git(args: string[], cwd: string, opts: GitExecOptions = {}): string {
  return runGitSync(projectGit, args, projectRun(cwd, opts)).trim()
}

export async function runAsync(bin: string, args: string[], cwd: string, opts: GitExecOptions = {}): Promise<string> {
  let stdout: string
  if (bin === 'git') stdout = (await runGit(projectGit, args, projectRun(cwd, opts))).toString('utf8')
  else {
    const run = launchedProcess(await currentIdentity(`${bin} ${args[0] ?? ''}`.trim()).launchOptions(opts.env), bin, args)
    stdout = (await execFileAsync(run.file, run.args, {
      cwd,
      encoding: 'utf-8',
      timeout: opts.timeout ?? DEFAULT_TIMEOUT,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      env: run.env,
      signal: opts.signal,
    })).stdout
  }
  return opts.raw ? stdout : stdout.trim()
}

/**
 * `runAsync('git', …)` for a command that reports progress on stderr. Each
 * line goes to `onStderrLine` as it arrives; git ends a rewritten progress
 * line with `\r`, so `\r` and `\n` both end a line. Resolves with stdout.
 */
export async function runStreamed(
  args: string[],
  cwd: string,
  opts: GitExecOptions & { onStderrLine: (line: string) => void },
): Promise<string> {
  const stdout = (await runGit(projectGit, args, { ...projectRun(cwd, opts), onDiagnosticLine: opts.onStderrLine })).toString('utf8')
  return opts.raw ? stdout : stdout.trim()
}

/**
 * A path git printed, as this host names it: Git for Windows prints `C:/x`
 * where Node and every other path on the host have `C:\x`, so a raw compare of
 * the two never matches. Relative output is from `cwd`. Every path read from
 * git's stdout goes through here (docs/plans/windows.md §5.4).
 */
export function gitOutputPath(cwd: string, output: string): string {
  return resolvePath(cwd, output.trim())
}

/** Whether a revision resolves to a commit object in this repository. */
export function gitCommitExists(cwd: string, revision: string): Promise<boolean> {
  return runAsync('git', ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], cwd)
    .then(() => true, () => false)
}
