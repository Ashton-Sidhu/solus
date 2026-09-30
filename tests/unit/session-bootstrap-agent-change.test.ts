import { describe, expect, test } from 'bun:test'
import type { Message, Session } from '@solus/contracts/types'
import { replaceHydratedMessages } from '@solus/workspace-ui/contexts/workspace/session-bootstrap'

function switched(id: string, at: number): Message {
  return {
    id,
    role: 'system',
    content: '',
    timestamp: at,
    activity: { id, subject: { kind: 'session', id: 's' }, at, by: { kind: 'system' }, kind: 'agent_switched', provider: 'claude-code', fromProvider: 'codex' },
  }
}

describe('restored session activity', () => {
  test('keeps an agent switch that arrived while provider history was loading', () => {
    const history: Message[] = [
      { id: 'prompt-1', role: 'user', content: 'Fix it', timestamp: 1 },
      { id: 'answer-1', role: 'assistant', content: 'Done', timestamp: 2 },
    ]
    const live = switched('activity:live', 3)
    const session = { messages: [live] } as Session

    replaceHydratedMessages(session, history)

    // WHY: the history was requested before the switch was recorded; dropping
    // the live row would hide the switch until the next reload.
    expect(session.messages).toEqual([...history, live])
  })

  test('keeps one copy when the history already holds the row, and drops older rows', () => {
    const recorded = switched('activity:recorded', 2)
    const older = switched('activity:older', 0)
    const history: Message[] = [
      { id: 'prompt-1', role: 'user', content: 'Fix it', timestamp: 1 },
      recorded,
      { id: 'answer-1', role: 'assistant', content: 'Done', timestamp: 3 },
    ]
    const session = { messages: [older, { ...recorded }] } as Session

    replaceHydratedMessages(session, history)

    // WHY: an agent switch shows once; a row older than the loaded window is
    // not appended after the newest turn.
    expect(session.messages).toEqual(history)
  })
})
