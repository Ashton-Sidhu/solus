import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { PermissionResponder, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import type { AgentMetadata, NormalizedEvent, SessionRunInput, StatusCardState, WireNormalizedEvent } from '@solus/contracts/types'
import type { WorktreeSetupStage, WorktreeStageUpdate } from '@solus/server/git/worktree-manager'

/**
 * The host's worktree card shows what git really does: the fetch of the base,
 * the checkout of files with its percentage, and the submodules. A problem that
 * does not stop the worktree is a warning, and the person can leave the setup
 * for the project folder while it runs.
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))
// The account that holds a TypeSafe key is not part of this test.
mock.module('@solus/server/typesafe/credentials', () => ({
  typeSafeKey: () => Promise.reject(new Error('unavailable')),
  typeSafeKeyStatus: () => Promise.reject(new Error('unavailable')),
  setTypeSafeApiKey: () => {},
}))

const previousDataDir = process.env.SOLUS_DATA_DIR
const base = realpathSync(mkdtempSync(join(tmpdir(), 'solus-worktree-stages-')))
let worktreeManager: typeof import('@solus/server/git/worktree-manager')
let exec: typeof import('@solus/server/git/exec')

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = join(base, 'data')
  worktreeManager = await import('@solus/server/git/worktree-manager')
  exec = await import('@solus/server/git/exec')
  const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')
  actAsHostForTests()
})

afterAll(async () => {
  const { closeDatabase } = await import('@solus/server/db/database')
  const { closeDb } = await import('@solus/server/db')
  await closeDatabase()
  closeDb()
  rmSync(base, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

let fixtureCount = 0
function fixtureGit(args: string[], cwd: string): string {
  return exec.git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'protocol.file.allow=always', ...args], cwd)
}

function repository(): string {
  const directory = join(base, `repo-${++fixtureCount}`)
  mkdirSync(directory)
  fixtureGit(['init', '-q', '-b', 'main'], directory)
  writeFileSync(join(directory, 'README.md'), 'hello\n')
  fixtureGit(['add', 'README.md'], directory)
  fixtureGit(['commit', '-q', '-m', 'Initial'], directory)
  return directory
}

function cloneOf(upstream: string): string {
  const directory = join(base, `clone-${++fixtureCount}`)
  fixtureGit(['clone', '-q', `file://${upstream}`, directory], base)
  return directory
}

/** Every stage update, in order, as `stage:status`. */
function recorder() {
  const updates: Array<{ stage: WorktreeSetupStage } & WorktreeStageUpdate> = []
  return {
    updates,
    onStage: (stage: WorktreeSetupStage, update: WorktreeStageUpdate) => { updates.push({ stage, ...update }) },
    sequence: () => updates.filter((update) => update.percent === undefined).map((update) => `${update.stage}:${update.status}`),
  }
}

describe('the stages of a new worktree', () => {
  const previousConfig = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 }
  afterEach(() => {
    for (const [name, value] of [['GIT_CONFIG_COUNT', previousConfig.count], ['GIT_CONFIG_KEY_0', previousConfig.key], ['GIT_CONFIG_VALUE_0', previousConfig.value]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  test('a repository with no origin skips the fetch', async () => {
    // WHY: there is nothing to fetch, so a fetch step that "runs" would lie.
    const directory = repository()
    const stages = recorder()
    const checkout = await worktreeManager.createWorktree(directory, 'main', { onStage: stages.onStage })
    expect(stages.sequence()).toEqual(['fetch:skipped', 'checkout:active', 'checkout:done', 'submodules:skipped'])
    expect(existsSync(join(checkout.worktreePath!, 'README.md'))).toBe(true)
  })

  test('a local origin ref fetches beside the checkout', async () => {
    // WHY: the fetch and the checkout run at the same time, so both are active at once.
    const clone = cloneOf(repository())
    const stages = recorder()
    await worktreeManager.createWorktree(clone, 'main', { onStage: stages.onStage })
    const sequence = stages.sequence()
    expect(sequence.slice(0, 2)).toEqual(['fetch:active', 'checkout:active'])
    expect(sequence).toContain('fetch:done')
    expect(sequence.slice(-2)).toEqual(['checkout:done', 'submodules:skipped'])
  })

  test('without a local origin ref the fetch comes first', async () => {
    const clone = cloneOf(repository())
    fixtureGit(['update-ref', '-d', 'refs/remotes/origin/main'], clone)
    const stages = recorder()
    await worktreeManager.createWorktree(clone, 'main', { onStage: stages.onStage })
    expect(stages.sequence()).toEqual(['fetch:active', 'fetch:done', 'checkout:active', 'checkout:done', 'submodules:skipped'])
  })

  test('a failed fetch is a warning, and the worktree starts from the local base', async () => {
    // WHY: the person gets a worktree from what the host has, and is told the base may be old.
    const directory = repository()
    fixtureGit(['remote', 'add', 'origin', join(base, 'no-such-remote')], directory)
    const stages = recorder()
    const checkout = await worktreeManager.createWorktree(directory, 'main', { onStage: stages.onStage })
    expect(stages.updates.find((update) => update.stage === 'fetch' && update.status === 'warning')?.detail).toBe('Used local main; fetch failed')
    expect(exec.git(['rev-parse', 'HEAD'], checkout.worktreePath!)).toBe(exec.git(['rev-parse', 'main'], directory))
  })

  test('a repository with submodules loads them into the worktree', async () => {
    const library = repository()
    const directory = repository()
    fixtureGit(['submodule', 'add', '-q', library, 'lib'], directory)
    fixtureGit(['commit', '-q', '-m', 'Add lib'], directory)
    // Git refuses a local submodule unless the person allows it.
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow'
    process.env.GIT_CONFIG_VALUE_0 = 'always'
    const stages = recorder()
    const checkout = await worktreeManager.createWorktree(directory, 'main', { onStage: stages.onStage })
    expect(stages.sequence().slice(-2)).toEqual(['submodules:active', 'submodules:done'])
    expect(existsSync(join(checkout.worktreePath!, 'lib', 'README.md'))).toBe(true)
  })

  test('a submodule that cannot load is a warning, and the worktree stays', async () => {
    // WHY: the agent can work without a submodule; failing the whole setup would
    // throw away a good worktree.
    const library = repository()
    const directory = repository()
    fixtureGit(['submodule', 'add', '-q', library, 'lib'], directory)
    fixtureGit(['commit', '-q', '-m', 'Add lib'], directory)
    rmSync(library, { recursive: true, force: true })
    const stages = recorder()
    const checkout = await worktreeManager.createWorktree(directory, 'main', { onStage: stages.onStage })
    const warning = stages.updates.at(-1)!
    expect(warning).toMatchObject({ stage: 'submodules', status: 'warning' })
    expect(warning.detail).toStartWith('Submodules not loaded: ')
    expect(existsSync(join(checkout.worktreePath!, 'README.md'))).toBe(true)
    expect(exec.git(['branch', '--show-current'], checkout.worktreePath!)).toBe(checkout.branch!)
  })

  test('the checkout reports the percentage of files it wrote', async () => {
    // WHY: a large checkout is the slow step; a percentage tells the person it moves.
    const directory = repository()
    for (let i = 0; i < 3000; i++) writeFileSync(join(directory, `file-${i}.txt`), `${i}\n`)
    fixtureGit(['add', '.'], directory)
    fixtureGit(['commit', '-q', '-m', 'Many files'], directory)
    const stages = recorder()
    await worktreeManager.createWorktree(directory, 'main', { onStage: stages.onStage })
    const percents = stages.updates.flatMap((update) => update.stage === 'checkout' && update.percent !== undefined ? [update.percent] : [])
    expect(percents.length).toBeGreaterThan(0)
    expect(percents.at(-1)).toBe(100)
  })
})

describe('a streamed command', () => {
  test('hands each stderr line to its reader, also lines that git rewrites with a carriage return', async () => {
    const lines: string[] = []
    const stdout = await exec.runStreamed('sh', ['-c', 'printf "Updating files:  10%%\\rUpdating files: 100%%\\ndone" >&2; printf out'], base, {
      onStderrLine: (line) => lines.push(line),
    })
    expect(stdout).toBe('out')
    expect(lines).toEqual(['Updating files:  10%', 'Updating files: 100%', 'done'])
  })

  test('a failed command rejects with its stderr', async () => {
    await expect(exec.runStreamed('sh', ['-c', 'echo broken >&2; exit 3'], base, { onStderrLine: () => {} })).rejects.toThrow('broken')
  })
})

class Permissions implements PermissionResponder {
  getPendingInfo(): undefined { return undefined }
  respondToPermission(): boolean { return false }
  respondToQuestion(): boolean { return false }
  clearPendingForSession(): void {}
  setCurrentSessionId(): void {}
}

/** A backend that records each run it is handed and starts it at once. */
class RecordingBackend extends EventEmitter {
  readonly id = 'claude-code' as const
  readonly metadata: AgentMetadata = { id: 'claude-code', label: 'Claude Code', models: [], defaultModel: 'claude-sonnet-5' }
  readonly permissions = new Permissions()
  readonly runs: AgentRunRequest[] = []

  startRun(request: AgentRunRequest): RunHandle {
    this.runs.push(request)
    return {
      agentSessionId: `claude-session-${this.runs.length}`,
      persistence: request.persistence,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController: new AbortController(),
      runPromise: new Promise<void>(() => {}),
      _resolveRun: () => {},
      _rejectRun: () => {},
    }
  }

  getSessionHandle(): RunHandle | undefined { return undefined }
  getPendingHandles(): RunHandle[] { return [] }
  cancelSession(): boolean { return false }
  isSessionRunning(): boolean { return false }
  async steerSession(): Promise<null> { return null }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [] } }
}

async function hostFor(projectPath: string) {
  const { SessionRuntime } = await import('@solus/server/execution/session-runtime')
  const backend = new RecordingBackend()
  const runtime = new SessionRuntime(new Map([['claude-code', backend as never]]))
  runtime.on('error', () => {})
  const cards: StatusCardState[] = []
  const statuses: string[] = []
  runtime.on('event', (_sessionId: string, event: NormalizedEvent | WireNormalizedEvent) => {
    if (event.type === 'status_card') cards.push(event.card)
    if (event.type === 'status_change') statuses.push(event.status)
  })
  const input: SessionRunInput = {
    provider: 'claude-code', agentSessionId: null, forked: false, workingDirectory: projectPath, projectPath,
    additionalDirs: [], gitContext: null, worktreeBaseBranch: 'main', contextWindow: null,
    model: 'claude-opus-5', preferredModel: 'claude-opus-5', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'supervised', rateLimitBehavior: 'queue', extraInstructions: '',
  }
  const send = (sessionId: string) => runtime.runTurn({
    target: { kind: 'new-session' }, sessionId, tools: [], input, options: { prompt: 'go', promptSource: 'typed' },
  }).then((lifecycle) => lifecycle.agentSessionId)
  return { runtime, backend, cards, statuses, send }
}

describe('the host setup card', () => {
  test('carries host times in step order and a warning that still lets the agent start', async () => {
    const directory = repository()
    fixtureGit(['remote', 'add', 'origin', join(base, 'no-such-remote')], directory)
    const { runtime, backend, cards, send } = await hostFor(directory)
    try {
      await send('session-times')
      const last = cards.at(-1)!
      expect(last.steps.map((step) => [step.id, step.status])).toEqual([
        ['fetch', 'warning'], ['checkout', 'done'], ['submodules', 'skipped'], ['agent', 'active'],
      ])
      expect(last.status).toBe('active')
      const [fetch, checkout, submodules, agent] = last.steps
      expect(fetch.detail).toBe('Used local main; fetch failed')
      // WHY: durations come from the host's clock, so each step has a start
      // before its end, and a step starts after the one it waited for.
      expect(fetch.startedAt! <= fetch.endedAt!).toBe(true)
      expect(fetch.endedAt! <= checkout.startedAt!).toBe(true)
      expect(checkout.startedAt! <= checkout.endedAt!).toBe(true)
      expect(checkout.endedAt! <= agent.startedAt!).toBe(true)
      expect(submodules.startedAt).toBeUndefined()
      expect(agent.endedAt).toBeUndefined()
      expect(backend.runs[0]?.cwd).toStartWith(join(directory, '.git', 'solus', 'worktrees'))
    } finally { runtime.shutdown() }
  })

  test('work locally while the worktree is made runs the same prompt in the project folder', async () => {
    const directory = repository()
    const { runtime, backend, cards, statuses, send } = await hostFor(directory)
    // The person chooses Work locally once the files are checked out, so the
    // host has a worktree and a branch to remove.
    let accepted: boolean | undefined
    runtime.on('event', (sessionId: string, event: NormalizedEvent | WireNormalizedEvent) => {
      if (accepted === undefined && event.type === 'status_card' && event.card.steps.some((step) => step.id === 'checkout' && step.status === 'done')) {
        accepted = runtime.launcher.continueSetupLocally(sessionId)
      }
    })
    try {
      await send('session-local')
      expect(accepted).toBe(true)
      // WHY: the prompt the person sent runs, in the project folder, and the
      // session never shows as failed.
      expect(backend.runs).toHaveLength(1)
      expect(backend.runs[0]?.cwd).toBe(directory)
      expect(backend.runs[0]?.prompt).toBe('go')
      expect(statuses).not.toContain('failed')
      // No half-made worktree or branch stays behind.
      expect(exec.git(['branch', '--format=%(refname:short)'], directory)).toBe('main')
      expect(exec.git(['worktree', 'list', '--porcelain'], directory).match(/^worktree /gm)).toHaveLength(1)
      const last = cards.at(-1)!
      expect(last).toMatchObject({ status: 'active', icon: 'server', title: 'Starting session…' })
      expect(last.worktreeBaseBranch).toBeUndefined()
      expect(last.steps.map((step) => [step.id, step.status])).toEqual([
        ['fetch', 'skipped'], ['checkout', 'skipped'], ['submodules', 'skipped'], ['agent', 'active'],
      ])
      // Nothing is left to stop.
      expect(runtime.launcher.continueSetupLocally('session-local')).toBe(false)
    } finally { runtime.shutdown() }
  })
})
