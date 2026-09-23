import { describe, expect, test } from 'bun:test'
import type { AgentConversationRef, AgentExchange, IpcContext, Message, SentSessionMessage } from '@solus/contracts/types'
import {
  agentConversationCardState,
  sendFromCard,
  typedAnswerTarget,
} from '@solus/workspace-ui/components/conversation/agent-conversation/lib/agent-conversation'
import { AgentConversationTranscriptBuilder } from '@solus/workspace-ui/contexts/workspace/agent-conversation-transcript'

// WHY: stage 2 of plans/003-session-message-integration.md. A card rebuilt
// from a transcript must pair each reply with the exact message it answers,
// must ask the host rather than a timer whether a message is still live, and
// must answer a question through the question itself, not as queued text.

function restoredRef(exchange: Partial<AgentExchange>): AgentConversationRef {
  return {
    agentSessionId: '11111111-1111-4111-8111-111111111111',
    provider: 'codex',
    title: 't',
    cwd: '',
    origin: 'prompted',
    exchanges: [{ messageId: 'm1', index: 1, prompt: 'p', dispatchedAt: 0, status: 'dispatched', restored: true, ...exchange }],
  }
}

describe('a card rebuilt from its transcript', () => {
  test('a report pairs with the message it names, not the oldest one still open', () => {
    const child = '11111111-1111-4111-8111-111111111111'
    const first = '22222222-2222-4222-8222-222222222222'
    const second = '33333333-3333-4333-8333-333333333333'
    const messages: Message[] = []
    const builder = new AgentConversationTranscriptBuilder(messages)
    builder.applyToolRow('prompt_session', JSON.stringify({ session_id: child, prompt: 'one' }), { messageId: first }, 1)
    builder.applyToolRow('prompt_session', JSON.stringify({ session_id: child, prompt: 'two' }), { messageId: second }, 2)
    expect(builder.applyUserRow(`[session report] Session ${child} finished (status: completed; message: ${second}). Final reply:\ntwo done`, 3)).toBe(true)

    const exchanges = messages[0].agentConversationRef!.exchanges
    expect(exchanges.map((exchange) => [exchange.messageId, exchange.status, exchange.reply])).toEqual([
      [first, 'dispatched', undefined],
      [second, 'done', 'two done'],
    ])
  })

  test('the host, not a timer, decides whether a rebuilt message is still live', () => {
    const ref = restoredRef({})
    expect(agentConversationCardState(ref, null, undefined)).toBe('dispatching')
    expect(agentConversationCardState(ref, null, null)).toBe('replied')
    const carried = (state: SentSessionMessage['state']): SentSessionMessage => ({ messageId: 'm1', targetAgentSessionId: ref.agentSessionId, state })
    expect(agentConversationCardState(ref, null, carried('queued'))).toBe('dispatching')
    expect(agentConversationCardState(ref, null, carried('running'))).toBe('replying')
    expect(agentConversationCardState(ref, null, carried('awaiting_input'))).toBe('waiting')
    // A live message is never aged out, however old.
    expect(agentConversationCardState(restoredRef({ restored: false }), null, null)).toBe('dispatching')
  })
})

describe('a card composer', () => {
  const sender = { ctx: { session: { sessionId: 'parent' } } as IpcContext, sessionId: 'parent' }

  test('answers a plain question through the question, keyed as its question card would', async () => {
    const calls: unknown[] = []
    const api = {
      respondQuestion: async (...args: unknown[]) => { calls.push(['respondQuestion', ...args.slice(1)]); return true },
      promptSession: async (...args: unknown[]) => { calls.push(['promptSession', ...args]); return { disposition: 'started' as const } },
    }
    const target = typedAnswerTarget({ kind: 'question', questionId: 'q1', answerKey: 'branch', text: 'Which branch?' })
    expect(await sendFromCard(api, sender, 'child', 'main', target)).toBe('sent')
    expect(calls).toEqual([['respondQuestion', 'q1', { branch: 'main' }]])
  })

  test('sends anything else as a new message whose reply comes back to this card', async () => {
    const calls: Array<[string, string, string | undefined, { messageId: string; fromSessionId: string } | undefined]> = []
    const api = {
      respondQuestion: async () => true,
      promptSession: async (sessionId: string, prompt: string, delivery?: string, reply?: { messageId: string; fromSessionId: string }) => {
        calls.push([sessionId, prompt, delivery, reply])
        return { disposition: 'queued' as const }
      },
    }
    // A permission, a plan, or several questions are never answered by typing.
    expect(typedAnswerTarget({ kind: 'permission', questionId: 'p1', text: 'Wants to run Bash' })).toBeNull()
    expect(typedAnswerTarget({ kind: 'question', questionId: 'q2', text: 'Two questions' })).toBeNull()
    expect(await sendFromCard(api, sender, 'child', 'keep going', null)).toBe('queued')
    expect(calls).toHaveLength(1)
    expect(calls[0].slice(0, 3)).toEqual(['child', 'keep going', 'queue'])
    expect(calls[0][3]?.fromSessionId).toBe('parent')
    expect(calls[0][3]?.messageId).toBeString()
  })
})
