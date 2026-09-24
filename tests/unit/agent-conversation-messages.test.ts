import { describe, expect, test } from 'bun:test'
import type { AgentConversationRef, AgentExchange, Message, SentSessionMessage, Session } from '@solus/contracts/types'
import { formatParentPrompt, formatSessionNotice } from '@solus/contracts/session-exchange'
import {
  agentConversationCardState,
  agentMessages,
  pendingRequest,
  planAwaitingDecision,
  rateLimitedUntil,
  cardTaskId,
} from '@solus/workspace-ui/components/conversation/agent-conversation/lib/agent-conversation'
import { AgentConversationCards, TranscriptAgentConversations } from '@solus/workspace-ui/contexts/workspace/agent-conversation-cards'

// WHY: one conversation's agent cards are built in one place, live from the
// host's orchestrator and on reload from the transcript. A card rebuilt from
// history must be the card that was shown live: each reply paired with the
// exact message it answers, what a person answered and what the turn produced
// kept with it, and the host — not a timer — deciding whether a message the
// transcript opened is still alive.

const child = '11111111-1111-4111-8111-111111111111'
const first = '22222222-2222-4222-8222-222222222222'
const second = '33333333-3333-4333-8333-333333333333'

function session(): Session {
  return { messages: [] as Message[] } as Session
}

function restoredRef(exchange: Partial<AgentExchange>): AgentConversationRef {
  return {
    agentSessionId: child,
    provider: 'codex',
    title: 't',
    cwd: '',
    origin: 'prompted',
    exchanges: [{ messageId: 'm1', index: 1, prompt: 'p', dispatchedAt: 0, status: 'dispatched', restored: true, ...exchange }],
  }
}

describe('a card, live', () => {
  test("follows one message from dispatch to reply, keeping the person's answer and what was produced", () => {
    const tab = session()
    const cards = new AgentConversationCards()
    expect(cards.apply(tab, {
      phase: 'dispatched', agentSessionId: child, messageId: first, origin: 'prompted', prompt: 'ship it',
      provider: 'codex', title: 'Ship', cwd: '/repo', dispatchedAt: 1,
    }).newCard).toBe(true)
    const ref = () => tab.messages[0]!.agentConversationRef!
    expect(agentConversationCardState(ref(), undefined)).toBe('dispatching')

    cards.apply(tab, { phase: 'accepted', agentSessionId: child, messageId: first, state: 'queued' })
    expect(agentConversationCardState(ref(), undefined)).toBe('dispatching')
    cards.apply(tab, { phase: 'accepted', agentSessionId: child, messageId: first, state: 'running' })
    expect(agentConversationCardState(ref(), undefined)).toBe('replying')

    const request = { kind: 'question' as const, question: { questionId: 'q1', questions: [{ id: 'branch', question: 'Which branch?', options: [], multiSelect: false }] } }
    expect(cards.apply(tab, { phase: 'awaiting_input', agentSessionId: child, messageId: first, request }).needsAttention).toBe(true)
    expect(agentConversationCardState(ref(), undefined)).toBe('waiting')
    expect(pendingRequest(ref(), undefined)).toEqual(request)

    cards.apply(tab, { phase: 'answered', agentSessionId: child, messageId: first, answerText: 'Which branch? → main' })
    expect(agentConversationCardState(ref(), undefined)).toBe('replying')
    expect(pendingRequest(ref(), undefined)).toBeNull()

    cards.apply(tab, {
      phase: 'settled', agentSessionId: child, messageId: first, status: 'completed', replyText: 'shipped',
      outputs: [
        { kind: 'question', question: 'Which branch?', answer: 'main' },
        { kind: 'pull_request', number: 7, url: 'https://example.test/pr/7' },
      ],
      taskId: 'task-1', settledAt: 2,
    })
    expect(agentConversationCardState(ref(), undefined)).toBe('replied')
    // Question, answer and reply are one exchange.
    expect(agentMessages(ref()).map((message) => [message.from, message.text])).toEqual([
      ['you', 'ship it'], ['agent', 'Which branch?'], ['you', 'Which branch? → main'], ['agent', 'shipped'],
    ])
    // The live answers stand; the outputs and task come with the settle.
    expect(ref().exchanges[0]).toMatchObject({
      answers: ['Which branch? → main'],
      taskId: 'task-1',
      outputs: [{ kind: 'question' }, { kind: 'pull_request', number: 7, url: 'https://example.test/pr/7' }],
    })
  })
})

