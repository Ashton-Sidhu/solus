import type { MetricsSpan } from '@solus/contracts/observability-types'
import { projectRelativePath, unwrapShellCommand } from '../../../lib/changedFiles'
import { activityKind, parseToolInput, toolPathsFromParsed } from '../../conversation/lib/activity-summary'
import { asStringOrNull } from './result-columns'
import { withoutLeadingCd } from './waterfall'

// Can the reader trust what this turn changed, or must they check it?
//
// The answer is read off the order of the turn's tool calls: when it last
// edited a file, which checks it ran after that, and how each one ended. Every
// fact is a tool span's own record — a path in an edit's input, a command, an
// exit status — and nothing is inferred from the answer text.
//
// Two limits are stated, not guessed around:
// - A span keeps no command output. A check piped into another command (`bun
//   test | tail`) or chained with `;` or `||` exits with that other command's
//   status, so its result is "hidden", never "passed".
// - A file edited through the shell has no edit span. The turn's git snapshot
//   sees it; this model does not.
//
// Pure and non-reactive.

export type CheckKind = 'test' | 'typecheck' | 'lint'

/** How one check run ended. `hidden`: another command's exit status stands in
 *  for it. `unknown`: the run reported no status (interrupted, still running). */
export type CheckResult = 'passed' | 'failed' | 'hidden' | 'unknown'

export interface CheckRun {
  spanId: string
  endedAt: number
  result: CheckResult
}

/** One command the turn used to check its work, with every time it ran. */
export interface CheckTarget {
  /** The check as a reader names it: the runner and its arguments, with the
   *  `cd` before it and the pipe after it removed. */
  command: string
  kind: CheckKind
  runs: CheckRun[]
  last: CheckRun
}

/** A shell command that failed and did not succeed on a later run. */
export interface UnresolvedFailure {
  spanId: string
  command: string
  exitCode: number | null
  error: string | null
}

/** A file an editing tool named, and when the turn last wrote it. */
export interface EditedFile {
  path: string
  lastEditAt: number
}

export type VerificationVerdict =
  /** A check's last run failed. */
  | { kind: 'failing'; targets: CheckTarget[] }
  /** Code changed after the last passing check. */
  | { kind: 'stale'; files: EditedFile[] }
  /** A check passed after the final code edit. */
  | { kind: 'verified' }
  /** Checks ran, but none reported a result the model can read. */
  | { kind: 'hidden' }
  /** Files changed and no check ran. */
  | { kind: 'unchecked' }
  /** Nothing changed and nothing ran: there is nothing to verify. */
  | { kind: 'none' }

export interface TurnVerification {
  verdict: VerificationVerdict
  targets: CheckTarget[]
  failures: UnresolvedFailure[]
}

const CHECK_PATTERNS: Array<[CheckKind, RegExp]> = [
  ['test', /\b(bun\s+test|vitest|jest|pytest|cargo\s+test|go\s+test|(npm|pnpm|yarn|bun)\s+(run\s+)?test|playwright\s+test|mocha)\b/],
  ['typecheck', /\b(tsc|svelte-check|vue-tsc|mypy|pyright|cargo\s+check|go\s+vet|(npm|pnpm|yarn|bun)\s+run\s+(typecheck|check|lint:types))\b/],
  ['lint', /\b(eslint|oxlint|biome\s+(check|lint)|ruff|cargo\s+clippy|golangci-lint|(npm|pnpm|yarn|bun)\s+run\s+lint)\b/],
]

/** Probes whose non-zero exit is an answer, not a failure: `grep` finding
 *  nothing, `test -f` saying no. */
