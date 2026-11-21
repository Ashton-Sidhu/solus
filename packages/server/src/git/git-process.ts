import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { Readable, type Writable } from 'node:stream'
import { z } from 'zod'
import { launchedProcess, type LaunchOptions } from '../cli-env'
import { withBareRepositoryGuard } from './bare-repository-guard'
import { recordGitCommand } from './git-metrics'

/**
 * The one runner of Git processes (docs/adr/0005-one-git-process-runner.md).
 * A policy says who runs Git on a repository and with which configuration.
 * The runner owns what each policy needs: the launch, the bare repository
 * guard, the metric, the time limit, the stop signal, the input and the output,
 * the output limit, and the error.
 */

/** Who runs Git on a repository, and with which configuration. */
export interface GitPolicy {
  /** Names the policy in the metric of each command. */
  readonly name: 'project' | 'storage'
  /** The arguments before those of each command: the repository and the configuration that the policy sets. */
  readonly args: readonly string[]
  /** False: nothing reads the diagnostics of a process and an error keeps no output, because they can contain a credential. */
  readonly keepsOutput: boolean
  /** The identity that runs a command, with the policy's environment and then `env` from the caller. `args` are the caller's. */
  launchOptions(args: readonly string[], env?: NodeJS.ProcessEnv): LaunchOptions | Promise<LaunchOptions>
  /** The words of a failure. `commandLine` is the full command; a policy whose errors a person can see leaves it out. */
  failureMessage(failure: GitFailure, args: readonly string[], commandLine: string): string
}

/** A policy that can also start a command for a caller that cannot wait. */
export interface SyncGitPolicy extends GitPolicy {
  launchOptionsSync(args: readonly string[], env?: NodeJS.ProcessEnv): LaunchOptions
}

/** One Git command: where it runs, what stops it, and what it reads and writes. */
export interface GitRun {
  /** The folder that the process starts in. */
  cwd?: string
  /** Added to the environment of the policy. */
  env?: NodeJS.ProcessEnv
  /** Stops the process. The failure then has the reason `stopped`. */
  signal?: AbortSignal
  /** The time limit in ms. Absent or 0: no limit. */
  timeout?: number
  /** The limit of the answer in bytes. More output gives the reason `output-limit`. */
  outputLimit: number
  /** What the process reads. Absent: the end of input. */
  input?: string | Buffer | Readable
  /** Gets the output as it arrives. The answer is then empty and has no limit. */
  output?: Writable
  /** Gets each line of the diagnostics as it arrives. Git ends a progress line that it writes again with `\r`, so `\r` and `\n` both end a line. */
  onDiagnosticLine?: (line: string) => void
}

/**
 * Why a Git process gave no answer. `failed`: Git ended with a failure.
 * `stopped`: the caller's signal. `timeout`: the time limit. `output-limit`:
 * more output than the limit. `not-started`: the process did not start.
 */
export type GitFailureReason = 'failed' | 'stopped' | 'timeout' | 'output-limit' | 'not-started'

export interface GitFailure {
  reason: GitFailureReason
  /** The exit code of Git when it failed by itself, as on the error of Node's `execFile`. Null for each other reason, so the code 1 of a Git answer ("no such ref") is never the code of a process that Solus stopped. */
  code: number | null
  /** The signal that ended the process, or null. */
  signal: string | null
  /** What the process wrote before it failed. Empty for a policy that keeps no output. */
  stdout: string
  stderr: string
}

/** The error of each failed Git process. */
export class GitProcessError extends Error implements GitFailure {
  readonly reason: GitFailureReason
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string

  constructor(message: string, failure: GitFailure, cause?: unknown) {
    super(message, { cause })
    this.name = 'GitProcessError'
    this.reason = failure.reason
    this.code = failure.code
    this.signal = failure.signal
    this.stdout = failure.stdout
    this.stderr = failure.stderr
  }
}

/** With a line reader the diagnostics are progress lines, and an error keeps only their end. */
const DIAGNOSTIC_TAIL_CHARS = 8_192

