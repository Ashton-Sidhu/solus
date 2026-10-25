/**
 * Every git subprocess is timed and counted under its subcommand and outcome.
 * Checkpoints, snapshots, status refreshes and worktree setup all spawn git, and
 * without this none of their cost shows up next to the rest of the host's
 * telemetry.
 *
 * The labels are bounded on purpose: the operation is a subcommand from the
 * list below, or `other`, and never an argument, a path, or a ref.
 *
 * Git cannot import the telemetry runtime, so boot installs the meter; until
 * then (and in a test that installs none) nothing is recorded.
 */

const GIT_OPERATIONS = new Set([
  'add', 'branch', 'cat-file', 'check-ref-format', 'checkout', 'clean', 'clone',
  'commit', 'config', 'diff', 'diff-index', 'fetch', 'for-each-ref', 'hash-object',
  'init', 'log', 'ls-files', 'ls-remote', 'merge', 'merge-base', 'pull', 'push',
  'read-tree', 'remote', 'reset', 'rev-list', 'rev-parse', 'show', 'stash',
  'status', 'symbolic-ref', 'update-index', 'update-ref', 'worktree', 'write-tree',
])

/** Git's global options that take their value as the next argument. */
const OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace'])

export type GitOutcome = 'ok' | 'error' | 'aborted'

export interface GitCommandMeasurement {
  operation: string
  outcome: GitOutcome
  durationMs: number
}

export type GitCommandMeter = (measurement: GitCommandMeasurement) => void

let meter: GitCommandMeter | null = null

/** Installed once at boot; null stops recording. */
export function useGitCommandMeter(next: GitCommandMeter | null): void {
  meter = next
}

/** The subcommand of a git invocation, past its global options, or `other`. */
export function gitOperation(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (OPTIONS_WITH_VALUE.has(arg)) {
      i++
      continue
    }
    if (arg.startsWith('-')) continue
    return GIT_OPERATIONS.has(arg) ? arg : 'other'
  }
  return 'other'
}

function record(args: readonly string[], outcome: GitOutcome, startedAt: number): void {
  meter?.({ operation: gitOperation(args), outcome, durationMs: performance.now() - startedAt })
}

/** Runs one git subprocess and records its duration and outcome. */
export async function meterGitCommand<Result>(
  args: readonly string[],
  signal: AbortSignal | undefined,
  run: () => Promise<Result>,
): Promise<Result> {
  const startedAt = performance.now()
  try {
    const result = await run()
    record(args, 'ok', startedAt)
    return result
  } catch (error) {
    // Node rejects an aborted execFile with an AbortError; the signal answers too.
    const isAborted = signal?.aborted || (error instanceof Error && error.name === 'AbortError')
    record(args, isAborted ? 'aborted' : 'error', startedAt)
    throw error
  }
}

/** The synchronous form of `meterGitCommand`. */
export function meterGitCommandSync<Result>(args: readonly string[], run: () => Result): Result {
  const startedAt = performance.now()
  try {
    const result = run()
    record(args, 'ok', startedAt)
    return result
  } catch (error) {
    record(args, 'error', startedAt)
    throw error
  }
}
