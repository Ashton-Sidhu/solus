import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, runAsync } from '@solus/server/git/exec'
import { useGitCommandMeter, type GitCommandMeasurement } from '@solus/server/git/git-metrics'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

let directory = ''
let measurements: GitCommandMeasurement[] = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'solus-git-metrics-'))
  git(['init', '-b', 'main'], directory)
  measurements = []
  useGitCommandMeter((measurement) => measurements.push(measurement))
})

afterEach(() => {
  useGitCommandMeter(null)
  rmSync(directory, { recursive: true, force: true })
})

test('each git subprocess is recorded once under its subcommand', async () => {
  // WHY: checkpoints and snapshots spawn many git commands; their cost is only
  // visible if every subprocess, async or sync, lands in the same metrics.
  await runAsync('git', ['rev-parse', '--git-dir'], directory)
  await runAsync('git', ['-C', directory, '-c', 'core.quotepath=off', 'status', '--porcelain'], directory)
  git(['ls-files'], directory)

  expect(measurements.map(({ operation, outcome }) => ({ operation, outcome }))).toEqual([
    { operation: 'rev-parse', outcome: 'ok' },
    { operation: 'status', outcome: 'ok' },
    { operation: 'ls-files', outcome: 'ok' },
  ])
  for (const { durationMs } of measurements) expect(durationMs).toBeGreaterThanOrEqual(0)
})

test('a failed command counts as an error and an aborted one as aborted', async () => {
  await expect(runAsync('git', ['rev-parse', '--verify', 'no-such-ref'], directory)).rejects.toThrow()
  expect(() => git(['rev-parse', '--verify', 'no-such-ref'], directory)).toThrow()
  const controller = new AbortController()
  controller.abort()
  await expect(runAsync('git', ['status'], directory, { signal: controller.signal })).rejects.toThrow()

  expect(measurements.map(({ outcome }) => outcome)).toEqual(['error', 'error', 'aborted'])
})

test('an unknown subcommand is labeled other, and no argument or path becomes a label', async () => {
  // WHY: a label that carries a path or ref makes a new metric series per repository.
  await expect(runAsync('git', ['-C', directory, `no-such-command-${directory}`], directory)).rejects.toThrow()

  expect(measurements).toHaveLength(1)
  expect(measurements[0].operation).toBe('other')
  expect(JSON.stringify(measurements)).not.toContain(directory)
})

test('a non-git binary is not recorded', async () => {
  await runAsync('true', [], directory)
  expect(measurements).toEqual([])
})
