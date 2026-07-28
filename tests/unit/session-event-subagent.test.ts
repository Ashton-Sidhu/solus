import { afterEach, describe, expect, test } from 'bun:test'
import type { Message, Session, Tab } from '../../src/shared/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

async function createReducer() {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  const { SessionEventReducer } = await import('../../src/renderer/contexts/workspace/session-event-reducer.svelte')
  const parent: Message = {
    id: 'parent-message',
    role: 'tool',
    content: '',
    toolName: 'mcp__solus__codex_subagent',
    toolId: 'parent-tool',
    toolStatus: 'running',
    subMessages: [],
    timestamp: 0,
  }
  const session = {
    status: 'running',
    messages: [parent],
  } as Session
  const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
  const reducer = new SessionEventReducer({
    registry: {
      tabs: { 'tab-1': tab },
      sessions: { 'session-1': session },
      sessionFor: (tabId: string) => tabId === 'tab-1' ? session : undefined,
    },
    settings: { rateLimitBehavior: 'ask' },
    log: () => {},
  } as any)
  return { parent, reducer }
}

describe('SessionEventReducer sub-agent transcript events', () => {
  test('reconciles streamed chunks with assembled messages without doubling', async () => {
    const { parent, reducer } = await createReducer()

    reducer.apply('tab-1', { type: 'text_chunk', text: 'Draft ', parentToolUseId: 'parent-tool' })
    reducer.apply('tab-1', { type: 'text_chunk', text: 'answer', parentToolUseId: 'parent-tool' })

    expect(parent.subMessages).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Draft answer', isStreaming: true }),
    ])

    reducer.apply('tab-1', {
      type: 'assistant_message',
      text: 'Final answer.',
      parentToolUseId: 'parent-tool',
    })

    expect(parent.subMessages).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Final answer.' }),
    ])
    expect(parent.subMessages?.[0].isStreaming).toBeUndefined()

    reducer.apply('tab-1', {
      type: 'assistant_message',
      text: 'Final answer.',
      parentToolUseId: 'parent-tool',
    })
    expect(parent.subMessages).toHaveLength(1)

    reducer.apply('tab-1', {
      type: 'assistant_message',
      text: 'A distinct follow-up.',
      parentToolUseId: 'parent-tool',
    })
    expect(parent.subMessages?.map((message) => message.content)).toEqual([
      'Final answer.',
      'A distinct follow-up.',
    ])
  })

  test('starts a new streamed block after an interleaved tool call', async () => {
    const { parent, reducer } = await createReducer()

    reducer.apply('tab-1', { type: 'text_chunk', text: 'Before tool', parentToolUseId: 'parent-tool' })
    reducer.apply('tab-1', {
      type: 'tool_call',
      toolName: 'Read',
      toolId: 'child-tool',
      index: 0,
      toolInput: '{}',
      parentToolUseId: 'parent-tool',
    })
    reducer.apply('tab-1', { type: 'text_chunk', text: 'After tool draft', parentToolUseId: 'parent-tool' })
    reducer.apply('tab-1', {
      type: 'assistant_message',
      text: 'After tool final',
      parentToolUseId: 'parent-tool',
    })

    expect(parent.subMessages?.map((message) => [message.role, message.content])).toEqual([
      ['assistant', 'Before tool'],
      ['tool', ''],
      ['assistant', 'After tool final'],
    ])
  })

  test('settles the card only when the child delivers its final answer', async () => {
    const { parent, reducer } = await createReducer()

    reducer.apply('tab-1', {
      type: 'assistant_message',
      text: 'Still investigating.',
      parentToolUseId: 'parent-tool',
    })
    expect(parent.toolStatus).toBe('running')

    reducer.apply('tab-1', {
      type: 'assistant_message',
      text: 'Investigation complete.',
      parentToolUseId: 'parent-tool',
      isFinal: true,
    })
    expect(parent.toolStatus).toBe('completed')
  })
})
