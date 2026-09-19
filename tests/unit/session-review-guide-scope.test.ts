import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { IpcContext } from '@solus/contracts/types'
import type { AgentDispatcher, AgentRun, AgentRunRequest } from '@solus/server/agents/agent-runner'
import type { AgentToolContext } from '@solus/server/agents/tools/agent-tool'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// A synchronous spawn on the main thread stalls every transcript read behind
// it. The status path must never take one; count them at the module boundary.
const childProcess = await import('node:child_process')
const realExecFileSync = childProcess.execFileSync
const realSpawnSync = childProcess.spawnSync
const realExecFile = childProcess.execFile
let syncSpawns = 0
let gitSpawns = 0
// `git/exec.ts` promisifies execFile, which reads the custom promisify hook;
// the counter must keep that hook or the promise resolves to the wrong shape.
const countedExecFile = Object.assign(
  ((...args: Parameters<typeof realExecFile>) => {
    if (args[0] === 'git') gitSpawns += 1
    return realExecFile(...args)
  }) as typeof realExecFile,
  {
    [promisify.custom]: (...args: Parameters<typeof realExecFile>) => {
      if (args[0] === 'git') gitSpawns += 1
      return (realExecFile as unknown as { [promisify.custom]: (...inner: unknown[]) => Promise<unknown> })[promisify.custom](...args)
    },
  },
)
const countedChildProcess = () => ({
  ...childProcess,
  execFileSync: (...args: Parameters<typeof realExecFileSync>) => { syncSpawns += 1; return realExecFileSync(...args) },
  spawnSync: (...args: Parameters<typeof realSpawnSync>) => { syncSpawns += 1; return realSpawnSync(...args) },
  execFile: countedExecFile,
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

type GuideProducerModule = typeof import('@solus/server/review/guide-producer')
let generateGuide: GuideProducerModule['generateGuide']
let cancelGenerateGuide: GuideProducerModule['cancelGenerateGuide']
let getReviewGuideStatus: GuideProducerModule['getReviewGuideStatus']
let getSessionGuideStatuses: GuideProducerModule['getSessionGuideStatuses']

const temporaryDirectories: string[] = []
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  ;({ generateGuide, cancelGenerateGuide, getReviewGuideStatus, getSessionGuideStatuses } = await import('@solus/server/review/guide-producer'))
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.length = 0
})

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
      solusSessionId: () => undefined,
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

class BlockingDispatcher implements AgentDispatcher {
  cancelled = false
  private finishRun: (() => void) | null = null
  readonly started: Promise<void>
  private markStarted: (() => void) | null = null

  constructor() {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve
    })
  }

  runAgent(request: AgentRunRequest): AgentRun {
    const done = new Promise<Awaited<AgentRun['done']>>((resolve) => {
      this.finishRun = () => resolve({
        sessionId: null,
        output: '',
        toolCallCount: 0,
        permissionDenials: [],
        exitCode: 0,
        signal: null,
      })
    })
    this.markStarted?.()
    return {
      sessionId: Promise.resolve(null),
      done,
      cancel: () => {
        this.cancelled = true
        this.finishRun?.()
      },
      handle: {} as AgentRun['handle'],
    }
  }
}