const PROBE_COMMAND = /^(grep|rg|ag|diff|test|\[|which|command)\b/

/** Paths whose edit does not need a check to run again after it. */
const NON_CODE_PATH = /\.(md|mdx|txt)$/i

/**
 * The command a shell span ran, as the agent wrote it. Claude records the tool
 * input as JSON; Codex records the command string itself, often in a login
 * shell. The `cd` into the project is removed, as the waterfall's labels do.
 */
export function shellCommand(span: MetricsSpan): string | null {
  if (activityKind(span.name) !== 'run') return null
  const raw = asStringOrNull(span.attrs.input)?.trim()
  if (!raw) return null
  const recorded = raw.startsWith('{') ? parseToolInput(raw)?.command : undefined
  return withoutLeadingCd(unwrapShellCommand(recorded ?? raw)) || null
}

interface CheckMatch {
  kind: CheckKind
  /** The runner and its arguments, up to the first pipe or chain. */
  command: string
  /** Another command's exit status stands in for the check's. */
  isHidden: boolean
}

export function matchCheck(command: string): CheckMatch | null {
  for (const [kind, pattern] of CHECK_PATTERNS) {
    const match = pattern.exec(command)
    if (!match) continue
    const fromRunner = command.slice(match.index)
    const end = fromRunner.search(/\s*(\|\|?|;|&&)/)
    const rest = end < 0 ? '' : fromRunner.slice(end)
    const runner = (end < 0 ? fromRunner : fromRunner.slice(0, end)).replace(/\s*\d?>&\d\s*$/, '').trim()
    const hasChain = /\|\||;/.test(rest)
    const hasPipe = /(^|[^|])\|([^|]|$)/.test(rest)
    return {
      kind,
      command: runner,
      isHidden: hasChain || (hasPipe && !/pipefail/.test(command)),
    }
  }
  return null
}

/** Claude reports a non-zero exit as an errored call and gives no code; Codex
 *  gives the code. Either way an ok status with no code means it exited 0. */
function commandResult(span: MetricsSpan): 'passed' | 'failed' | 'unknown' {
  const exitCode = span.attrs.exitCode ?? null
  if (span.status === 'error' || (exitCode != null && exitCode !== 0)) return 'failed'
  if (exitCode === 0 || span.status === 'ok') return 'passed'
  return 'unknown'
}

/** The files an editing tool named, from either provider's input shape. */
function editedFiles(tools: MetricsSpan[]): EditedFile[] {
  const byPath = new Map<string, EditedFile>()
  for (const span of tools) {
    if (activityKind(span.name) !== 'edit' || span.status === 'error') continue
    const parsed = parseToolInput(asStringOrNull(span.attrs.input) ?? '')
    const at = span.endedAt ?? span.startedAt
    for (const path of parsed ? toolPathsFromParsed(parsed) : []) {
      const file = byPath.get(path) ?? { path, lastEditAt: at }
      file.lastEditAt = Math.max(file.lastEditAt, at)
      byPath.set(path, file)
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

function verdictOf(targets: CheckTarget[], files: EditedFile[]): VerificationVerdict {
  const failing = targets.filter((target) => target.last.result === 'failed')
  if (failing.length > 0) return { kind: 'failing', targets: failing }
  if (targets.length === 0) return files.length > 0 ? { kind: 'unchecked' } : { kind: 'none' }
  const passedAt = targets
    .flatMap((target) => target.runs)
    .filter((run) => run.result === 'passed')
    .map((run) => run.endedAt)
  if (passedAt.length === 0) return { kind: 'hidden' }
  const lastPassAt = Math.max(...passedAt)
  const stale = files.filter((file) => file.lastEditAt > lastPassAt && !NON_CODE_PATH.test(file.path))
  return stale.length > 0 ? { kind: 'stale', files: stale } : { kind: 'verified' }
}

export function turnVerification(spans: MetricsSpan[]): TurnVerification {
  const tools = spans
    .filter((span) => span.kind === 'tool_call')
    .sort((a, b) => a.startedAt - b.startedAt)
  const targets = new Map<string, CheckTarget>()
  const failures = new Map<string, UnresolvedFailure>()

  for (const span of tools) {
    const command = shellCommand(span)
    if (!command) continue
    const result = commandResult(span)
    // `grep -n "bun test"` searches for a check; it does not run one.
    const isProbe = PROBE_COMMAND.test(command)
    const check = isProbe ? null : matchCheck(command)
    if (check) {
      const run: CheckRun = {
        spanId: span.spanId,
        endedAt: span.endedAt ?? span.startedAt,
        result: check.isHidden && result !== 'unknown' ? 'hidden' : result,
      }
      const target = targets.get(check.command)
      if (target) {
        target.runs.push(run)
        target.last = run
      } else {
        targets.set(check.command, { command: check.command, kind: check.kind, runs: [run], last: run })
      }
      continue
    }
    // A later success of the same command answers an earlier failure.
    if (result === 'passed') failures.delete(command)
    else if (result === 'failed' && !isProbe) {
      failures.set(command, {
        spanId: span.spanId,
        command,
        exitCode: span.attrs.exitCode ?? null,
        error: asStringOrNull(span.attrs.error),
      })
    }
  }

  const files = editedFiles(tools)
  const checkTargets = [...targets.values()]
  return {
    verdict: verdictOf(checkTargets, files),
    targets: checkTargets,
    failures: [...failures.values()],
  }
}

export type VerdictTone = 'good' | 'warning' | 'failure' | 'neutral'

export interface VerdictSummary {
  tone: VerdictTone
  title: string
  detail: string
}

export const CHECK_KIND_LABELS = {
  test: 'Test',
  typecheck: 'Type check',
  lint: 'Lint',
} satisfies Record<CheckKind, string>

function namedList(names: string[], limit = 3): string {
  const shown = names.slice(0, limit).join(', ')
  return names.length > limit ? `${shown} and ${names.length - limit} more` : shown
}

/** The verdict as the one sentence the section leads with. Null when there is
 *  nothing to verify. */
export function verdictSummary(verdict: VerificationVerdict, projectRoot: string | null): VerdictSummary | null {
  switch (verdict.kind) {
    case 'verified':
      return { tone: 'good', title: 'Checked after the final edit', detail: 'A check passed after the last code change.' }
    case 'stale': {
      const names = verdict.files.map((file) => projectRelativePath(file.path, projectRoot))
      return {
        tone: 'warning',
        title: `${names.length} ${names.length === 1 ? 'file' : 'files'} changed after the last passing check`,
        detail: namedList(names),
      }
    }
    case 'failing':
      return {
        tone: 'failure',
        title: verdict.targets.length === 1 ? 'The last check failed' : `${verdict.targets.length} checks failed on their last run`,
        detail: namedList(verdict.targets.map((target) => target.command), 2),
      }
    case 'hidden':
      return {
        tone: 'neutral',
        title: 'Checks ran, but their results are not known',
        detail: 'Each run was piped or chained, so its exit status is another command’s.',
      }
    case 'unchecked':
      return { tone: 'warning', title: 'Not checked', detail: 'Files changed, and no test, type check, or lint ran.' }
    case 'none':
      return null
  }
}
