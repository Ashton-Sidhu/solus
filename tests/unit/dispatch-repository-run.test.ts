import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { NormalizedEvent, SessionRunInput, StatusCardState, WireNormalizedEvent } from '@solus/contracts/types'
import { progressPercent, progressThrottle } from '@solus/server/execution/sessions/dispatch-repository'

/**
 * A Run on send copies its repository on the host, as part of the prompt
 * (docs/run-on.md). The host shows the copy, the worktree, and the start as one
 * setup card, so a reader sees one operation, and a failed copy starts nothing.
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))

const previousDataDir = process.env.SOLUS_DATA_DIR
const base = realpathSync(mkdtempSync(join(tmpdir(), 'solus-dispatch-repository-')))
const CLONE_URL = 'https://github.com/owner/repo.git'
/** Both forms the host tries, SSH first. Neither reaches the network here. */
const CLONE_ATTEMPTS = new Set([CLONE_URL, 'git@github.com:owner/repo.git'])
const ISOLATED = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
}
let remote = ''

function fixtureGit(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, env: ISOLATED, stdio: 'ignore' })
}

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = join(base, 'data')
  const { installTestIdentities } = await import('./helpers/acting-identities')
  installTestIdentities()
  // The "remote": a bare repository with one commit, served over file:// so
  // git reports transfer progress as it does over the network.
  const source = join(base, 'source')
  fixtureGit(['init', '-q', '-b', 'main', source], base)
  writeFileSync(join(source, 'README.md'), 'hello\n')
  fixtureGit(['add', 'README.md'], source)
  fixtureGit(['commit', '-q', '-m', 'Initial'], source)
  remote = join(base, 'remote.git')
  fixtureGit(['clone', '-q', '--bare', source, remote], base)
  fixtureGit(['config', 'uploadpack.allowFilter', 'true'], remote)
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

describe('git transfer progress', () => {
  test('reads the last percentage of a progress line', () => {
    expect(progressPercent('Receiving objects:  42% (420/1000), 1.20 MiB | 2.00 MiB/s')).toBe(42)
    expect(progressPercent('remote: Compressing objects: 100% (3/3), done.')).toBe(100)
    expect(progressPercent('Cloning into \'repo\'...')).toBeNull()
  })

  test('lets at most four updates a second through', () => {
    // WHY: git rewrites its line many times a second; each update is a card
    // sent to every watching client.
    let now = 0
    const mayPublish = progressThrottle(250, () => now)
    const published: number[] = []
    for (now = 0; now <= 1000; now += 50) if (mayPublish()) published.push(now)
    expect(published).toEqual([0, 250, 500, 750, 1000])
  })
})

/** A host whose setup clones `CLONE_URL` from the local bare repository. */
async function hostFor(cloneExitCode?: number) {
  const { SessionRuntime } = await import('@solus/server/execution/session-runtime')
  const { registerSetupHandlers } = await import('@solus/server/transport/handlers/setup-handlers')
  const { SolusServer } = await import('@solus/server/transport/server')
  const starts: Array<{ cwd: string }> = []
  const backend = Object.assign(new EventEmitter(), {
    startRun: (request: { cwd: string }) => {
      starts.push(request)
      throw new Error('the test ends at the start')
    },
    isSessionRunning: () => false,
    getPendingHandles: () => [],
    getEnrichedError: () => ({ message: 'failed', isError: true, stderrTail: [] }),
  })
  const runtime = new SessionRuntime(new Map([['codex', backend as never]]))
  runtime.on('error', () => {})
  const cards: StatusCardState[] = []
  const gitContexts: string[] = []
  runtime.on('event', (_sessionId: string, event: NormalizedEvent | WireNormalizedEvent) => {
    if (event.type === 'status_card') cards.push(event.card)
    if (event.type === 'git_context') gitContexts.push(event.gitContext.worktreePath ?? event.gitContext.repoRoot ?? '')
  })
  const setup = registerSetupHandlers(new SolusServer(), {
    checkouts: runtime.checkouts,
    projectsRoot: () => join(base, 'projects'),
    registerProject: async (path) => path,
    loadGithubToken: async () => null,
    hasCommand: () => false,
    spawnProcess: (file, args, options) => {
      if (cloneExitCode !== undefined) {
        const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null })
        setImmediate(() => child.emit('close', cloneExitCode, null))
        return child as never
      }
      return nodeSpawn(file, args.map((arg) => CLONE_ATTEMPTS.has(arg) ? `file://${remote}` : arg), { ...options, env: { ...ISOLATED, ...options.env } })
    },
  })
  runtime.launcher.prepareDispatchCheckout = setup.prepareDispatchCheckout
  const input: SessionRunInput = {
    provider: 'codex', agentSessionId: null, forked: false,
    // The client's own folder: the host has no such path.
    workingDirectory: '/Users/someone/solus', projectPath: '/Users/someone/solus',
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, contextWindow: null,
    model: 'gpt-requested', preferredModel: 'gpt-requested', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'supervised', rateLimitBehavior: 'queue', extraInstructions: '',
  }
  // Each case is its own device, so it has its own dispatch checkout.
  const send = (sessionId: string, deviceId: string) => runtime.runTurn({
    target: { kind: 'new-session' }, sessionId, tools: [], input, options: { prompt: 'go' },
    repository: { repository: { cloneUrl: CLONE_URL, newWorktree: true }, deviceId },
  }).then((lifecycle) => lifecycle.agentSessionId)
  return { runtime, cards, gitContexts, starts, send }
}

