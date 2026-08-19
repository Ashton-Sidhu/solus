import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'
import type { AgentRunRequest } from '@solus/server/agents/agent-runner'
import type { RunHandle } from '@solus/server/agents/agent-backend'
import type { AgentBackend } from '@solus/server/agents/agent-backend'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let ControlPlane: typeof import('@solus/server/control-plane')['ControlPlane']

beforeAll(async () => {
  ;({ ControlPlane } = await import('@solus/server/control-plane'))
})

function backend() {
  const emitter = new EventEmitter() as EventEmitter & Pick<AgentBackend, 'id' | 'metadata' | 'permissions' | 'startRun' | 'getPendingHandles' | 'shutdown'>
  let handle: RunHandle
  emitter.id = 'codex'
  emitter.metadata = { id: 'codex', label: 'Codex', models: [], defaultModel: '' }
  emitter.permissions = {}
  emitter.startRun = (request: AgentRunRequest) => {
    let resolve!: () => void
    const runPromise = new Promise<void>((res) => { resolve = res })
    handle = {
      agentSessionId: request.sessionId ?? null,
      persistence: request.persistence,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController: new AbortController(),
      runPromise,
      _resolveRun: resolve,
      _rejectRun: () => {},
    }
    return handle
  }
  emitter.getPendingHandles = () => []
  emitter.shutdown = () => {}
  return {
    value: emitter,
    complete: () => handle._resolveRun(),
  }
}

const planes: Array<InstanceType<typeof ControlPlane>> = []
afterEach(() => {
  for (const plane of planes.splice(0)) plane.shutdown()
})

describe('ControlPlane.runAgent', () => {
  test('keeps unattended work active only for the lifetime of the run', async () => {
    const fake = backend()
    const plane = new ControlPlane(new Map([['codex', fake.value as never]]))
    planes.push(plane)
    const request: AgentRunRequest = {
      provider: 'codex',
      prompt: 'utility work',
      cwd: '/tmp/project',
      tools: [],
      permissionMode: 'plan',
      persistence: 'ephemeral',
      unattended: true,
    }

    const run = plane.runAgent(request)
    const internals = plane as unknown as {
      activeAgentRuns: Set<unknown>
      activeSessions: Map<string, unknown>
      watches: Map<string, Set<string>>
      requestQueue: Map<string, unknown>
    }

    expect(internals.activeAgentRuns.size).toBe(1)
    expect(plane.hasActiveWork()).toBe(true)
    expect(internals.activeSessions.size).toBe(0)
    expect(internals.watches.size).toBe(0)
    expect(internals.requestQueue.size).toBe(0)

    fake.complete()
    await run.done
    await Promise.resolve()
    expect(internals.activeAgentRuns.size).toBe(0)
    expect(plane.hasActiveWork()).toBe(false)
  })

  test('does not hold active work for an interactive run parked outside a running session', async () => {
    // WHY: interactive sessions use their normalized status to release the
    // macOS power blocker while waiting for permission or user input.
    const fake = backend()
    const plane = new ControlPlane(new Map([['codex', fake.value as never]]))
    planes.push(plane)

    const run = plane.runAgent({
      provider: 'codex',
      prompt: 'interactive work',
      cwd: '/tmp/project',
      tools: [],
      permissionMode: 'ask',
      persistence: 'session',
    })

    expect(plane.hasActiveWork()).toBe(false)
    fake.complete()
    await run.done
  })
})

describe('ControlPlane setup cancellation', () => {
  test('cancels setup before an agent handle exists', () => {
    // WHY: worktree setup starts before the backend creates a RunHandle. Stop
    // must still own that phase or Ctrl-C lets setup continue into a live run.
    const plane = new ControlPlane(new Map())
    planes.push(plane)
    const setupController = new AbortController()
    const internals = plane as unknown as {
      pendingSetupControllers: Map<string, AbortController>
    }
    internals.pendingSetupControllers.set('session-1', setupController)

    // A session with setup in flight is addressable before any run exists.
    plane.watchSession({ sessionId: 'session-1' }, 'ws:a')
    const cancelled = plane.stopSession('session-1')

    expect(cancelled).toBe(true)
    expect(setupController.signal.aborted).toBe(true)
    expect(internals.pendingSetupControllers.has('session-1')).toBe(false)
  })
})
