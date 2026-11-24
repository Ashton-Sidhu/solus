import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripInjectedContext } from '@solus/contracts/injected-context'
import type { IpcContext } from '@solus/contracts/types'
import type { ReviewGuideRequestOptions, ReviewGuideStatusEvent } from '@solus/contracts/review'
import type { AgentDispatcher, AgentRun, AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// A synchronous spawn on the main thread stalls every transcript read behind
// it. The status path must never take one; count them at the module boundary.
const childProcess = await import('node:child_process')
const realExecFileSync = childProcess.execFileSync
const realSpawnSync = childProcess.spawnSync
let syncSpawns = 0
const countedChildProcess = () => ({
  ...childProcess,
  execFileSync: (...args: Parameters<typeof realExecFileSync>) => { syncSpawns += 1; return realExecFileSync(...args) },
  spawnSync: (...args: Parameters<typeof realSpawnSync>) => { syncSpawns += 1; return realSpawnSync(...args) },
})
mock.module('child_process', countedChildProcess)
mock.module('node:child_process', countedChildProcess)

// Imported after the mock: a static import would hoist above it and bind
// `git/exec.ts` to the real module, leaving the counters at zero for good.
const sessionSnapshots = await import('@solus/server/git/session-snapshots')
const { initSessionBase, prepareTurnSnapshot, snapshotTurn } = sessionSnapshots
// Bind the real function now: the namespace binding is live and points at the
// mock once it is installed.
const realGetEpisodeDiff = sessionSnapshots.getEpisodeDiff
let episodeDiffCalls = 0
mock.module('@solus/server/git/session-snapshots', () => ({
  ...sessionSnapshots,
  getEpisodeDiff: (...args: Parameters<typeof realGetEpisodeDiff>) => {
    episodeDiffCalls += 1
    return realGetEpisodeDiff(...args)
  },
}))

let jobs: InstanceType<typeof import('@solus/server/review/guide-jobs')['ReviewGuideJobs']>

const temporaryDirectories: string[] = []
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  const { ReviewGuideJobs } = await import('@solus/server/review/guide-jobs')
  const { localGuideSource, prGuideSource } = await import('@solus/server/review/guide-sources')
  jobs = new ReviewGuideJobs(() => {}, { pr: prGuideSource, local: localGuideSource })
  // Guide runs and the git they start act for a caller; with none, the host (plans/019).
  const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')
  actAsHostForTests()
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.length = 0
})

/** Ask the job owner for a guide and wait for the run, as the `generateGuide` RPC does. */
async function generateGuide(
  dispatcher: AgentDispatcher,
  ctx: IpcContext,
  opts: ReviewGuideRequestOptions,
  onStatus?: (event: ReviewGuideStatusEvent) => void,
) {
  const job = await jobs.request({ ctx, dispatcher, opts, onStatus })
  return job ? job.completion : null
}

