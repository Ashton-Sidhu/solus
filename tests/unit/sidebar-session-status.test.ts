import { describe, expect, test } from 'bun:test'
import type { SessionExecution } from '@solus/contracts/session-execution'
import { executionAttention } from '@solus/workspace-ui/components/session/lib/sidebar-session-status'

const completed: SessionExecution = {
  revision: 4, current: null, lastTurn: { runId: 'run', startedAt: 1, endedAt: 3, outcome: 'completed' },
}

describe('sidebar session attention', () => {
  test('approval and rate limits remain visible after the tab closes', () => {
    const current = { runId: 'current', startedAt: 4, phase: 'awaiting_input' } as const
    expect(executionAttention({ ...completed, current, awaitingApproval: true })).toBe('approval')
    expect(executionAttention({ ...completed, current })).toBe('awaiting')
    expect(executionAttention({ ...completed, current: { ...current, phase: 'rate_limited' } })).toBe('limited')
  })

  test('an asynchronous question stays visible after its turn completes and clears after an answer', () => {
    expect(executionAttention({ ...completed, hasPendingQuestion: true })).toBe('awaiting')
    expect(executionAttention(completed)).toBeNull()
  })

  test('a prior failed turn cannot make a new background turn look failed', () => {
    const failed: SessionExecution = { ...completed, lastTurn: { ...completed.lastTurn!, outcome: 'failed' } }
    expect(executionAttention(failed)).toBe('error')
    expect(executionAttention({ ...failed, current: { runId: 'later', startedAt: 4, phase: 'background' } })).toBe('background')
    expect(executionAttention(undefined)).toBeNull()
  })
})
