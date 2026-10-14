import { describe, expect, test } from 'bun:test'
import { reportText, subagentConversation } from '@solus/workspace-ui/components/conversation/lib/subagent-view'
import type { Message } from '@solus/contracts/types'

const NOW = 100_000

function agent(overrides: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    role: 'tool',
    content: '',
    toolName: 'Agent',
    toolInput: JSON.stringify({ description: 'Map the RPC chain', prompt: 'Find every handler.' }),
    timestamp: NOW - 60_000,
    toolCompletedAt: NOW,
    toolStatus: 'completed',
    subMessages: [],
    ...overrides,
  } as Message
}

const say = (id: string, content: string, role: Message['role'] = 'assistant'): Message =>
  ({ id, role, content, timestamp: NOW - 10_000 }) as Message

describe('report text', () => {
  test('a running agent has no answer yet — its latest prose is progress', () => {
    expect(reportText(agent({ id: 'a', toolStatus: 'running', report: 'Launched', subMessages: [say('s', 'Still editing.')] }))).toBe('')
  })

  test('a backgrounded agent never returns a tool result, so its last words are the answer', () => {
    expect(reportText(agent({ id: 'a', subMessages: [say('s1', 'Looking.'), say('s2', 'Five headings.')] }))).toBe('Five headings.')
  })

  test('the tool result wins when there is one — that is what the main agent was told', () => {
    expect(reportText(agent({ id: 'a', report: 'The answer.' }))).toBe('The answer.')
  })
})

describe('conversation', () => {
  test('the brief is the prompt, then the run in order', () => {
    const tool = { id: 't', role: 'tool', content: '', toolName: 'Read', timestamp: NOW - 20_000 } as Message
    const messages = subagentConversation(agent({ id: 'a', subMessages: [tool, say('s', 'Done.')] }))

    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Find every handler.'],
      ['tool', ''],
      ['assistant', 'Done.'],
    ])
  })

  test('a blocking agent’s answer arrives as the tool result, so it closes the conversation', () => {
    const messages = subagentConversation(agent({ id: 'a', report: 'The answer.', subMessages: [say('s', 'Looking.')] }))

    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: 'The answer.' })
  })

  test('an answer that is already the last words is not printed twice', () => {
    const messages = subagentConversation(agent({ id: 'a', report: 'Done.', subMessages: [say('s', 'Done.')] }))

    expect(messages.filter((m) => m.content === 'Done.')).toHaveLength(1)
  })

  test('a transcript that carries its own brief does not get a second one', () => {
    const messages = subagentConversation(agent({ id: 'a', subMessages: [say('u', 'Find every handler.', 'user'), say('s', 'Done.')] }))

    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1)
  })
})
