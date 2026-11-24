import { afterEach, describe, expect, test } from 'bun:test'
import type { Message, Session, Tab } from '@solus/contracts/types'

/**
 * A client that reloads while a turn runs loads the session's history from disk,
 * then the host replays the turn so far to that client alone. A call that
 * history already holds is the same call: it must stay one card, not become a
 * finished copy above a running one.
 */

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

async function createReducer(messages: Message[]) {
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

const agentInput = JSON.stringify({ description: 'Audit the auth module', prompt: 'Read every file' })

/** A sub-agent call as history holds it while the agent still runs: no result yet. */
function loadedAgent(toolId: string): Message {
  return { id: `history-${toolId}`, role: 'tool', content: '', toolName: 'Agent', toolId, toolInput: agentInput, subMessages: [], timestamp: 1 }
}

describe('a running turn replayed over loaded history', () => {
  test('a sub-agent call history holds stays one card, running, and its replayed work lands on it', async () => {
    const { reducer, session } = await createReducer([loadedAgent('toolu_a'), loadedAgent('toolu_b')])

    for (const toolId of ['toolu_a', 'toolu_b']) {
      reducer.apply('session-1', { type: 'tool_call', toolName: 'Agent', toolId, index: 0, isSubagent: true, subagentType: 'claude' })
      reducer.apply('session-1', { type: 'tool_call_complete', index: 0, toolId, toolInput: agentInput })
    }
    reducer.apply('session-1', { type: 'tool_call', toolName: 'Read', toolId: 'toolu_read', index: 0, toolInput: '{"file_path":"a.ts"}', parentToolUseId: 'toolu_a' })

    const agents = session.messages.filter((message) => message.toolName === 'Agent')
    expect(agents.map((message) => message.id)).toEqual(['history-toolu_a', 'history-toolu_b'])
    expect(agents.map((message) => message.toolStatus)).toEqual(['running', 'running'])
    expect(agents[0].toolInput).toBe(agentInput)
    expect(agents[0].subMessages?.map((message) => message.toolId)).toEqual(['toolu_read'])

    // The replayed result settles the same card.
    reducer.apply('session-1', { type: 'tool_result', toolUseId: 'toolu_a', status: 'ok', contentBytes: 3 })
    expect(session.messages.filter((message) => message.toolName === 'Agent').map((message) => message.toolStatus)).toEqual(['completed', 'running'])
  })

  test('a call id from an earlier turn does not reopen that turn\'s card', async () => {
    const { reducer, session } = await createReducer([
      loadedAgent('toolu_a'),
      { id: 'prompt-2', role: 'user', content: 'Next', timestamp: 2 },
    ])
    reducer.apply('session-1', { type: 'tool_call', toolName: 'Agent', toolId: 'toolu_a', index: 0, isSubagent: true, subagentType: 'claude' })
    expect(session.messages.map((message) => message.id).slice(0, 2)).toEqual(['history-toolu_a', 'prompt-2'])
    expect(session.messages).toHaveLength(3)
    expect(session.messages[0].toolStatus).toBeUndefined()
  })

  test('a new call still adds its own card', async () => {
    const { reducer, session } = await createReducer([loadedAgent('toolu_a')])
    reducer.apply('session-1', { type: 'tool_call', toolName: 'Agent', toolId: 'toolu_new', index: 0, isSubagent: true, subagentType: 'claude' })
    expect(session.messages.map((message) => message.toolId)).toEqual(['toolu_a', 'toolu_new'])
  })
})

describe('a running turn replayed over loaded history on the native client', () => {
  const agentRow = (toolId: string) => ({ role: 'tool' as const, content: '', toolName: 'Agent', toolId, toolInput: agentInput, timestamp: 2 })

  test('a sub-agent call history holds stays one row, running again', async () => {
    const { TranscriptModel } = await import('../../apps/mobile/solus-core/features/conversation/lib/transcript-model')
    const model = TranscriptModel.fromHistory('s', {
      messages: [{ role: 'user', content: 'Plan it', timestamp: 1 }, agentRow('toolu_a'), agentRow('toolu_b')],
      before: null,
    })
    for (const toolId of ['toolu_a', 'toolu_b']) {
      model.apply({ type: 'tool_call', toolName: 'Agent', toolId, index: 0, isSubagent: true, subagentType: 'claude' })
    }
    const agents = model.order.map((id) => model.items.get(id)).filter((item) => item?.kind === 'tool')
    expect(agents.map((item) => item?.kind === 'tool' && item.toolId)).toEqual(['toolu_a', 'toolu_b'])
    expect(agents.map((item) => item?.kind === 'tool' && item.status)).toEqual(['running', 'running'])
  })

  test('a call id from an earlier turn adds its own row', async () => {
    const { TranscriptModel } = await import('../../apps/mobile/solus-core/features/conversation/lib/transcript-model')
    const model = TranscriptModel.fromHistory('s', {
      messages: [{ role: 'user', content: 'First', timestamp: 1 }, agentRow('toolu_a'), { role: 'user', content: 'Next', timestamp: 3 }],
      before: null,
    })
    model.apply({ type: 'tool_call', toolName: 'Agent', toolId: 'toolu_a', index: 0, isSubagent: true, subagentType: 'claude' })
    expect(model.order.filter((id) => model.items.get(id)?.kind === 'tool')).toHaveLength(2)
  })
})