describe('a card whose other session is rate limited', () => {
  test('says so while the turn is parked, and goes back to replying when it resumes', () => {
    const tab = session()
    const cards = new AgentConversationCards()
    cards.apply(tab, {
      phase: 'dispatched', agentSessionId: child, messageId: first, origin: 'prompted', prompt: 'long job',
      provider: 'codex', title: 'Job', cwd: '/repo', dispatchedAt: 1,
    })
    cards.apply(tab, { phase: 'accepted', agentSessionId: child, messageId: first, state: 'running' })
    const ref = () => tab.messages[0]!.agentConversationRef!
    expect(cards.apply(tab, { phase: 'rate_limited', agentSessionId: child, messageId: first, resetsAt: 5_000, limitType: 'Codex 5h' }).needsAttention).toBe(true)
    expect(agentConversationCardState(ref(), undefined)).toBe('limited')
    expect(rateLimitedUntil(ref(), undefined)).toBe(5_000)

    cards.apply(tab, { phase: 'accepted', agentSessionId: child, messageId: first, state: 'running' })
    expect(agentConversationCardState(ref(), undefined)).toBe('replying')
    expect(rateLimitedUntil(ref(), undefined)).toBeUndefined()
  })

  test('rebuilt from the transcript, the host says it is parked and until when', () => {
    const ref = restoredRef({})
    const carried: SentSessionMessage = { messageId: 'm1', targetAgentSessionId: child, state: 'rate_limited', resetsAt: 9_000 }
    expect(agentConversationCardState(ref, carried)).toBe('limited')
    expect(rateLimitedUntil(ref, carried)).toBe(9_000)
  })
})

describe("a card's link to the other session's task", () => {
  test('comes from the latest report that named one', () => {
    const ref = restoredRef({ status: 'done', restored: false, taskId: 'task-old' })
    ref.exchanges.push({ messageId: 'm2', index: 2, prompt: 'next', dispatchedAt: 1, status: 'done', taskId: 'task-new' })
    ref.exchanges.push({ messageId: 'm3', index: 3, prompt: 'again', dispatchedAt: 2, status: 'running' })
    expect(cardTaskId(ref)).toBe('task-new')
    expect(cardTaskId(restoredRef({}))).toBeUndefined()
  })
})

