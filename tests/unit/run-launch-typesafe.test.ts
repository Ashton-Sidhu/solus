import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import type { AgentTool } from '@solus/server/execution/agents/tools/agent-tool'
import type { AgentMetadata, SessionRunInput } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// The account that holds the run's person's TypeSafe key cannot be reached.
mock.module('@solus/server/typesafe/credentials', () => ({
  typeSafeKey: () => Promise.reject(new Error('Your account connection is unavailable. Open Connections on the account website.')),
  typeSafeKeyStatus: () => Promise.reject(new Error('unavailable')),
  setTypeSafeApiKey: () => {},
}))

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let runtime: typeof import('@solus/server/execution/session-runtime')

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-run-launch-typesafe-'))
  process.env.SOLUS_DATA_DIR = dataDir
  runtime = await import('@solus/server/execution/session-runtime')
})

afterAll(async () => {
  ;(await import('@solus/server/data/insights/metrics-db')).closeMetricsDb()
  ;(await import('@solus/server/db')).closeDb()
  rmSync(dataDir, { recursive: true, force: true })
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

function input(): SessionRunInput {
  return {
    provider: 'claude-code', agentSessionId: null, forked: false, workingDirectory: process.cwd(), projectPath: process.cwd(),
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null,
    model: 'claude-opus-5', preferredModel: 'claude-opus-5', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'supervised', rateLimitBehavior: 'queue', extraInstructions: '',
  }
}

function tool(name: string): AgentTool {
  return { name, description: name, inputFields: {}, execute: async () => ({ ok: true, text: '' }) }
}

describe('a run whose person\'s TypeSafe key cannot be read', () => {
  test('still reaches the agent, without ask_jev', async () => {
    // WHY: the key only decides whether one tool joins the run. An account that does
    // not answer must not fail the person's prompt.
    const backend = new RecordingBackend()
    const plane = new runtime.SessionRuntime(new Map([['claude-code', backend]]))
    plane.on('error', () => {})

    const lifecycle = await plane.runTurn({
      target: { kind: 'new-session' }, sessionId: 'solus-typesafe-unreadable', input: input(),
      tools: [tool('ask_jev'), tool('create_task')],
      options: { prompt: 'do the work', promptSource: 'typed' },
    })
    await lifecycle.agentSessionId

    expect(backend.runs).toHaveLength(1)
    const names = backend.runs[0]!.tools.map((each) => each.name)
    expect(names).toContain('create_task')
    expect(names).not.toContain('ask_jev')
    plane.shutdown()
  })
})
