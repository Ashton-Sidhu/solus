import { describe, expect, test } from 'bun:test'
import {
  railSubagentList,
  railSubagentTooltip,
  sessionSubagents,
} from '@solus/workspace-ui/components/project-panel/lib/rail-subagents'
import type { Message } from '@solus/contracts/types'

const NOW = 100_000
const FALLBACK = { model: 'Sonnet 5', effort: 'medium' }

function agent(overrides: Partial<Message> & Pick<Message, 'id'>): Message {
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

describe('session sub-agents', () => {
  test('a tool call is a sub-agent when it carries a nested transcript, whatever its name', () => {
    const messages = [
      { id: 'u', role: 'user', content: 'go', timestamp: NOW } as Message,
      { id: 't', role: 'tool', content: '', toolName: 'Read', timestamp: NOW } as Message,
      agent({ id: 'a', toolName: 'Task' }),
      agent({ id: 'b', toolName: 'mcp__solus__codex_subagent' }),
    ]

    expect(sessionSubagents(messages).map((m) => m.id)).toEqual(['a', 'b'])
  })
})

describe('rail list', () => {
  test('running agents lead — they are what the rail is watched for — then settled ones newest first', () => {
    const list = railSubagentList(
      [
        agent({ id: 'old', timestamp: NOW - 90_000 }),
        agent({ id: 'live', toolStatus: 'running', timestamp: NOW - 80_000 }),
        agent({ id: 'new', timestamp: NOW - 20_000 }),
      ],
      NOW,
      FALLBACK,
    )

    expect(list.rows.map((row) => row.id)).toEqual(['live', 'new', 'old'])
    expect(list.running).toBe(1)
  })

  test('the header reading counts states, never names, and is empty with nothing to count', () => {
    expect(railSubagentList([], NOW, FALLBACK).detail).toBe('')
    expect(
      railSubagentList([agent({ id: 'a', toolStatus: 'running' }), agent({ id: 'b' })], NOW, FALLBACK).detail,
    ).toBe('1 running')
    expect(
      railSubagentList([agent({ id: 'a', toolStatus: 'error' }), agent({ id: 'b' })], NOW, FALLBACK).detail,
    ).toBe('1 done · 1 failed')
    expect(railSubagentList([agent({ id: 'a' }), agent({ id: 'b' })], NOW, FALLBACK).detail).toBe('2 done')
  })

  test('the hover names the task and what the agent is doing — the line the row has no room for', () => {
    const [live] = railSubagentList(
      [
        agent({
          id: 'a',
          toolStatus: 'running',
          toolInput: JSON.stringify({ description: 'Map the RPC chain' }),
          backgroundTaskProgress: { description: 'Reading the handlers' },
        }),
      ],
      NOW,
      FALLBACK,
    ).rows

    expect(railSubagentTooltip(live)).toBe('Map the RPC chain\nRunning · Reading the handlers')
  })
})
