import { describe, expect, test } from 'bun:test'
import { deriveSessionStatus, type SessionFacts } from '@solus/server/execution/sessions/derived-status'
import { Turn } from '@solus/server/execution/sessions/turns'

// WHY: a session's status is a view of a few facts: where the turn is, what
// the person must answer, a parked rate limit, and the work that holds the
// session. When 32 call sites wrote it by hand, the facts and the status drifted
// apart, and a stopped turn showed as running (plans/037-turn-owned-session-status.md).
// One function now gives the status from the facts, and no writer names one.

const none: Omit<SessionFacts, 'turn'> = {
  pendingInput: null, rateLimitParked: false, backgroundWorkHolds: false, holdsOutsideRun: false, queueTakesOver: false,
}
const completed = { phase: 'settled', outcome: 'completed' } as const
const failed = { phase: 'settled', outcome: 'failed' } as const
const stopped = { phase: 'settled', outcome: 'interrupted' } as const

describe('the derived status', () => {
  test('follows the turn when nothing else holds the session', () => {
    expect(deriveSessionStatus({ ...none, turn: { phase: 'none' } })).toBe('idle')
    expect(deriveSessionStatus({ ...none, turn: { phase: 'starting' } })).toBe('connecting')
    expect(deriveSessionStatus({ ...none, turn: { phase: 'running' } })).toBe('running')
    expect(deriveSessionStatus({ ...none, turn: failed })).toBe('failed')
    expect(deriveSessionStatus({ ...none, turn: stopped })).toBe('interrupted')
  })

  test('work that still runs keeps a turn that ended by itself in background', () => {
    expect(deriveSessionStatus({ ...none, backgroundWorkHolds: true, turn: completed })).toBe('background')
    expect(deriveSessionStatus({ ...none, holdsOutsideRun: true, turn: completed })).toBe('background')
    // A failed turn waits for its own work only, so that work stays stoppable.
    expect(deriveSessionStatus({ ...none, backgroundWorkHolds: true, turn: failed })).toBe('background')
    expect(deriveSessionStatus({ ...none, holdsOutsideRun: true, turn: failed })).toBe('failed')
    // A stopped turn leaves no wait.
    expect(deriveSessionStatus({ ...none, backgroundWorkHolds: true, holdsOutsideRun: true, turn: stopped })).toBe('interrupted')
    // A running turn is running, whatever it started in the background.
    expect(deriveSessionStatus({ ...none, backgroundWorkHolds: true, turn: { phase: 'running' } })).toBe('running')
  })

  test('the person outranks the turn, and a parked limit outranks the person', () => {
    expect(deriveSessionStatus({ ...none, pendingInput: 'awaiting_plan', turn: { phase: 'running' } })).toBe('awaiting_plan')
    // A question can come through a query left open for background work.
    expect(deriveSessionStatus({ ...none, pendingInput: 'awaiting_input', backgroundWorkHolds: true, turn: completed })).toBe('awaiting_input')
    expect(deriveSessionStatus({ ...none, rateLimitParked: true, pendingInput: 'awaiting_input', turn: { phase: 'running' } })).toBe('rate_limited')
  })

  test('a stopped turn waits for no answer', () => {
    // The permission stays until the run exits; the person has already ended the turn.
    expect(deriveSessionStatus({ ...none, pendingInput: 'awaiting_input', turn: stopped })).toBe('interrupted')
  })

  test('a queued prompt that takes over keeps the session running, so no client sees it finish', () => {
    expect(deriveSessionStatus({ ...none, queueTakesOver: true, turn: completed })).toBe('running')
  })
})

describe('a turn', () => {
  test('never opens again once settled', () => {
    const turn = new Turn('turn-1', 'starting')
    turn.markRunning()
    expect(turn.phase).toEqual({ phase: 'running' })
    expect(turn.settle('interrupted')).toBe(true)
    turn.markRunning()
    expect(turn.phase).toEqual({ phase: 'settled', outcome: 'interrupted' })
    expect(turn.wasStopped).toBe(true)
  })

  test('takes a later outcome, and sends its settlement once', () => {
    const turn = new Turn('turn-1', 'running')
    turn.settle('completed')
    expect(turn.claimSettlement()).toBe(true)
    // A failed exit after the result: the status says failed, the settlement went out already.
    expect(turn.settle('failed')).toBe(false)
    expect(turn.outcome).toBe('failed')
    expect(turn.claimSettlement()).toBe(false)
  })
})
