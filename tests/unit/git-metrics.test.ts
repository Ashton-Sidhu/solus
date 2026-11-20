import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, runAsync, runStreamed } from '@solus/server/git/exec'
import { gitCommandSeries, useGitCommandMeter, type GitCommandMeasurement } from '@solus/server/git/git-metrics'
import { GitRepository } from '@solus/server/sync/git-storage/git-repository'
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

test('a project command records the series it had before the one runner', async () => {
  // WHY: dashboards and alerts read these names and labels. The runner serves
  // storage Git also, and that must not rename a project series, add a label
  // to it, or put storage commands in its numbers (docs/adr/0005).
  await runAsync('git', ['status', '--porcelain'], directory)
  git(['ls-files'], directory)
  await runStreamed(['status', '--porcelain'], directory, { onStderrLine: () => {} })
  await expect(runAsync('git', ['rev-parse', '--verify', 'no-such-ref'], directory)).rejects.toThrow()

  expect(measurements.map(gitCommandSeries)).toEqual([
    { duration: { name: 'git_command_duration', labels: { operation: 'status' } }, count: { name: 'git_commands_total', labels: { operation: 'status', outcome: 'ok' } } },
    { duration: { name: 'git_command_duration', labels: { operation: 'ls-files' } }, count: { name: 'git_commands_total', labels: { operation: 'ls-files', outcome: 'ok' } } },
    { duration: { name: 'git_command_duration', labels: { operation: 'status' } }, count: { name: 'git_commands_total', labels: { operation: 'status', outcome: 'ok' } } },
    { duration: { name: 'git_command_duration', labels: { operation: 'rev-parse' } }, count: { name: 'git_commands_total', labels: { operation: 'rev-parse', outcome: 'error' } } },
  ])
})

test('a storage command records its own series', async () => {
  // WHY: the Git of works, sessions, and apps had no metric. It is counted
  // now, apart from the Git that runs on a person's checkout.
  const repository = new GitRepository(join(directory, 'storage.git'))
  await repository.init()
  await expect(repository.git(['cat-file', 'blob', '0'.repeat(40)])).rejects.toThrow()

  expect(measurements.map(gitCommandSeries)).toEqual([
    { duration: { name: 'git_storage_command_duration', labels: { operation: 'init' } }, count: { name: 'git_storage_commands_total', labels: { operation: 'init', outcome: 'ok' } } },
    { duration: { name: 'git_storage_command_duration', labels: { operation: 'cat-file' } }, count: { name: 'git_storage_commands_total', labels: { operation: 'cat-file', outcome: 'error' } } },
  ])
})
