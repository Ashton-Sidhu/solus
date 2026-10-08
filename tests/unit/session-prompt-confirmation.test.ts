import { describe, expect, test } from 'bun:test'
import type { Message, Session } from '@solus/contracts/types'
import { SessionEventReducer, type SessionEventReducerDeps } from '@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte'

function fixture(messages: Message[] = []) {
  const session = {
    status: 'running', messages, outboundPrompts: [], currentTurnStartedAt: 1, run: { serverId: 'host-1' },
  } as unknown as Session
  const reducer = new SessionEventReducer({
    registry: {},
    sessions: { byId: { session } },
    settings: { rateLimitBehavior: 'ask' },
    log: () => {},
  } as unknown as SessionEventReducerDeps)
  return { session, reducer }
}

describe('prompt delivery confirmation', () => {
  test('clears a pending steer when the host starts a fresh turn', () => {
    const { session, reducer } = fixture()
    const attachment = { id: 'attachment-1', name: 'note.txt', type: 'file' as const, path: '/tmp/note.txt' }
    session.outboundPrompts.push({
      clientPromptId: 'prompt-1', text: 'Change direction', state: 'steering',
      enqueuedAt: 1, attachments: [attachment],
    })
    const messages = session.messages
    reducer.apply('session', { type: 'user_message', text: 'Change direction', clientPromptId: 'prompt-1' })
    expect(session.outboundPrompts).toHaveLength(0)
    expect(session.messages).toBe(messages)
    expect(session.messages).toMatchObject([{
      role: 'user', content: 'Change direction', attachments: [attachment], clientPromptId: 'prompt-1',
    }])
  })

  test('keeps an optimistic message when confirmation arrives', () => {
    const message: Message = { id: 'prompt-1', clientPromptId: 'prompt-1', role: 'user', content: 'Hello', timestamp: 1 }
    const { session, reducer } = fixture([message])
    reducer.apply('session', { type: 'user_message', text: 'Hello', clientPromptId: 'prompt-1' })
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0]).toBe(message)
  })

  test('a prompt another agent sent shows its files as chips, not as path lines', () => {
    // WHY: send_session puts files before the text as `[Attached file: …]`
    // lines. A reload shows them as chips; the live bubble must show the same.
    const { session, reducer } = fixture()
    reducer.apply('session', {
      type: 'user_message',
      text: '[Attached file: /data/attachments/sent/abc/log.txt]\n\nRead the log',
      imageAttachmentRefs: [{ mimeType: 'image/png', hostPath: '/data/attachments/sent/def/shot.png', name: 'shot.png' }],
    })
    expect(session.messages).toMatchObject([{
      role: 'user',
      content: 'Read the log',
      attachments: [
        { type: 'file', name: 'log.txt', hostPath: '/data/attachments/sent/abc/log.txt', hostServerId: 'host-1' },
        { type: 'image', name: 'shot.png', hostPath: '/data/attachments/sent/def/shot.png' },
      ],
    }])
  })

  test('replayed steering confirmation does not reset activity or add a turn', () => {
    const { session, reducer } = fixture()
    const event = { type: 'user_message' as const, text: 'Hello', clientPromptId: 'prompt-1', delivery: 'steer' as const }
    reducer.apply('session', event)
    session.currentActivity = 'Reading files...'
    reducer.apply('session', event)
    expect(session.messages).toHaveLength(1)
    expect(session.currentActivity).toBe('Reading files...')
  })
})
