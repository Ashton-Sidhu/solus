import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import type { AgentMetadata, SessionRunInput } from '@solus/contracts/types'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import { git } from '@solus/server/git/exec'

mock.module('node:sqlite', () => ({ DatabaseSync }))
actAsHostForTests()

// docs/plans/codebases.md §6: the client sends no folder paths. At each turn
// start the server reads the folders of the session and gives the granted ones
// to the provider, with the block that tells the agent what they are.

const previousDataDir = process.env.SOLUS_DATA_DIR
let root: string
let runtime: typeof import('@solus/server/execution/session-runtime')

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-session-folders-launch-')))
  process.env.SOLUS_DATA_DIR = join(root, 'data')
  runtime = await import('@solus/server/execution/session-runtime')
})

afterAll(async () => {
  ;(await import('@solus/server/data/insights/metrics-db')).closeMetricsDb()
  ;(await import('@solus/server/db')).closeDb()
  rmSync(root, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

class Permissions implements PermissionResponder {
  getPendingInfo(): undefined { return undefined }
  respondToPermission(): boolean { return false }
  respondToQuestion(): boolean { return false }
  clearPendingForSession(): void {}
  setCurrentSessionId(): void {}
}

/** A backend that records each run it is handed and starts it at once. */
class RecordingBackend extends EventEmitter implements AgentBackend {
  readonly id = 'claude-code' as const
  readonly metadata: AgentMetadata = { id: 'claude-code', label: 'Claude Code', models: [], defaultModel: 'claude-sonnet-5' }
  readonly permissions = new Permissions()
  readonly runs: AgentRunRequest[] = []

  startRun(request: AgentRunRequest): RunHandle {
    this.runs.push(request)
    return {
      agentSessionId: 'claude-session-1',
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

function input(codebaseId: string | null): SessionRunInput {
  return {
    codebaseId,
    provider: 'claude-code', agentSessionId: null, forked: false, workingDirectory: join(root, 'api'), projectPath: join(root, 'api'),
    gitContext: null, worktreeBaseBranch: null, contextWindow: null,
    model: 'claude-opus-5', preferredModel: 'claude-opus-5', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'supervised', rateLimitBehavior: 'queue', extraInstructions: '',
  }
}

test('the provider of a turn gets the folders of the session and the block that names them', async () => {
  const { saveCodebase } = await import('@solus/server/data/codebases/codebases')
  const { getInstallationId } = await import('@solus/server/admission/auth')
  mkdirSync(join(root, 'api'))
  mkdirSync(join(root, 'real/web'), { recursive: true })
  git(['init', '-b', 'main'], join(root, 'real/web'))
  // The person named the repository through a link: the provider gets the named path and the real one.
  symlinkSync(join(root, 'real/web'), join(root, 'web'))
  const codebase = await saveCodebase('local', 'owner', {
    id: 'codebase-shop', name: 'shop', updatedAt: 1_000, deletedAt: null,
    roots: [{ installationId: getInstallationId(), path: join(root, 'web'), name: '' }, { installationId: 'installation-other', path: '/srv/infra', name: '' }],
  })
  const backend = new RecordingBackend()
  const plane = new runtime.SessionRuntime(new Map([['claude-code', backend]]))
  plane.on('error', () => {})
  try {
    const lifecycle = await plane.runTurn({
      target: { kind: 'new-session' }, sessionId: 'solus-with-codebase', input: input(codebase.id), tools: [],
      options: { prompt: 'do the work', promptSource: 'typed' },
    })
    await lifecycle.agentSessionId

    const run = backend.runs[0]!
    expect(run.additionalDirectories).toEqual([join(root, 'web'), join(root, 'real/web')])
    expect(run.codebase).toEqual({
      name: 'shop',
      workingDirectory: { name: 'api', path: join(root, 'api'), state: 'plain' },
      folders: [{ name: 'web', path: join(root, 'web'), state: 'git' }],
      otherHosts: [{ name: 'infra', path: '/srv/infra', host: 'installation-other' }],
    })
    // The session start writes the codebase to the record of the session.
    expect(plane.sessionFolders.recordFields('solus-with-codebase')).toEqual({ codebaseId: codebase.id })

    // A session with one working directory gets no folder and no block.
    const plain = await plane.runTurn({
      target: { kind: 'new-session' }, sessionId: 'solus-plain', input: input(null), tools: [],
      options: { prompt: 'do the work', promptSource: 'typed' },
    })
    await plain.agentSessionId
    expect(backend.runs[1]!.additionalDirectories).toEqual([])
    expect(backend.runs[1]!.codebase).toBeUndefined()
  } finally {
    plane.shutdown()
  }
})
