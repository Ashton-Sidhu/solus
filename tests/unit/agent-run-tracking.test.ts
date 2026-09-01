import { describe, expect, test } from 'bun:test'
import { BaseAgentBackend } from '../../packages/server/src/agents/base-backend'
import type { RunHandle } from '../../packages/server/src/agents/agent-backend'

/**
 * `runTrackingSnapshot` exists for one reason: when the run watchdog declares a
 * session dead it emits `exitCode: null` with no stderr, so the log line is the
 * only account of why. These tests pin the two facts that line has to be able to
 * distinguish — a run alive under a different thread id, and a run that ended.
 * If either stops holding, the diagnostic reports nothing.
 */

class TestBackend extends BaseAgentBackend {
  start(handle: RunHandle): void {
    this.pendingRuns.push(handle)
  }

  init(handle: RunHandle, agentSessionId: string): void {
    this.promoteToActive(handle, agentSessionId)
  }

  finish(handle: RunHandle): void {
    this.finishRun(handle)
  }
}

function makeHandle(sessionId: string): RunHandle {
  return {
    agentSessionId: null,
    sessionId,
    persistence: 'session',
    startedAt: Date.now(),
    toolCallCount: 0,
    sawPermissionRequest: false,
    permissionDenials: [],
    abortController: new AbortController(),
    runPromise: Promise.resolve(),
    _resolveRun: () => {},
    _rejectRun: () => {},
  }
}

describe('run tracking diagnostics', () => {
  test('a re-keyed run leaves its old thread id alive in the map for ever', () => {
    const backend = new TestBackend()
    const handle = makeHandle('solus-session')
    backend.start(handle)
    backend.init(handle, 'thread-one')
    backend.init(handle, 'thread-two')

    // Both ids now address the same handle: `promoteToActive` adds the new key
    // without removing the old one.
    expect(backend.runTrackingSnapshot().activeRunSessionIds).toEqual(['thread-one', 'thread-two'])

    backend.finish(handle)

    // `finishRun` only clears the id the handle currently carries, so the alias
    // survives the run. The watchdog asks `isSessionRunning`, so a stale alias
    // makes a finished run answer "alive" — the opposite failure from the one
    // that prints `exit null`, and a map that grows one entry per re-key.
    expect(backend.isSessionRunning('thread-one')).toBe(true)
    expect(backend.isSessionRunning('thread-two')).toBe(false)
    expect(backend.runTrackingSnapshot().activeRunSessionIds).toEqual(['thread-one'])
  })

  test('a run that ended is named as finished, not as missing', () => {
    const backend = new TestBackend()
    const handle = makeHandle('solus-session')
    backend.start(handle)
    backend.init(handle, 'thread-one')
    backend.finish(handle)

    const snapshot = backend.runTrackingSnapshot()
    expect(snapshot.activeRunSessionIds).toEqual([])
    expect(snapshot.pendingRunSessionIds).toEqual([])
    // The run ended; if the control plane still holds the session, the exit
    // never reached it. That is a different defect from the run vanishing.
    expect(snapshot.finishedRunSessionIds).toEqual(['thread-one'])
  })

  test('a run still waiting for session_init is reported as pending, not missing', () => {
    const backend = new TestBackend()
    backend.start(makeHandle('solus-session'))

    const snapshot = backend.runTrackingSnapshot()
    expect(snapshot.activeRunSessionIds).toEqual([])
    expect(snapshot.pendingRunSessionIds).toEqual([null])
  })
})