function reviewContext(cwd: string, sessionId: string): IpcContext {
  return {
    session: {
      sessionId: 'solus-session',
      provider: 'codex',
      agentSessionId: sessionId,
      status: 'idle',
      workingDirectory: cwd,
      projectPath: cwd,
      additionalDirs: [],
      preferredModel: null,
      reasoningEffort: 'medium',
      contextWindow: null,
      fastMode: false,
      permissionMode: 'plan',
      gitContext: null,
      worktreeBaseBranch: null,
      sessionChangedFiles: ['session.txt'],
      readOnlyReason: null,
      latestCheckpointId: null,
    },
    settings: {
      themeMode: 'system',
      isDark: false,
      voiceModeEnabled: false,
      vadSilenceMs: 800,
      defaultEditor: null,
      fallbackTerminal: null,
      activeAgent: 'codex',
      reviewAgent: 'codex',
      reviewModel: 'gpt-5.6-sol',
      reviewReasoning: 'medium',
      reviewGuideInstructions: '',
      stackedPrsEnabled: false,
      reviewWarmingEnabled: false,
      rateLimitBehavior: 'ask',
      fontFamily: 'inter',
      fontSize: 14,
      codeFontFamily: 'sf-mono',
      codeFontSize: 13,
      extraInstructions: '',
      modelInstructions: {},
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

  test('can regenerate from the previous guide head and keeps that guide current', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'solus-incremental-guide-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'solus-incremental-guide-data-'))
    temporaryDirectories.push(cwd, dataDir)
    process.env.SOLUS_DATA_DIR = dataDir

    git(cwd, ['init', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
    writeFileSync(join(cwd, 'change.txt'), 'base\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'base'])
    git(cwd, ['checkout', '-b', 'feature'])
    writeFileSync(join(cwd, 'change.txt'), 'base\nfirst commit\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'first'])
    const previousGuideHead = git(cwd, ['rev-parse', 'HEAD'])

    writeFileSync(join(cwd, 'change.txt'), 'base\nfirst commit\nnew commit only\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'second'])

    const dispatcher = new CapturingDispatcher()
    const ctx = reviewContext(cwd, 'incremental-guide-session')
    const generated = await generateGuide(dispatcher, ctx, {
      target: { kind: 'branch', targetBranch: 'main' },
      regenerationBaseSha: previousGuideHead,
      agent: 'codex',
    })

    // WHY: A reviewer who already read the old guide needs only the new commit,
    // not a second explanation of the whole branch.
    expect(dispatcher.request?.prompt).toContain('new commit only')
    expect(dispatcher.request?.prompt).not.toContain('+first commit')
    expect(generated?.guide.baseSha).toBe(previousGuideHead)
    expect((await getReviewGuideStatus(ctx, {
      target: { kind: 'branch', targetBranch: 'main' },
    }))?.status).toBe('ready')
  })

  test('authors from the captured session snapshot instead of the shared live worktree', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'solus-session-guide-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'solus-session-guide-data-'))
    temporaryDirectories.push(cwd, dataDir)
    process.env.SOLUS_DATA_DIR = dataDir

    git(cwd, ['init', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
    writeFileSync(join(cwd, 'session.txt'), 'base\n')
    writeFileSync(join(cwd, 'unrelated.txt'), 'base\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'base'])
    const baseSha = git(cwd, ['rev-parse', 'HEAD'])
    const sessionId = 'provider-session'

    await initSessionBase(cwd, sessionId, baseSha)
    await prepareTurnSnapshot(cwd, cwd, sessionId)
    writeFileSync(join(cwd, 'session.txt'), 'base\nsession edit\n')
    writeFileSync(join(cwd, 'unrelated.txt'), 'base\nunrelated edit\n')
    await snapshotTurn(cwd, cwd, sessionId, {
      sessionChangedFiles: ['session.txt'],
    })

    const dispatcher = new CapturingDispatcher()
    const generated = await generateGuide(
      dispatcher,
      reviewContext(cwd, sessionId),
      { target: { kind: 'session' }, agent: 'codex' },
    )

    expect(dispatcher.request?.prompt).toContain('session edit')
    expect(dispatcher.request?.prompt).not.toContain('unrelated edit')
    expect(generated?.guide.sections.flatMap((section) => section.files.map((file) => file.path)))
      .toEqual(['session.txt'])
  })

  test('answers a batch of session probes in request order without failing on a missing guide', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'solus-session-guide-batch-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'solus-session-guide-batch-data-'))
    temporaryDirectories.push(cwd, dataDir)
    process.env.SOLUS_DATA_DIR = dataDir

    git(cwd, ['init', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
    writeFileSync(join(cwd, 'session.txt'), 'base\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'base'])
    const baseSha = git(cwd, ['rev-parse', 'HEAD'])
    const sessionId = 'provider-session-batch'

    await initSessionBase(cwd, sessionId, baseSha)
    await prepareTurnSnapshot(cwd, cwd, sessionId)
    writeFileSync(join(cwd, 'session.txt'), 'base\nsession edit\n')
    await snapshotTurn(cwd, cwd, sessionId, { sessionChangedFiles: ['session.txt'] })
    await generateGuide(new CapturingDispatcher(), reviewContext(cwd, sessionId), { target: { kind: 'session' }, agent: 'codex' })

    // WHY: a restored workspace probes every tab in one request. Each answer
    // must land on the tab that asked, and a tab with no guide (or no
    // checkout at all) answers null instead of sinking the whole batch.
    syncSpawns = 0
    const statuses = await getSessionGuideStatuses([
      reviewContext(cwd, 'never-reviewed').session,
      reviewContext(cwd, sessionId).session,
      reviewContext('~', 'no-checkout').session,
    ])

    expect(statuses.map((event) => event?.status ?? null)).toEqual([null, 'ready', null])
    // WHY: 89 restored tabs once cost ~270 synchronous git spawns and held the
    // first transcript page for four seconds. A probe must not block the loop.
    expect(syncSpawns).toBe(0)
    expect(statuses[1]?.key).toBe(`session-${sessionId}`)
  })

  test('a batch of sessions on one checkout reads that checkout once', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'solus-session-guide-shared-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'solus-session-guide-shared-data-'))
    temporaryDirectories.push(cwd, dataDir)
    process.env.SOLUS_DATA_DIR = dataDir
    git(cwd, ['init', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
    writeFileSync(join(cwd, 'session.txt'), 'base\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'base'])

    // WHY: a restored workspace probes every tab at once, and those tabs are
    // mostly sessions of one project. The transcript that is loading at the
    // same time competes with every git process the batch starts, so the
    // checkout's root, branch, target, and head are read once for the batch —
    // not four times per session. Six is the cold cost of one checkout (the
    // default-branch lookup alone is up to three reads); a per-session cost
    // would put five sessions well past it.
    gitSpawns = 0
    const statuses = await getSessionGuideStatuses(
      ['one', 'two', 'three', 'four', 'five'].map((sessionId) => reviewContext(cwd, sessionId).session),
    )
    expect(statuses).toEqual([null, null, null, null, null])
    expect(gitSpawns).toBeLessThanOrEqual(6)
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
    expect(await getReviewGuideStatus(ctx, { scope: 'branch' })).toBeNull()
    expect(episodeDiffCalls).toBe(0)
    expect(syncSpawns).toBe(0)

    await generateGuide(new CapturingDispatcher(), ctx, { scope: 'branch', agent: 'codex' })
    episodeDiffCalls = 0
    expect((await getReviewGuideStatus(ctx, { scope: 'branch' }))?.status).toBe('ready')
    expect(episodeDiffCalls).toBeGreaterThan(0)
  })

  test('stops the active author after the session snapshot changes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'solus-session-guide-cancel-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'solus-session-guide-cancel-data-'))
    temporaryDirectories.push(cwd, dataDir)
    process.env.SOLUS_DATA_DIR = dataDir

    git(cwd, ['init', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
    writeFileSync(join(cwd, 'session.txt'), 'base\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-m', 'base'])
    const baseSha = git(cwd, ['rev-parse', 'HEAD'])
    const sessionId = 'provider-session-cancel'
    const ctx = reviewContext(cwd, sessionId)

    await initSessionBase(cwd, sessionId, baseSha)
    await prepareTurnSnapshot(cwd, cwd, sessionId)
    writeFileSync(join(cwd, 'session.txt'), 'base\nfirst edit\n')
    await snapshotTurn(cwd, cwd, sessionId, {
      sessionChangedFiles: ['session.txt'],
    })

    const dispatcher = new BlockingDispatcher()
    const generation = generateGuide(
      dispatcher,
      ctx,
      { target: { kind: 'session' }, agent: 'codex' },
    )
    await dispatcher.started

    // WHY: Stop identifies the stable review target. It must not depend on the
    // fingerprint that was current when hidden authoring began.
    await prepareTurnSnapshot(cwd, cwd, sessionId)
    writeFileSync(join(cwd, 'session.txt'), 'base\nfirst edit\nsecond edit\n')
    await snapshotTurn(cwd, cwd, sessionId, {
      sessionChangedFiles: ['session.txt'],
    })

    expect(await cancelGenerateGuide(ctx, { target: { kind: 'session' } })).toBe(true)
    expect(dispatcher.cancelled).toBe(true)
    expect(await generation).toBeNull()
  })
})