describe('a card rebuilt from its transcript', () => {
  test('a report pairs with the message it names, and brings back its answers, outputs and provider', () => {
    const messages: Message[] = []
    const transcript = new TranscriptAgentConversations(messages)
    transcript.applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'one' }), { messageId: first }, 1)
    transcript.applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'two' }), { messageId: second }, 2)
    const report = formatParentPrompt([{ type: 'report', report: {
      messageId: second, agentSessionId: child, taskId: 'task-1', provider: 'codex', status: 'completed', durationMs: 4_200,
      outputs: [
        { kind: 'question', question: 'Which branch?', answer: 'main' },
        { kind: 'work', workId: 'w1', title: 'Notes', workType: 'doc' },
      ],
      reply: 'two done',
    } }])
    expect(transcript.applyUserRow(report, 3)).toBe(true)

    const ref = messages[0]!.agentConversationRef!
    expect(ref.provider).toBe('codex')
    expect(ref.exchanges.map((exchange) => [exchange.messageId, exchange.status, exchange.reply])).toEqual([
      [first, 'dispatched', undefined],
      [second, 'done', 'two done'],
    ])
    expect(ref.exchanges[1]).toMatchObject({ answers: ['Which branch? → main'], taskId: 'task-1', durationMs: 4_200, outputs: [{ kind: 'question' }, { kind: 'work', workId: 'w1' }] })
  })

  test('a call that waited for its reply settles its card from the tool row alone', () => {
    const messages: Message[] = []
    const transcript = new TranscriptAgentConversations(messages)
    transcript.applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'check' }), {
      messageId: first,
      report: { messageId: first, agentSessionId: child, status: 'completed', outputs: [], reply: 'checked' },
    }, 1)
    const exchange = messages[0]!.agentConversationRef!.exchanges[0]!
    expect(exchange).toMatchObject({ status: 'done', reply: 'checked' })
    // Settled in the transcript: nothing left to ask the host.
    expect(exchange.restored).toBeUndefined()
  })

  test('one prompt that carried several reports settles every message it names', () => {
    const messages: Message[] = []
    const transcript = new TranscriptAgentConversations(messages)
    transcript.applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'one' }), { messageId: first }, 1)
    transcript.applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'two' }), { messageId: second }, 2)
    const merged = formatParentPrompt([first, second].map((messageId, index) => ({ type: 'report' as const, report: {
      messageId, agentSessionId: child, status: 'completed' as const, outputs: [], reply: `reply ${index + 1}`,
    } })))
    expect(transcript.applyUserRow(merged, 3)).toBe(true)
    expect(messages[0]!.agentConversationRef!.exchanges.map((exchange) => exchange.reply)).toEqual(['reply 1', 'reply 2'])
  })

  test('a notice is consumed without a bubble and leaves the message open for the host to describe', () => {
    const messages: Message[] = []
    const transcript = new TranscriptAgentConversations(messages)
    transcript.applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'one' }), { messageId: first }, 1)
    const notice = formatSessionNotice({ messageId: first, agentSessionId: child, kind: 'question', questionId: 'q1', questions: [{ question: 'Which branch?', options: [] }] })
    expect(transcript.applyUserRow(notice, 2)).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.agentConversationRef!.exchanges[0]).toMatchObject({ status: 'dispatched', restored: true })
  })

  test('ordinary user text is not a report', () => {
    const transcript = new TranscriptAgentConversations([])
    expect(transcript.applyUserRow('please ship the parser', 1)).toBe(false)
  })

  test('the host, not a timer, decides whether a rebuilt message is still live', () => {
    const ref = restoredRef({})
    expect(agentConversationCardState(ref, undefined)).toBe('dispatching')
    // The host no longer carries it and the transcript has no reply: a restart took it.
    expect(agentConversationCardState(ref, null)).toBe('lost')
    const carried = (state: SentSessionMessage['state'], extra: Partial<SentSessionMessage> = {}): SentSessionMessage =>
      ({ messageId: 'm1', targetAgentSessionId: child, state, ...extra })
    expect(agentConversationCardState(ref, carried('queued'))).toBe('dispatching')
    expect(agentConversationCardState(ref, carried('running'))).toBe('replying')
    const request = { kind: 'permission' as const, permission: { questionId: 'p1', toolTitle: 'Bash', options: [] } }
    expect(agentConversationCardState(ref, carried('awaiting_input', { request }))).toBe('waiting')
    // The transcript never recorded the request; the host still has it.
    expect(pendingRequest(ref, carried('awaiting_input', { request }))).toEqual(request)
    // A live message is never aged out, however old.
    expect(agentConversationCardState(restoredRef({ restored: false }), null)).toBe('dispatching')
  })
})

describe('a plan the other agent brought back', () => {
  test('waits on a decision until another message opens', () => {
    const plan = { kind: 'plan' as const, sessionId: child, planToolUseId: 'tool-1', title: 'Ship the parser' }
    const ref = restoredRef({ status: 'done', restored: false, outputs: [plan] })
    expect(planAwaitingDecision(ref)).toEqual(plan)
    ref.exchanges.push({ messageId: 'm2', index: 2, prompt: 'next', dispatchedAt: 1, status: 'running' })
    expect(planAwaitingDecision(ref)).toBeNull()
  })
})