function git(cwd: string, args: string[]): string {
  const result = realSpawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

class CapturingDispatcher implements AgentDispatcher {
  request: AgentRunRequest | null = null

  runAgent(request: AgentRunRequest): AgentRun {
    this.request = request
    const context: AgentToolContext = {
      provider: request.provider,
      cwd: request.cwd,
      sessionId: () => undefined,
      parentToolUseId: () => undefined,
      abortSignal: new AbortController().signal,
      emit: () => {},
    }
    return {
      sessionId: Promise.resolve(null),
      done: request.tools[0].execute({
        title: 'Session change',
        summary: 'Reviews only the files changed by this session.',
        sections: [],
      }, context).then(() => ({
        sessionId: null,
        output: '',
        toolCallCount: 1,
        permissionDenials: [],
        exitCode: 0,
        signal: null,
      })),
      cancel() {},
      handle: {} as AgentRun['handle'],
    }
  }
}

function reviewContext(cwd: string, sessionId: string): IpcContext {
  return {
    session: {
      sessionId,
      provider: 'codex',
      agentSessionId: `thread-${sessionId}`,
      status: 'idle',
      workingDirectory: cwd,
      projectPath: cwd,
      preferredModel: null,
      reasoningEffort: 'medium',
      contextWindow: null,
      fastMode: false,
      permissionMode: 'plan',
      gitContext: null,
      worktreeBaseBranch: null,
      readOnlyReason: null,
    },
    statusBar: {
      workingDirectory: cwd,
      activeAgent: 'codex',
      permissionMode: 'plan',
      model: '',
      reasoningEffort: 'medium',
      defaultReasoningEffort: 'medium',
      reasoningLevels: ['medium'],
      supportsFastMode: false,
      fastMode: false,
      contextWindows: [],
    },
  }
}

describe('session review guide scope', () => {
  test('PR guides use the prepared base when local main is behind', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'solus-pr-guide-base-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'solus-pr-guide-data-'))
    temporaryDirectories.push(cwd, dataDir)
    process.env.SOLUS_DATA_DIR = dataDir
    git(cwd, ['init', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
    writeFileSync(join(cwd, 'base.txt'), 'old main\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'old main'])
    git(cwd, ['checkout', '-b', 'solus/pr-7'])
    writeFileSync(join(cwd, 'unrelated.txt'), 'upstream changes outside the PR\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'new upstream base'])
    const baseSha = git(cwd, ['rev-parse', 'HEAD'])
    writeFileSync(join(cwd, 'fix.txt'), 'the PR fix\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'PR fix'])
    const ctx = reviewContext(cwd, 'pr-guide')
    ctx.session.prReview = {
      host: 'github.com', owner: 'acme', repo: 'app', number: 7,
      title: 'PR fix', baseRef: 'main', headRef: 'fix', baseSha,
      headSha: git(cwd, ['rev-parse', 'HEAD']),
      headRepo: { owner: 'contributor', repo: 'app', isFork: true },
      worktreePath: cwd, branch: 'solus/pr-7',
    }
    const dispatcher = new CapturingDispatcher()
    const generated = await generateGuide(dispatcher, ctx, { scope: 'branch', agent: 'codex' })

    expect(generated?.guide.baseSha).toBe(baseSha)
    expect(generated?.key).toBe('solus__pr-7')
    expect(dispatcher.request?.prompt).toContain('the PR fix')
    expect(dispatcher.request?.prompt).not.toContain('upstream changes outside the PR')
    expect(generated?.guide.sections.flatMap(section => section.files.map(file => file.path)))
      .toEqual(['fix.txt'])
  })

  test('keeps a guide whose change moved during its run, and reports it outdated', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'solus-moved-guide-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'solus-moved-guide-data-'))
    temporaryDirectories.push(cwd, dataDir)
    process.env.SOLUS_DATA_DIR = dataDir

    git(cwd, ['init', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
    writeFileSync(join(cwd, 'change.txt'), 'base\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'base'])
    git(cwd, ['checkout', '-b', 'feature'])
    writeFileSync(join(cwd, 'change.txt'), 'base\nreviewed change\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'feature'])

    const dispatcher = new CapturingDispatcher()
    const runAgent = dispatcher.runAgent.bind(dispatcher)
    dispatcher.runAgent = (request) => {
      writeFileSync(join(cwd, 'change.txt'), 'base\nreviewed change\nedited during the run\n')
      return runAgent(request)
    }
    const ctx = reviewContext(cwd, 'moved-guide-session')
    const target = { kind: 'branch', targetBranch: 'main' } as const
    const statuses: string[] = []
    const generated = await generateGuide(dispatcher, ctx, { target, agent: 'codex' }, (event) => statuses.push(event.status))

    // WHY: the run cost a model call. A guide for the content it read is still
    // worth reading, as long as the reader is told the change moved on.
    expect(generated).toMatchObject({ persisted: true, outdated: true })
    expect(statuses.at(-1)).toBe('outdated')
    expect((await jobs.status(ctx, { target }))?.status).toBe('outdated')
  })

  test('inline guides give the provider only completed turn ranges, including the requested focus', async () => {
    const { inlineSessionGuidePrompt } = await import('@solus/server/review/inline-session-guide')
    const cwd = mkdtempSync(join(tmpdir(), 'solus-inline-guide-'))
    temporaryDirectories.push(cwd)
    git(cwd, ['init', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
    git(cwd, ['commit', '--allow-empty', '-m', 'base'])
    const sessionId = 'solus-id'
    await initSessionBase(cwd, sessionId, git(cwd, ['rev-parse', 'HEAD']))
    for (const index of [1, 2]) {
      writeFileSync(join(cwd, 'unrelated.txt'), `unrelated edit ${index}`)
      await prepareTurnSnapshot(cwd, cwd, sessionId)
      writeFileSync(join(cwd, 'session.txt'), `session edit ${index}`)
      await snapshotTurn(cwd, cwd, sessionId)
    }
    const prompt = await inlineSessionGuidePrompt('/review-guide focus on tests', sessionId, cwd)
    const { codexItemToMessage } = await import('@solus/server/execution/agents/codex/codex-utils')
    expect(codexItemToMessage({ type: 'userMessage', content: [{ type: 'text', text: prompt }] }, 0)?.content).toBe('/review-guide focus on tests')
    expect(prompt).toContain('```review-guide')
    const ranges = [...prompt.matchAll(/Turn (\d+): ([a-f0-9]+) ([a-f0-9]+)/g)]
    expect(ranges.map(match => match[1])).toEqual(['1', '2'])
    for (const [, , before, after] of ranges) {
      expect(git(cwd, ['diff', '--name-only', before, after])).toBe('session.txt')
    }
    const empty = await inlineSessionGuidePrompt('/review-guide', 'other', cwd)
    expect(empty).toContain('no captured')
    expect(stripInjectedContext(empty)).toBe('/review-guide')
  })

  test('a branch probe with no guide answers null without diffing the working tree', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'solus-branch-guide-probe-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'solus-branch-guide-probe-data-'))
    temporaryDirectories.push(cwd, dataDir)
    process.env.SOLUS_DATA_DIR = dataDir

    git(cwd, ['init', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
    writeFileSync(join(cwd, 'change.txt'), 'base\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'base'])
    git(cwd, ['checkout', '-b', 'feature'])
    writeFileSync(join(cwd, 'change.txt'), 'base\nedit\n')
    const ctx = reviewContext(cwd, 'never-reviewed-branch')

    // WHY: the Git section probes on every working-tree change while an agent
    // edits. Most branches have no guide, and answering that must not cost a
    // full diff of the tree each time a file is saved.
    episodeDiffCalls = 0
    syncSpawns = 0
    expect(await jobs.status(ctx, { scope: 'branch' })).toBeNull()
    expect(episodeDiffCalls).toBe(0)
    expect(syncSpawns).toBe(0)

    await generateGuide(new CapturingDispatcher(), ctx, { scope: 'branch', agent: 'codex' })
    episodeDiffCalls = 0
    expect((await jobs.status(ctx, { scope: 'branch' }))?.status).toBe('ready')
    expect(episodeDiffCalls).toBeGreaterThan(0)
  })
})