/** Run one Git command and answer its output. */
export async function runGit(policy: GitPolicy, args: readonly string[], run: GitRun): Promise<Buffer> {
  const launched = launchedProcess(await policy.launchOptions(args, run.env), 'git', withBareRepositoryGuard('git', [...policy.args, ...args]))
  const startedAt = performance.now()
  return new Promise<Buffer>((resolve, reject) => {
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let stderr = ''
    let stderrBytes = 0
    let partialLine = ''
    let child: ChildProcess | null = null
    let reason: GitFailureReason | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let isSettled = false

    const stop = (why: GitFailureReason) => {
      reason ??= why
      // A hook or a helper that outlives Git can hold these open; without this the process would not close until it ends.
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      child?.kill()
    }
    const settle = () => {
      isSettled = true
      clearTimeout(timer)
      run.signal?.removeEventListener('abort', stopForCaller)
    }
    const fail = (why: GitFailureReason, code: number | null, signal: string | null, cause?: unknown) => {
      if (isSettled) return
      settle()
      recordGitCommand(policy.name, args, run.signal?.aborted ? 'aborted' : 'error', startedAt)
      const failure: GitFailure = {
        reason: why, code: why === 'failed' ? code : null, signal,
        stdout: policy.keepsOutput ? Buffer.concat(stdout).toString('utf8') : '',
        // A process that did not start wrote nothing; the reason is in the error of the launch.
        stderr: policy.keepsOutput && why === 'not-started' && cause instanceof Error ? cause.message : stderr,
      }
      reject(new GitProcessError(policy.failureMessage(failure, args, [launched.file, ...launched.args].join(' ')), failure, cause))
    }
    // The caller gets its answer at once, as it did from Node's `execFile`; the process ends after.
    const stopForCaller = () => {
      stop('stopped')
      fail('stopped', null, null)
    }

    if (run.signal?.aborted) return stopForCaller()
    try {
      // Git diagnostics can contain a credential, so a policy that keeps no output does not read them.
      child = spawn(launched.file, launched.args, { cwd: run.cwd, env: launched.env, stdio: ['pipe', 'pipe', policy.keepsOutput ? 'pipe' : 'ignore'] })
    } catch (cause) {
      return fail('not-started', null, null, cause)
    }
    run.signal?.addEventListener('abort', stopForCaller, { once: true })
    if (run.timeout) timer = setTimeout(() => stop('timeout'), run.timeout)

    if (run.output) child.stdout?.pipe(run.output, { end: false })
    else child.stdout?.on('data', (part: Buffer) => {
      stdoutBytes += part.length
      if (stdoutBytes > run.outputLimit) stop('output-limit')
      else stdout.push(part)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (text: string) => {
      if (run.onDiagnosticLine) {
        stderr = (stderr + text).slice(-DIAGNOSTIC_TAIL_CHARS)
        const lines = (partialLine + text).split(/[\r\n]/)
        partialLine = lines.pop() ?? ''
        for (const line of lines) if (line) run.onDiagnosticLine(line)
        return
      }
      stderrBytes += Buffer.byteLength(text)
      if (stderrBytes > run.outputLimit) stop('output-limit')
      else stderr += text
    })
    // A process can end before it reads all its input.
    child.stdin?.on('error', () => {})
    if (run.input instanceof Readable) {
      run.input.once('error', () => stop('failed'))
      if (child.stdin) run.input.pipe(child.stdin)
    } else child.stdin?.end(run.input)

    // A stop that could not reach the process keeps its reason.
    child.once('error', (cause) => fail(reason ?? 'not-started', null, null, cause))
    child.once('close', (code, signal) => {
      if (partialLine) run.onDiagnosticLine?.(partialLine)
      // A process that ended well as its time limit arrived has a complete answer. Output over the limit, or a stop, has none.
      if (code !== 0 || (reason !== null && reason !== 'timeout')) return fail(reason ?? 'failed', code, signal)
      if (isSettled) return
      settle()
      recordGitCommand(policy.name, args, 'ok', startedAt)
      resolve(Buffer.concat(stdout))
    })
  })
}

/** What Node adds to the Error that `execFileSync` throws: the result of the process, and the `code` of a system error. */
const syncResultSchema = z.object({
  status: z.number().nullable().catch(null),
  signal: z.string().nullable().catch(null),
  code: z.string().optional().catch(undefined),
  stdout: z.string().catch(''),
  stderr: z.string().catch(''),
})

/** `runGit` for a caller that cannot wait: it answers the output as text, and has no stop signal and no streams. */
export function runGitSync(policy: SyncGitPolicy, args: readonly string[], run: Pick<GitRun, 'cwd' | 'env' | 'timeout' | 'outputLimit'>): string {
  const launched = launchedProcess(policy.launchOptionsSync(args, run.env), 'git', withBareRepositoryGuard('git', [...policy.args, ...args]))
  const startedAt = performance.now()
  try {
    const stdout = execFileSync(launched.file, launched.args, { cwd: run.cwd, encoding: 'utf-8', timeout: run.timeout, maxBuffer: run.outputLimit, env: launched.env })
    recordGitCommand(policy.name, args, 'ok', startedAt)
    return stdout
  } catch (cause) {
    recordGitCommand(policy.name, args, 'error', startedAt)
    const result = syncResultSchema.parse(cause)
    const failure: GitFailure = {
      reason: result.code === 'ETIMEDOUT' ? 'timeout' : result.code === 'ENOBUFS' ? 'output-limit' : result.status !== null || result.signal ? 'failed' : 'not-started',
      code: result.code === undefined ? result.status : null,
      signal: result.signal,
      stdout: policy.keepsOutput ? result.stdout : '',
      stderr: !policy.keepsOutput ? '' : result.stderr || (result.status === null && cause instanceof Error ? cause.message : ''),
    }
    throw new GitProcessError(policy.failureMessage(failure, args, [launched.file, ...launched.args].join(' ')), failure, cause)
  }
}
