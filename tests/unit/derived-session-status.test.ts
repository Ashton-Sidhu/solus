import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { readFileSync } from 'node:fs'
import type { BackendSession, NormalizedEvent, SessionStatus } from '@solus/contracts/types'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'
import { deriveSessionStatus, turnOfStatus, type SessionFacts } from '@solus/server/execution/sessions/derived-status'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let SessionStatuses: typeof import('@solus/server/execution/sessions/session-statuses')['SessionStatuses']
let flushLogs: () => void
beforeAll(async () => {
  ;({ SessionStatuses } = await import('@solus/server/execution/sessions/session-statuses'))
  ;({ flushLogs } = await import('@solus/server/logger'))
})

// WHY: a session's status is a view of a few facts: where the turn is, what
// the person must answer, a parked rate limit, and background work that holds
// the session. When it is written by hand at many call sites, those facts and
// the status drift apart (docs/plans/derived-session-status.md). One function
// gives the status from the facts, and a shadow check logs each write that
// disagrees with it, so step 2 knows which call sites hold a rule of their own.

const none: Omit<SessionFacts, 'turn'> = { pendingInput: null, rateLimitParked: false, backgroundHolds: false }

describe('the derived status', () => {
  test('follows the turn when nothing else holds the session', () => {
    expect(deriveSessionStatus({ ...none, turn: { phase: 'none' } })).toBe('idle')
    expect(deriveSessionStatus({ ...none, turn: { phase: 'starting' } })).toBe('connecting')
    expect(deriveSessionStatus({ ...none, turn: { phase: 'running' } })).toBe('running')
    expect(deriveSessionStatus({ ...none, turn: { phase: 'settled', outcome: 'failed' } })).toBe('failed')
  })

  test('background work the agent waits on keeps a settled turn in background', () => {
    expect(deriveSessionStatus({ ...none, backgroundHolds: true, turn: { phase: 'settled', outcome: 'completed' } })).toBe('background')
    // A running turn is running, whatever it started in the background.
    expect(deriveSessionStatus({ ...none, backgroundHolds: true, turn: { phase: 'running' } })).toBe('running')
  })

  test('the person outranks the turn, and a parked limit outranks the person', () => {
    expect(deriveSessionStatus({ ...none, pendingInput: 'awaiting_plan', turn: { phase: 'running' } })).toBe('awaiting_plan')
    // A question can come through a query left open for background work.
    expect(deriveSessionStatus({ ...none, pendingInput: 'awaiting_input', backgroundHolds: true, turn: { phase: 'settled', outcome: 'completed' } })).toBe('awaiting_input')
    expect(deriveSessionStatus({ ...none, rateLimitParked: true, pendingInput: 'awaiting_input', turn: { phase: 'running' } })).toBe('rate_limited')
  })

  test('with no other fact, every status gives itself back through its turn', () => {
    const statuses: SessionStatus[] = ['idle', 'connecting', 'running', 'completed', 'failed', 'interrupted', 'dead']
    for (const status of statuses) expect(deriveSessionStatus({ ...none, turn: turnOfStatus(status) })).toBe(status)
  })
})

interface MismatchLog { msg: string; sessionId: string; oldStatus: string; newStatus: string; derived: string; writer: string | null }

describe('the shadow check', () => {
  const permission = { type: 'permission_request', questionId: 'q1' } as NormalizedEvent

  function statuses(session: BackendSession) {
    const runtime = {
      activeSessions: new Map([[session.sessionId, session]]),
      isShuttingDown: false,
      restarts: { restartRuns: undefined },
      rateLimitPark: { rateLimits: { peek: () => null } },
      activeUnattendedAgentRuns: new Set(),
      hasWorkForUpdate: () => false,
      emit: () => {},
      publish: () => {},
    }
    // SAFETY: a session with no provider thread id reads only the members above.
    return new SessionStatuses(runtime as unknown as SessionRuntime)
  }

  function mismatches(sessionId: string): MismatchLog[] {
    flushLogs()
    return readFileSync(process.env.SOLUS_DEV_LOG!, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as MismatchLog)
      .filter((entry) => entry.msg === 'session_status_derived_mismatch' && entry.sessionId === sessionId)
  }

  function session(sessionId: string, status: SessionStatus, pendingInputEvents: NormalizedEvent[] = []): BackendSession {
    return {
      sessionId, agentSessionId: null, backendId: 'codex', status,
      pendingInputEvents, hasPendingInput: pendingInputEvents.length > 0, lastActivityAt: 0, promptCount: 1,
    } as BackendSession
  }

  test('logs a write the facts do not give, with the call site that made it', () => {
    statuses(session('solus-shadow-input', 'awaiting_input', [permission])).setStatus('solus-shadow-input', 'running')

    const [entry] = mismatches('solus-shadow-input')
    expect(entry).toMatchObject({ oldStatus: 'awaiting_input', newStatus: 'running', derived: 'awaiting_input' })
    expect(entry.writer).toContain('derived-session-status.test.ts')
  })

  test('logs nothing for a write the facts agree with', () => {
    statuses(session('solus-shadow-agrees', 'running', [permission])).setStatus('solus-shadow-agrees', 'awaiting_input')

    expect(mismatches('solus-shadow-agrees')).toEqual([])
  })
})
