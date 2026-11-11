import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { EventEmitter } from 'node:events'
import type { BackendSession, SessionStatus } from '@solus/contracts/types'
import type { AgentBackend, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let ProviderEvents: typeof import('@solus/server/execution/sessions/provider-events')['ProviderEvents']
beforeAll(async () => {
  ;({ ProviderEvents } = await import('@solus/server/execution/sessions/provider-events'))
})

// WHY: one backend runs many sessions. An error or an exit that belongs to one
// run must settle that run only. A launch that fails before the provider names
// its thread has no provider id, so the event carries the run itself.
// Otherwise one bad launch, or one ordinary turn end, fails every other launch
// waiting on that backend.

function run(sessionId: string, agentSessionId: string | null = null): RunHandle {
  return {
    agentSessionId, sessionId, persistence: 'session', startedAt: 0, toolCallCount: 0,
    sawPermissionRequest: false, permissionDenials: [], abortController: new AbortController(),
    runPromise: Promise.resolve(), _resolveRun: () => {}, _rejectRun: () => {},
  }
}

function setup(pending: RunHandle[], sessions: BackendSession[] = []) {
  const statuses = new Map<string, SessionStatus>()
  const rejected: string[] = []
  const pendingStarts = new Map(pending.map((handle) => [handle, {
    reject: () => rejected.push(handle.sessionId!),
  }]))
  const activeSessions = new Map(sessions.map((session) => [session.sessionId, session]))
  const runtime = {
    activeSessions,
    agentSessionToSession: new Map(sessions.map((session) => [session.agentSessionId, session.sessionId])),
    activeRunRequests: new Map(),
    missingRunCounts: new Map(),
    turnLog: new Map(),
    turnStops: new Map(),
    launcher: { pendingStarts },
    orchestration: undefined,
    statuses: { setStatus: (sessionId: string, status: SessionStatus) => statuses.set(sessionId, status) },
    inputRequests: { expirePendingInput: () => {} },
    sessionEmitter: { recordTerminal: () => {} },
    rateLimitPark: { currentRateLimitEvent: () => null },
    handoffs: { handoffCarry: { settle: () => {} } },
    scheduler: { hasReadyQueuedRequest: () => false, processQueueForSession: () => {} },
    flushPendingSession: () => {},
    emitError: () => {},
    publish: () => {},
  }
  const backend = Object.assign(new EventEmitter(), {
    id: 'claude-code' as const,
    getPendingHandles: () => [...pending],
    getEnrichedError: () => ({ message: '', stderrTail: [], stdoutTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0, sawPermissionRequest: false, permissionDenials: [] }),
  })
  // SAFETY: the error and exit handlers read only the members above.
  new ProviderEvents(runtime as unknown as SessionRuntime).wire(backend as unknown as AgentBackend)
  return { backend, statuses, rejected }
}

describe('an error before session_init', () => {
  test('fails only the run it names', () => {
    const failing = run('solus-fails')
    const healthy = run('solus-lives')
    const { backend, statuses, rejected } = setup([failing, healthy])

    backend.emit('error', null, new Error('spawn failed'), failing)

    expect(rejected).toEqual(['solus-fails'])
    expect([...statuses]).toEqual([['solus-fails', 'dead']])
  })

  test('without a run, still fails every pending launch', () => {
    // No emitter sends this form now; it stays so an error is never lost.
    const first = run('solus-first')
    const second = run('solus-second')
    const { backend, statuses, rejected } = setup([first, second])

    backend.emit('error', null, new Error('spawn failed'))

    expect(rejected).toEqual(['solus-first', 'solus-second'])
    expect([...statuses.keys()]).toEqual(['solus-first', 'solus-second'])
  })
})

describe('an exit', () => {
  test('of a running session leaves another session’s launch alone', () => {
    const finished = run('solus-finished', 'thread-finished')
    const launching = run('solus-launching')
    const session = {
      sessionId: 'solus-finished', agentSessionId: 'thread-finished', backendId: 'claude-code', status: 'running',
      pendingInputEvents: [], lastActivityAt: 0, promptCount: 1,
    } as BackendSession
    const { backend, statuses, rejected } = setup([launching], [session])

    backend.emit('exit', 'thread-finished', 0, null, finished)

    expect(rejected).toEqual([])
    expect([...statuses]).toEqual([['solus-finished', 'completed']])
  })

  test('before session_init rejects only the launch it names', () => {
    const exiting = run('solus-exits')
    const launching = run('solus-launching')
    const { backend, rejected } = setup([exiting, launching])

    backend.emit('exit', null, null, 'SIGINT', exiting)

    expect(rejected).toEqual(['solus-exits'])
  })
})
