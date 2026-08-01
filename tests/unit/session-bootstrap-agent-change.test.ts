import { describe, expect, test } from 'bun:test'
import type { Message, Session } from '../../src/shared/types'
import { replaceHydratedMessages } from '../../src/renderer/contexts/workspace/session-bootstrap'

describe('restored session agent changes', () => {
  test('keeps an agent divider added while provider history is loading', () => {
    const history: Message[] = [
      { id: 'prompt-1', role: 'user', content: 'Fix it', timestamp: 1 },
      { id: 'answer-1', role: 'assistant', content: 'Done', timestamp: 2 },
    ]
    const pendingDivider: Message = {
      id: 'agent-change-1',
      role: 'system',
      content: 'Switched to Claude Code',
      timestamp: 3,
      agentChangedTo: 'Claude Code',
    }
    const session = { messages: [pendingDivider] } as Session

    replaceHydratedMessages(session, history)

    expect(session.messages).toEqual([...history, pendingDivider])
  })
})