/** The step each card shows as active, once per change. */
function activeSteps(cards: StatusCardState[]): string[] {
  const steps = cards.map((card) => card.steps.find((step) => step.status === 'active' || step.status === 'error')?.id ?? '')
  return steps.filter((step, index) => step !== steps[index - 1])
}

describe('a prompt that carries its repository', () => {
  test('clones it, makes the worktree, and starts there, on one setup card', async () => {
    const { runtime, cards, gitContexts, starts, send } = await hostFor()
    try {
      await send('session-clone', 'device-1').catch(() => {})
      const checkout = join(base, 'projects', 'solus-remote', 'device-1', 'github.com', 'owner', 'repo')
      expect(existsSync(join(checkout, 'README.md'))).toBe(true)
      expect(new Set(cards.map((card) => card.id))).toEqual(new Set(['worktree-session-clone']))
      expect(cards[0].steps.map((step) => step.id)).toEqual(['repository', 'fetch', 'checkout', 'submodules', 'agent'])
      expect(activeSteps(cards)[0]).toBe('repository')
      // The clone has an origin, so the base is fetched; it has no submodules.
      expect(cards.at(-1)!.steps.map((step) => [step.id, step.status])).toEqual([
        ['repository', 'done'], ['fetch', 'done'], ['checkout', 'done'], ['submodules', 'skipped'], ['agent', 'active'],
      ])
      // The client learns the folder from the host, first the clone, then its worktree.
      expect(gitContexts[0]).toBe(checkout)
      expect(starts).toHaveLength(1)
      // The agent starts in the new worktree, not in the checkout or the client's folder.
      expect(gitContexts[1]).toStartWith(join(checkout, '.git', 'solus', 'worktrees'))
      expect(starts[0].cwd).toBe(gitContexts[1])
    } finally { runtime.shutdown() }
  })

  test('shows the transfer percentage on the repository step', async () => {
    const { runtime, cards, send } = await hostFor()
    const checkout = join(base, 'percent-checkout')
    fixtureGit(['clone', '-q', remote, checkout], base)
    runtime.launcher.prepareDispatchCheckout = async (_repository, _caller, progress) => {
      progress.onOutput('Receiving objects:  42% (1/2)', true)
      // Within the same quarter second: a reader does not need this one.
      progress.onOutput('Receiving objects:  50% (1/2)', true)
      return checkout
    }
    try {
      await send('session-percent', 'device-3').catch(() => {})
      expect(cards[1].steps[0]).toMatchObject({ id: 'repository', status: 'active', percent: 42 })
      // The rewritten line replaces the one before it in the output.
      expect(cards[1].output?.at(-1)).toBe('Receiving objects:  42% (1/2)')
      // The step is done on the next card, which carries no percentage.
      expect(cards[2].steps[0]).toMatchObject({ id: 'repository', label: 'Preparing repository', status: 'done' })
      expect(cards[2].steps[0].percent).toBeUndefined()
      expect(cards[2].output?.filter((line) => line.startsWith('Receiving'))).toEqual(['Receiving objects:  50% (1/2)'])
    } finally { runtime.shutdown() }
  })

  test('a failed clone marks the repository step and starts nothing', async () => {
    const { runtime, cards, starts, send } = await hostFor(128)
    try {
      await expect(send('session-failed', 'device-2')).rejects.toThrow()
      const last = cards.at(-1)!
      expect(last).toMatchObject({ id: 'worktree-session-failed', status: 'error', title: 'Repository setup failed' })
      expect(last.steps[0]).toMatchObject({ id: 'repository', status: 'error' })
      expect(last.steps[0].detail).toContain('Exited with code 128')
      expect(last.steps.slice(1).every((step) => step.status === 'pending')).toBe(true)
      expect(starts).toHaveLength(0)
      expect(existsSync(join(base, 'projects', 'solus-remote', 'device-2', 'github.com', 'owner', 'repo', '.git', 'solus'))).toBe(false)
    } finally { runtime.shutdown() }
  })
})
