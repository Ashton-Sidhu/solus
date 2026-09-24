import { describe, expect, test } from 'bun:test'
import { applyExchangeEvent, type Exchange } from '@solus/server/orchestration/exchange'

// WHY: an exchange is changed only through this one function, so the rules for
// a message's life are all here: a result from a run the message no longer
// belongs to is stale, a settled message never changes, and a plan revision
// carries the message across the run a denial ended.

function exchange(overrides: Partial<Exchange> = {}): Exchange {
  return {
    exchangeId: 'm1', kind: 'prompt', senderSessionId: 'sender', senderAgentSessionId: 'thread-sender',
    targetSessionId: 'target', targetAgentSessionId: 'thread-target', provider: 'codex', notify: true,
    state: 'dispatched', outputs: [], notices: [], revising: false, dispatchedAt: 0,
    ...overrides,
  }
}

describe('an exchange', () => {
  test('follows its run from queue to reply', () => {
    const message = exchange()
    expect(applyExchangeEvent(message, { type: 'queued', runId: 'run-1' })).toBe(true)
    expect(applyExchangeEvent(message, { type: 'started', runId: 'run-1' })).toBe(true)
    expect(message.state).toBe('running')
    expect(applyExchangeEvent(message, { type: 'settled', runId: 'run-1', outcome: 'completed' })).toBe(true)
    expect(message).toMatchObject({ state: 'settled', outcome: 'completed' })
  })

  test('ignores the result of a run it is not bound to', () => {
    const message = exchange({ state: 'running', runId: 'run-2' })
    expect(applyExchangeEvent(message, { type: 'settled', runId: 'run-1', outcome: 'failed' })).toBe(false)
    expect(message.state).toBe('running')
  })

  test('never changes once settled', () => {
    const message = exchange({ state: 'settled', outcome: 'completed' })
    expect(applyExchangeEvent(message, { type: 'started', runId: 'run-9' })).toBe(false)
    expect(applyExchangeEvent(message, { type: 'settled', outcome: 'failed' })).toBe(false)
    expect(message.outcome).toBe('completed')
  })

  test('a request that arrives before the start was reported keeps the exchange waiting', () => {
    const message = exchange({ state: 'queued', runId: 'run-1' })
    const request = { kind: 'permission' as const, permission: { questionId: 'p1', toolTitle: 'Bash', options: [] } }
    expect(applyExchangeEvent(message, { type: 'input_requested', request })).toBe(true)
    expect(applyExchangeEvent(message, { type: 'started', runId: 'run-1' })).toBe(false)
    expect(message.state).toBe('awaiting_input')
    expect(applyExchangeEvent(message, { type: 'input_resolved', outputs: [{ kind: 'permission', tool: 'Bash', allowed: true }] })).toBe(true)
    expect(message).toMatchObject({ state: 'running', outputs: [{ kind: 'permission', tool: 'Bash', allowed: true }], request })
  })

  test('a plan revision survives the end of the run the denial stopped, and continues on the next', () => {
    const message = exchange({ state: 'awaiting_input', runId: 'run-1' })
    expect(applyExchangeEvent(message, { type: 'revision_requested' })).toBe(true)
    expect(applyExchangeEvent(message, { type: 'settled', runId: 'run-1', outcome: 'interrupted' })).toBe(false)
    expect(applyExchangeEvent(message, { type: 'queued', runId: 'run-2' })).toBe(true)
    expect(message).toMatchObject({ state: 'queued', runId: 'run-2', revising: false })
    expect(applyExchangeEvent(message, { type: 'settled', runId: 'run-1', outcome: 'interrupted' })).toBe(false)
    expect(applyExchangeEvent(message, { type: 'started', runId: 'run-2' })).toBe(true)
    expect(applyExchangeEvent(message, { type: 'settled', runId: 'run-2', outcome: 'completed' })).toBe(true)
  })
})
