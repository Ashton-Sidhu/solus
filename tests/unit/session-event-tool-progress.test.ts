import { afterEach, describe, expect, test } from 'bun:test'
import type { Message, Session, Tab } from '@solus/contracts/types'

/**
 * A `tool_progress` event on the desktop and web transcript
 * (docs/plans/mcp-first-class.md §5): it lands on the card of its own call,
 * for both providers, by changing that message in place.
 */

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

async function createReducer(messages: Message[] = []) {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
  const session = { status: 'running', messages, run: { provider: 'claude-code' } } as unknown as Session
  const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
  // SAFETY: the reducer reads only these dependencies for tool events.
  const reducer = new SessionEventReducer({
    sessions: { byId: { 'session-1': session } },
    registry: { tabs: { 'tab-1': tab }, sessionFor: () => session, tabIdsBySession: new Map([['session-1', ['tab-1']]]) },
    settings: { activeAgent: 'claude-code', rateLimitBehavior: 'ask' },
    workStreamTracker: { beginWorkStream: () => {}, updateStreamingArtifact: () => {}, failArtifact: () => {} },
    closePlanModal: () => {},
    log: () => {},
  } as any)
  return { reducer, session }
}

function card(session: Session, toolId: string): Message | undefined {
  return session.messages.find((message) => message.toolId === toolId)
}

describe('tool progress on the desktop and web transcript', () => {
  test('Claude: an integration card stays running past its input end, shows progress, and the result settles it', async () => {
    const { reducer, session } = await createReducer()
    reducer.apply('session-1', { type: 'tool_call', toolName: 'mcp__solus__fake__long', toolId: 'toolu_1', index: 0 })
    reducer.apply('session-1', { type: 'tool_call_complete', index: 0, toolId: 'toolu_1', toolInput: '{}' })
    // A Solus integration call runs after its input ends (§14.1): the card waits for the result.
    expect(card(session, 'toolu_1')?.toolStatus).toBe('running')

    reducer.apply('session-1', { type: 'tool_progress', toolUseId: 'toolu_1', progress: 2, total: 5, message: 'Copying rows' })
    const message = card(session, 'toolu_1')
    expect(message?.toolStatus).toBe('running')
    expect(message?.toolCompletedAt).toBeUndefined()
    expect(message?.toolProgress).toEqual({ progress: 2, total: 5, message: 'Copying rows' })

    // The newest report replaces the old one; a report with no message clears it.
    reducer.apply('session-1', { type: 'tool_progress', toolUseId: 'toolu_1', progress: 7 })
    expect(card(session, 'toolu_1')?.toolProgress).toEqual({ progress: 7 })

    reducer.apply('session-1', { type: 'tool_result', toolUseId: 'toolu_1', status: 'ok', contentBytes: 4 })
    expect(card(session, 'toolu_1')?.toolStatus).toBe('completed')
    expect(card(session, 'toolu_1')?.toolProgress).toBeUndefined()

    // An event that arrives after the result does not reopen the card.
    reducer.apply('session-1', { type: 'tool_progress', toolUseId: 'toolu_1', progress: 8 })
    expect(card(session, 'toolu_1')?.toolStatus).toBe('completed')
    expect(card(session, 'toolu_1')?.toolProgress).toBeUndefined()
  })

  test('progress reopens a card that settled with no result', async () => {
    const { reducer, session } = await createReducer()
    reducer.apply('session-1', { type: 'tool_call', toolName: 'Bash', toolId: 'toolu_2', index: 0 })
    reducer.apply('session-1', { type: 'tool_call_complete', index: 0, toolId: 'toolu_2', toolInput: '{}' })
    expect(card(session, 'toolu_2')?.toolStatus).toBe('completed')

    reducer.apply('session-1', { type: 'tool_progress', toolUseId: 'toolu_2', progress: 1 })
    expect(card(session, 'toolu_2')?.toolStatus).toBe('running')
    expect(card(session, 'toolu_2')?.toolCompletedAt).toBeUndefined()
  })

  test('Codex: progress lands on the card of the call id and changes only that message', async () => {
    const { reducer, session } = await createReducer()
    reducer.apply('session-1', { type: 'tool_call', toolName: 'solus.fake__long', toolId: 'call_a', index: 0 })
    reducer.apply('session-1', { type: 'tool_call', toolName: 'solus.fake__other', toolId: 'call_b', index: 0 })
    const messages = session.messages
    const other = card(session, 'call_b')
    reducer.apply('session-1', { type: 'tool_progress', toolUseId: 'call_a', progress: 1, total: 3 })
    expect(card(session, 'call_a')?.toolProgress).toEqual({ progress: 1, total: 3 })
    expect(other?.toolProgress).toBeUndefined()
    // Mutated in place: the transcript and the other card keep their identity.
    expect(session.messages).toBe(messages)
    expect(card(session, 'call_b')).toBe(other)

    reducer.apply('session-1', { type: 'tool_result', toolUseId: 'call_a', status: 'error', errorHead: 'Fake did not answer within 60 seconds.', contentBytes: 38 })
    expect(card(session, 'call_a')?.toolStatus).toBe('error')
    expect(card(session, 'call_a')?.errorHead).toBe('Fake did not answer within 60 seconds.')
  })

  test('a call inside a sub-agent gets its progress on its nested card', async () => {
    const nested: Message = { id: 'm2', role: 'tool', content: '', toolName: 'mcp__solus__fake__long', toolId: 'toolu_child', toolStatus: 'running', timestamp: 0 }
    const parent: Message = { id: 'm1', role: 'tool', content: '', toolName: 'Agent', toolId: 'toolu_agent', toolStatus: 'running', subMessages: [nested], timestamp: 0 }
    const { reducer } = await createReducer([parent])
    reducer.apply('session-1', { type: 'tool_progress', toolUseId: 'toolu_child', progress: 1, message: 'Indexing' })
    expect(nested.toolProgress).toEqual({ progress: 1, message: 'Indexing' })
    expect(parent.toolProgress).toBeUndefined()
  })

  test('an event for a card this client does not have changes nothing', async () => {
    const { reducer, session } = await createReducer()
    reducer.apply('session-1', { type: 'tool_progress', toolUseId: 'unknown', progress: 1 })
    expect(session.messages).toEqual([])
  })
})
