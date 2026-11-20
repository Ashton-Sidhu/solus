import type { GitPolicy } from './git-process'

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
  /** The policy that ran the command (docs/adr/0005-one-git-process-runner.md). */
  policy: GitPolicy['name']
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

/** Records one finished git subprocess, started at `startedAt` (`performance.now()`). */
export function recordGitCommand(policy: GitPolicy['name'], args: readonly string[], outcome: GitOutcome, startedAt: number): void {
  meter?.({ policy, operation: gitOperation(args), outcome, durationMs: performance.now() - startedAt })
}

/**
 * The series that one command records: the name and the labels of its duration
 * and of its count. A project command keeps the names it always had. A storage
 * command has its own, so the project numbers count only the Git that runs on
 * a person's checkout.
 */
export function gitCommandSeries({ policy, operation, outcome }: GitCommandMeasurement) {
  const storage = policy === 'storage'
  return {
    duration: { name: storage ? 'git_storage_command_duration' : 'git_command_duration', labels: { operation } },
    count: { name: storage ? 'git_storage_commands_total' : 'git_commands_total', labels: { operation, outcome } },
  }
}
