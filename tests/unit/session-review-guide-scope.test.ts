import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcContext } from '@solus/contracts/types'
import type { AgentDispatcher, AgentRun, AgentRunRequest } from '@solus/server/agents/agent-runner'
import type { AgentToolContext } from '@solus/server/agents/tools/agent-tool'
import {
  initSessionBase,
  prepareTurnSnapshot,
  snapshotTurn,
} from '@solus/server/git/session-snapshots'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type GuideProducerModule = typeof import('@solus/server/review/guide-producer')
let generateGuide: GuideProducerModule['generateGuide']
let cancelGenerateGuide: GuideProducerModule['cancelGenerateGuide']
let getReviewGuideStatus: GuideProducerModule['getReviewGuideStatus']

const temporaryDirectories: string[] = []
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  ;({ generateGuide, cancelGenerateGuide, getReviewGuideStatus } = await import('@solus/server/review/guide-producer'))
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.length = 0
})

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
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
    window: { viewMode: 'editor' },
    settings: {
      themeMode: 'system',
      isDark: false,
      soundEnabled: false,
      voiceModeEnabled: false,
      vadSilenceMs: 800,
      defaultEditor: null,
      fallbackTerminal: null,
      activeAgent: 'codex',
      reviewAgent: 'codex',
      reviewModel: null,
      reviewReasoning: null,
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
      turnChangedFiles: ['session.txt'],
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
      turnChangedFiles: ['session.txt'],
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
      turnChangedFiles: ['session.txt'],
    })

    expect(await cancelGenerateGuide(ctx, { target: { kind: 'session' } })).toBe(true)
    expect(dispatcher.cancelled).toBe(true)
    expect(await generation).toBeNull()
  })
})
