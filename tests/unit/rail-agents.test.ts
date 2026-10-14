import { describe, expect, test } from 'bun:test'
import {
  formatCompactElapsed,
  railAgentList,
  sessionAgentMessages,
} from '@solus/workspace-ui/components/project-panel/lib/rail-agents'
import type { AgentConversationRef, AgentExchangeStatus, Message, SessionMeta } from '@solus/contracts/types'

const NOW = 100_000
const CONTEXT = {
  fallback: { model: 'Sonnet 5', effort: 'medium' },
  metaFor: (): SessionMeta | undefined => undefined,
  hostLabel: null,
}

function subagent(overrides: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    role: 'tool',
    content: '',
    toolName: 'Agent',
    timestamp: NOW - 60_000,
    toolCompletedAt: NOW - 30_000,
    toolStatus: 'completed',
    subMessages: [],
    ...overrides,
  } as Message
}

function sessionCard(id: string, sessionId: string, status: AgentExchangeStatus, timestamp: number): Message {
  const ref: AgentConversationRef = {
    sessionId,
    provider: 'codex',
    title: `Session ${sessionId}`,
    cwd: '/repo',
    origin: 'created',
    exchanges: [{ messageId: id, index: 0, prompt: 'go', dispatchedAt: timestamp, status }],
  }
  return { id, role: 'assistant', content: '', timestamp, agentConversationRef: ref } as Message
}

describe('session agents', () => {
  test('sub-agents and the sessions this one started are both agents; other tool calls are not', () => {
    const messages = [
      { id: 'u', role: 'user', content: 'go', timestamp: NOW } as Message,
      { id: 't', role: 'tool', content: '', toolName: 'Read', timestamp: NOW } as Message,
      subagent({ id: 'a', toolName: 'Task' }),
      sessionCard('c', 's1', 'running', NOW),
    ]

    expect(sessionAgentMessages(messages).map((m) => m.id)).toEqual(['a', 'c'])
  })
})

describe('rail list', () => {
  test('one list for both kinds: live agents show, settled ones fold under Previous, newest first', () => {
    const list = railAgentList(
      [
        subagent({ id: 'old', timestamp: NOW - 90_000 }),
        subagent({ id: 'live', toolStatus: 'running', timestamp: NOW - 80_000 }),
        sessionCard('c1', 'running-session', 'running', NOW - 50_000),
        sessionCard('c2', 'done-session', 'done', NOW - 20_000),
      ],
      NOW,
      CONTEXT,
    )

    expect(list.active.map((row) => row.id)).toEqual(['running-session', 'live'])
    expect(list.previous.map((row) => row.id)).toEqual(['done-session', 'old'])
    expect(list.detail).toBe('2 running')
  })

  test('a session messaged across turns is one row: it stands where its last card says, sorted by its first', () => {
    const list = railAgentList(
      [
        sessionCard('first', 's1', 'done', NOW - 90_000),
        subagent({ id: 'between', timestamp: NOW - 50_000 }),
        sessionCard('second', 's1', 'running', NOW - 10_000),
      ],
      NOW,
      CONTEXT,
    )

    expect(list.active.map((row) => row.key)).toEqual(['session:s1'])
    expect(list.previous.map((row) => row.key)).toEqual(['subagent:between'])
  })

  test('the index title and provider win over what the dispatch guessed', () => {
    const list = railAgentList([sessionCard('c', 's1', 'done', NOW)], NOW, {
      ...CONTEXT,
      metaFor: () => ({ slug: 'audit-the-rpc-chain', provider: 'claude-code' }) as SessionMeta,
    })

    expect(list.previous[0]).toMatchObject({ title: 'audit-the-rpc-chain', provider: 'claude-code' })
  })

  test('the header counts running agents, and outcomes once none run', () => {
    expect(railAgentList([], NOW, CONTEXT).detail).toBe('')
    expect(railAgentList([subagent({ id: 'a' }), subagent({ id: 'b', toolStatus: 'error' })], NOW, CONTEXT).detail).toBe('1 done · 1 failed')
  })
})

test('elapsed time fits a narrow row', () => {
  expect(formatCompactElapsed(45_000)).toBe('45s')
  expect(formatCompactElapsed(12 * 60_000 + 30_000)).toBe('12m')
  expect(formatCompactElapsed(90 * 60_000)).toBe('1.5h')
  expect(formatCompactElapsed(14 * 3_600_000)).toBe('14h')
})
