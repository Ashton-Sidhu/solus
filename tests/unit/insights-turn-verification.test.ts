import { describe, expect, test } from 'bun:test'
import type { MetricsSpan } from '@solus/contracts/observability-types'
import {
  matchCheck,
  shellCommand,
  turnVerification,
  verdictSummary,
} from '@solus/workspace-ui/components/insights/lib/turn-verification'

// The question the Result section answers: can the reader trust what this turn
// changed? That depends on order — did a check pass after the last edit — and
// on stating what the spans cannot know rather than calling it a pass.

let clock = 0
function span(name: string, input: string, extra: Partial<MetricsSpan> = {}): MetricsSpan {
  clock += 100
  return {
    spanId: `s${clock}`,
    parentSpanId: 'root',
    traceId: 'tr_1',
    kind: 'tool_call',
    name,
    service: 'solus.sessions',
    sessionId: 's_1',
    provider: 'claude-code',
    model: 'm',
    projectRoot: '/repo',
    origin: 'typed',
    startedAt: clock,
    endedAt: clock + 50,
    durationMs: 50,
    status: 'ok',
    attrs: { input },
    ...extra,
  }
}
const bash = (command: string, extra: Partial<MetricsSpan> = {}) => span('Bash', JSON.stringify({ command }), extra)
const edit = (path: string) => span('Edit', JSON.stringify({ file_path: path }))
const failed: Partial<MetricsSpan> = { status: 'error' }

describe('turn verification verdict', () => {
  test('a passing check after the final edit verifies the turn', () => {
    const result = turnVerification([edit('/repo/a.ts'), bash('bun test tests/unit/a.test.ts')])
    expect(result.verdict).toEqual({ kind: 'verified' })
  })

  // WHY: the most common way a turn misleads is "tests pass" followed by one
  // more edit. The files changed after the last passing run are the ones the
  // reader has to check themselves.
  test('code edited after the last passing check makes the turn stale, naming the files', () => {
    const result = turnVerification([
      edit('/repo/a.ts'),
      bash('bun test'),
      edit('/repo/b.ts'),
      edit('/repo/README.md'),
    ])
    expect(result.verdict.kind).toBe('stale')
    // A docs edit does not need the tests to run again.
    expect(result.verdict.kind === 'stale' && result.verdict.files.map((file) => file.path)).toEqual(['/repo/b.ts'])
  })

  test('a check whose last run failed is failing, even after an earlier pass', () => {
    const result = turnVerification([edit('/repo/a.ts'), bash('bun test'), bash('bun test', failed)])
    expect(result.verdict.kind).toBe('failing')
  })

  test('a failure fixed by a later run of the same check is not failing', () => {
    const result = turnVerification([edit('/repo/a.ts'), bash('bun test', failed), edit('/repo/a.ts'), bash('bun test')])
    expect(result.verdict).toEqual({ kind: 'verified' })
    expect(result.targets[0].runs.map((run) => run.result)).toEqual(['failed', 'passed'])
  })

  // WHY: a test piped into `tail` exits with tail's status, so a failing suite
  // reads as a clean exit. Calling that "passed" is the lie this guards.
  test('a check piped into another command is hidden, never passed', () => {
    const result = turnVerification([edit('/repo/a.ts'), bash('bun test tests/unit/a.test.ts 2>&1 | tail -20')])
    expect(result.verdict).toEqual({ kind: 'hidden' })
    expect(result.targets[0].command).toBe('bun test tests/unit/a.test.ts')
  })

  test('edits with no check are unchecked; a turn that only read has nothing to verify', () => {
    expect(turnVerification([edit('/repo/a.ts')]).verdict).toEqual({ kind: 'unchecked' })
    expect(turnVerification([span('Read', JSON.stringify({ file_path: '/repo/a.ts' }))]).verdict).toEqual({ kind: 'none' })
  })
})

describe('unresolved failures', () => {
  test('a failed command stays listed until the same command succeeds', () => {
    const result = turnVerification([
      bash('bun install', failed),
      bash('git push', { status: 'error', attrs: { input: '{"command":"git push"}', error: 'rejected' } }),
      bash('bun install'),
    ])
    expect(result.failures.map((failure) => [failure.command, failure.error])).toEqual([['git push', 'rejected']])
  })

  test('a probe that finds nothing is an answer, not a failure', () => {
    expect(turnVerification([bash('grep -rn "bun test" src', failed)]).failures).toEqual([])
    expect(turnVerification([bash('grep -rn "bun test" src')]).targets).toEqual([])
  })
})

describe('reading commands from both providers', () => {
  test('the cd into the project is removed, so the part that differs is readable', () => {
    expect(shellCommand(bash('cd /Users/me/solus && bun test tests/unit/x.test.ts'))).toBe('bun test tests/unit/x.test.ts')
  })

  // WHY: Codex records the command string itself, wrapped in a login shell, and
  // names its tools `exec_command` and `Edit` with a `changes` list. A model that
  // reads only Claude's JSON shows nothing for a Codex turn.
  test('a Codex turn is read from its own tool names and input shape', () => {
    const codexTest = (exitCode: number) =>
      span('exec_command', '', { provider: 'codex', attrs: { input: `/bin/zsh -lc 'cd /repo && cargo test'`, exitCode } })
    const codexEdit = (path: string) =>
      span('Edit', JSON.stringify({ changes: [{ path, kind: 'update' }] }), { provider: 'codex' })

    const failing = turnVerification([codexEdit('/repo/a.rs'), codexTest(101)])
    expect(failing.targets.map((target) => [target.command, target.last.result])).toEqual([['cargo test', 'failed']])
    expect(failing.verdict.kind).toBe('failing')

    const stale = turnVerification([codexEdit('/repo/a.rs'), codexTest(0), codexEdit('/repo/b.rs')])
    expect(stale.verdict.kind === 'stale' && stale.verdict.files.map((file) => file.path)).toEqual(['/repo/b.rs'])
  })

  test('checks are told apart by kind, and a config path is not a type check', () => {
    expect(matchCheck('bunx tsc --noEmit -p tsconfig.json')?.kind).toBe('typecheck')
    expect(matchCheck('bun run lint:layout')?.kind).toBe('lint')
    expect(matchCheck('cat tsconfig.json')).toBeNull()
  })

  test('a stale verdict names the files, relative to the project', () => {
    const verdict = turnVerification([bash('bun test'), edit('/repo/src/a.ts')]).verdict
    expect(verdictSummary(verdict, '/repo')).toMatchObject({ tone: 'warning', detail: 'src/a.ts' })
    expect(verdictSummary({ kind: 'none' }, '/repo')).toBeNull()
  })
})
