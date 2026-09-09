import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { AgentRunRequest } from '@solus/server/agents/agent-runner'
import type { AgentBackend, RunHandle } from '@solus/server/agents/agent-backend'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let ControlPlane: typeof import('@solus/server/control-plane')['ControlPlane']
let cwd: string

beforeAll(async () => {
  ;({ ControlPlane } = await import('@solus/server/control-plane'))
  cwd = mkdtempSync(join(tmpdir(), 'solus-automation-model-'))
  spawnSync('git', ['init', '-q'], { cwd })
})

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true })
})

/** Records the run request the control plane hands the provider, which is where
 *  the model an automation really uses becomes observable. */
function backend(defaultModel: string) {
  const requests: AgentRunRequest[] = []
  const emitter = new EventEmitter() as EventEmitter & Pick<AgentBackend, 'id' | 'metadata' | 'permissions' | 'startRun' | 'getPendingHandles' | 'shutdown'>
  let handle: RunHandle
  emitter.id = 'claude-code'
  emitter.metadata = { id: 'claude-code', label: 'Claude Code', models: [], defaultModel }
  emitter.permissions = {}
  emitter.startRun = (request: AgentRunRequest) => {
    requests.push(request)
    // The run settles immediately: this test is about what the control plane
    // asks for, not what the provider does with it.
    handle = {
      agentSessionId: (request.conversation?.kind === 'resume' ? request.conversation.threadId : null) ?? 'agent-session-1',
      persistence: request.persistence,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController: new AbortController(),
      runPromise: Promise.resolve(),
      _resolveRun: () => {},
      _rejectRun: () => {},
    }
    return handle
  }
  emitter.getPendingHandles = () => []
  emitter.shutdown = () => {}
  return { value: emitter, requests }
}

const planes: Array<InstanceType<typeof ControlPlane>> = []
afterEach(() => {
  for (const plane of planes.splice(0)) plane.shutdown()
})

describe('automation model resolution', () => {
  test('an automation that names no model runs on the provider default, with that model window', async () => {
    // WHY: an automation stores modelId null to mean "the provider default".
    // Passing that through as an empty model let the provider CLI choose its
    // own default instead of ours, and left the context window unresolved —
    // so scheduled work silently ran on a different model than the one the
    // automation is documented to use.
    const fake = backend('claude-opus-5')
    const plane = new ControlPlane(new Map([['claude-code', fake.value as never]]))
    planes.push(plane)

    const session = await plane.startAutomationSession({
      prompt: 'sync the docs',
      automationId: 'automation-1',
      automationName: 'Docs sync',
      provider: 'claude-code',
      modelId: null,
      reasoningEffort: 'medium',
      cwd,
    })
    // The fake never reports a provider session, so the lifecycle ends in an
    // error. The request it was launched with is what this test is about.
    await session.done.catch(() => {})

    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]?.model).toBe('claude-opus-5')
    expect(fake.requests[0]?.contextWindow).toBe(1_000_000)
  })

  test('an automation that pins a model keeps it', async () => {
    const fake = backend('claude-opus-5')
    const plane = new ControlPlane(new Map([['claude-code', fake.value as never]]))
    planes.push(plane)

    const session = await plane.startAutomationSession({
      prompt: 'sync the docs',
      automationId: 'automation-1',
      automationName: 'Docs sync',
      provider: 'claude-code',
      modelId: 'claude-sonnet-5',
      reasoningEffort: 'medium',
      cwd,
    })
    await session.done.catch(() => {})

    expect(fake.requests[0]?.model).toBe('claude-sonnet-5')
  })
})
