import { describe, expect, test } from 'bun:test'
import type { AgentConversationRef, AgentExchange, ExchangeProgress, Message, Session } from '@solus/contracts/types'
import { formatParentPrompt, formatSessionNotice } from '@solus/contracts/session-exchange'
import {
  agentConversationCardState,
  agentConversationLink,
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
// kept with it, and the host — not a timer, not a second lookup — saying where
// a message the transcript opened stands, on the page it serves.

const child = '11111111-1111-4111-8111-111111111111'
const first = '22222222-2222-4222-8222-222222222222'
const second = '33333333-3333-4333-8333-333333333333'

function session(): Session {
  return { messages: [] as Message[] } as Session
}

function cardRef(exchange: Partial<AgentExchange>): AgentConversationRef {
  return {
    sessionId: child,
    provider: 'codex',
    title: 't',
    cwd: '',
    origin: 'prompted',
    exchanges: [{ messageId: 'm1', index: 1, prompt: 'p', dispatchedAt: 0, status: 'dispatched', ...exchange }],
  }
}

describe('a card, live', () => {
  test("follows one message from dispatch to reply, keeping the person's answer and what was produced", () => {
    const tab = session()
    const cards = new AgentConversationCards()
    expect(cards.apply(tab, {
      phase: 'dispatched', sessionId: child, messageId: first, origin: 'prompted', prompt: 'ship it',
      provider: 'codex', title: 'Ship', cwd: '/repo', dispatchedAt: 1,
    }).newCard).toBe(true)
    const ref = () => tab.messages[0]!.agentConversationRef!
    expect(agentConversationCardState(ref())).toBe('dispatching')

    cards.apply(tab, { phase: 'accepted', sessionId: child, messageId: first, state: 'queued' })
    expect(agentConversationCardState(ref())).toBe('dispatching')
    cards.apply(tab, { phase: 'accepted', sessionId: child, messageId: first, state: 'running' })
    expect(agentConversationCardState(ref())).toBe('replying')

    const request = { kind: 'question' as const, question: { questionId: 'q1', questions: [{ id: 'branch', question: 'Which branch?', options: [], multiSelect: false }] } }
    expect(cards.apply(tab, { phase: 'awaiting_input', sessionId: child, messageId: first, request }).needsAttention).toBe(true)
    expect(agentConversationCardState(ref())).toBe('waiting')
    expect(pendingRequest(ref())).toEqual(request)

    cards.apply(tab, { phase: 'answered', sessionId: child, messageId: first, answerText: 'Which branch? → main' })
    expect(agentConversationCardState(ref())).toBe('replying')
    expect(pendingRequest(ref())).toBeNull()

    cards.apply(tab, {
      phase: 'settled', sessionId: child, messageId: first, status: 'completed', replyText: 'shipped',
      outputs: [
        { kind: 'question', question: 'Which branch?', answer: 'main' },
        { kind: 'pull_request', number: 7, url: 'https://example.test/pr/7' },
      ],
      taskId: 'task-1', settledAt: 2,
    })
    expect(agentConversationCardState(ref())).toBe('replied')
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

describe('a card whose other session is stopped', () => {
  // plans/004-shared-host-collaboration.md D12: Stop ends the running turn and
  // keeps the queue, so a message still waiting stays open and the card stays live.
  test('closes the running message and keeps a queued one open', () => {
    const tab = session()
    const cards = new AgentConversationCards()
    cards.apply(tab, { phase: 'dispatched', sessionId: child, messageId: first, origin: 'prompted', prompt: 'long job', provider: 'codex', title: 'Job', cwd: '/repo', dispatchedAt: 1 })
    cards.apply(tab, { phase: 'accepted', sessionId: child, messageId: first, state: 'running' })
    cards.apply(tab, { phase: 'dispatched', sessionId: child, messageId: second, origin: 'prompted', prompt: 'then this', provider: 'codex', title: 'Job', cwd: '/repo', dispatchedAt: 2 })
    cards.apply(tab, { phase: 'accepted', sessionId: child, messageId: second, state: 'queued' })

    cards.apply(tab, { phase: 'stopped', sessionId: child })

    const exchanges = tab.messages.flatMap((message) => message.agentConversationRef?.exchanges ?? [])
    expect(exchanges.find((exchange) => exchange.messageId === first)?.status).toBe('interrupted')
    expect(exchanges.find((exchange) => exchange.messageId === second)?.status).toBe('queued')
    expect(tab.messages.some((message) => message.agentConversationRef?.closedByAgent)).toBe(false)
  })
})

describe('a card whose other session is rate limited', () => {
  test('says so while the turn is parked, and goes back to replying when it resumes', () => {
    const tab = session()
    const cards = new AgentConversationCards()
    cards.apply(tab, {
      phase: 'dispatched', sessionId: child, messageId: first, origin: 'prompted', prompt: 'long job',
      provider: 'codex', title: 'Job', cwd: '/repo', dispatchedAt: 1,
    })
    cards.apply(tab, { phase: 'accepted', sessionId: child, messageId: first, state: 'running' })
    const ref = () => tab.messages[0]!.agentConversationRef!
    expect(cards.apply(tab, { phase: 'rate_limited', sessionId: child, messageId: first, resetsAt: 5_000, limitType: 'Codex 5h' }).needsAttention).toBe(true)
    expect(agentConversationCardState(ref())).toBe('limited')
    expect(rateLimitedUntil(ref())).toBe(5_000)

    cards.apply(tab, { phase: 'accepted', sessionId: child, messageId: first, state: 'running' })
    expect(agentConversationCardState(ref())).toBe('replying')
    expect(rateLimitedUntil(ref())).toBeUndefined()
  })

})

describe("a card's link to the other session's task", () => {
  test('comes from the latest report that named one', () => {
    const ref = cardRef({ status: 'done', taskId: 'task-old' })
    ref.exchanges.push({ messageId: 'm2', index: 2, prompt: 'next', dispatchedAt: 1, status: 'done', taskId: 'task-new' })
    ref.exchanges.push({ messageId: 'm3', index: 3, prompt: 'again', dispatchedAt: 2, status: 'running' })
    expect(cardTaskId(ref)).toBe('task-new')
    expect(cardTaskId(cardRef({}))).toBeUndefined()
  })
})

describe('a card rebuilt from its transcript', () => {
  test('a report pairs with the message it names, and brings back its answers, outputs and provider', () => {
    const messages: Message[] = []
    const transcript = new TranscriptAgentConversations(messages)
    transcript.applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'one' }), { messageId: first }, 1)
    transcript.applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'two' }), { messageId: second }, 2)
    const report = formatParentPrompt([{ type: 'report', report: {
      messageId: second, sessionId: child, taskId: 'task-1', provider: 'codex', status: 'completed', durationMs: 4_200,
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
      [first, 'lost', undefined],
      [second, 'done', 'two done'],
    ])
    expect(ref.exchanges[1]).toMatchObject({ answers: ['Which branch? → main'], taskId: 'task-1', durationMs: 4_200, outputs: [{ kind: 'question' }, { kind: 'work', workId: 'w1' }] })
  })

  test('a call that waited for its reply settles its card from the tool row alone', () => {
    const messages: Message[] = []
    const transcript = new TranscriptAgentConversations(messages)
    transcript.applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'check' }), {
      messageId: first,
      report: { messageId: first, sessionId: child, status: 'completed', outputs: [], reply: 'checked' },
    }, 1)
    const exchange = messages[0]!.agentConversationRef!.exchanges[0]!
    expect(exchange).toMatchObject({ status: 'done', reply: 'checked' })
  })

  test('one prompt that carried several reports settles every message it names', () => {
    const messages: Message[] = []
    const transcript = new TranscriptAgentConversations(messages)
    transcript.applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'one' }), { messageId: first }, 1)
    transcript.applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'two' }), { messageId: second }, 2)
    const merged = formatParentPrompt([first, second].map((messageId, index) => ({ type: 'report' as const, report: {
      messageId, sessionId: child, status: 'completed' as const, outputs: [], reply: `reply ${index + 1}`,
    } })))
    expect(transcript.applyUserRow(merged, 3)).toBe(true)
    expect(messages[0]!.agentConversationRef!.exchanges.map((exchange) => exchange.reply)).toEqual(['reply 1', 'reply 2'])
  })

  test('a report for one turn that answered two messages settles both', () => {
    // WHY: the host sends one report when one turn answers several messages
    // from the same sender; each message's card still needs its reply.
    const messages: Message[] = []
    const transcript = new TranscriptAgentConversations(messages)
    transcript.applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'one' }), { messageId: first }, 1)
    transcript.applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'two' }), { messageId: second }, 2)
    const report = formatParentPrompt([{ type: 'report', report: {
      messageId: first, alsoMessageIds: [second], sessionId: child, status: 'completed', outputs: [], reply: 'both done',
    } }])
    expect(transcript.applyUserRow(report, 3)).toBe(true)
    expect(messages[0]!.agentConversationRef!.exchanges.map((exchange) => [exchange.status, exchange.reply])).toEqual([
      ['done', 'both done'],
      ['done', 'both done'],
    ])
  })

  test('a notice is consumed without a bubble and leaves the message where the host said it stands', () => {
    const messages: Message[] = []
    const transcript = new TranscriptAgentConversations(messages)
    const request = { kind: 'question' as const, question: { questionId: 'q1', questions: [] } }
    transcript.applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'one' }), { messageId: first, progress: { state: 'awaiting_input', request } }, 1)
    const notice = formatSessionNotice({ messageId: first, sessionId: child, kind: 'question', questionId: 'q1', questions: [{ question: 'Which branch?', options: [] }] })
    expect(transcript.applyUserRow(notice, 2)).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.agentConversationRef!.exchanges[0]).toMatchObject({ status: 'awaiting_input', request })
  })

  test('ordinary user text is not a report', () => {
    const transcript = new TranscriptAgentConversations([])
    expect(transcript.applyUserRow('please ship the parser', 1)).toBe(false)
  })

  test("the host's word on the page decides where a rebuilt message stands", () => {
    const rebuilt = (progress: ExchangeProgress | undefined) => {
      const messages: Message[] = []
      new TranscriptAgentConversations(messages)
        .applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'one' }), { messageId: first, progress }, 1)
      return messages[0]!.agentConversationRef!
    }
    expect(agentConversationCardState(rebuilt({ state: 'queued' }))).toBe('dispatching')
    // The bug this guards: a message the host was running read as queued.
    expect(agentConversationCardState(rebuilt({ state: 'running' }))).toBe('replying')
    // A finished reply still on its way to the sender is not yet a reply here.
    expect(agentConversationCardState(rebuilt({ state: 'reply_queued' }))).toBe('replying')
    expect(agentConversationCardState(rebuilt({ state: 'waiting_for_children' }))).toBe('children')
    const request = { kind: 'permission' as const, permission: { questionId: 'p1', toolTitle: 'Bash', options: [] } }
    const waiting = rebuilt({ state: 'awaiting_input', request })
    expect(agentConversationCardState(waiting)).toBe('waiting')
    // The transcript never recorded the request; the host still has it.
    expect(pendingRequest(waiting)).toEqual(request)
    const parked = rebuilt({ state: 'rate_limited', resetsAt: 9_000 })
    expect(agentConversationCardState(parked)).toBe('limited')
    expect(rateLimitedUntil(parked)).toBe(9_000)
    expect(agentConversationCardState(rebuilt({ state: 'settled', outcome: 'completed' }))).toBe('replied')
    expect(agentConversationCardState(rebuilt({ state: 'settled', outcome: 'failed' }))).toBe('failed')
    // The host no longer carries it and the transcript has no reply: a restart took it.
    expect(agentConversationCardState(rebuilt(undefined))).toBe('lost')
  })

  test('a rebuilt card follows the live feed like a card that was shown live', () => {
    const tab = session()
    new TranscriptAgentConversations(tab.messages)
      .applyToolRow('start_session', JSON.stringify({ prompt: 'snooze tasks' }), { sessionId: child, messageId: first, progress: { state: 'queued' } }, 1)
    const cards = new AgentConversationCards()
    cards.rebuild(tab)
    const ref = () => tab.messages[0]!.agentConversationRef!
    expect(agentConversationCardState(ref())).toBe('dispatching')
    cards.apply(tab, { phase: 'accepted', sessionId: child, messageId: first, state: 'running' })
    expect(agentConversationCardState(ref())).toBe('replying')
    cards.apply(tab, { phase: 'settled', sessionId: child, messageId: first, status: 'completed', replyText: 'done', settledAt: 2 })
    expect(agentConversationCardState(ref())).toBe('replied')
  })

  test('a report older than message ids still settles a message the host no longer carries', () => {
    const messages: Message[] = []
    const transcript = new TranscriptAgentConversations(messages)
    transcript.applyToolRow('send_session', JSON.stringify({ session_id: child, message: 'one' }), undefined, 1)
    const report = formatParentPrompt([{ type: 'report', report: { sessionId: child, status: 'completed', outputs: [], reply: 'done' } }])
    expect(transcript.applyUserRow(report, 2)).toBe(true)
    expect(messages[0]!.agentConversationRef!.exchanges.map((exchange) => [exchange.status, exchange.reply])).toEqual([['done', 'done']])
  })
})

describe('a plan the other agent brought back', () => {
  test('waits on a decision until another message opens', () => {
    const plan = { kind: 'plan' as const, sessionId: child, planToolUseId: 'tool-1', title: 'Ship the parser' }
    const ref = cardRef({ status: 'done', outputs: [plan] })
    expect(planAwaitingDecision(ref)).toEqual(plan)
    ref.exchanges.push({ messageId: 'm2', index: 2, prompt: 'next', dispatchedAt: 1, status: 'running' })
    expect(planAwaitingDecision(ref)).toBeNull()
  })
})

describe("a card's status line", () => {
  // WHY: the dot, the word, and the detail are the only things that say where
  // the other session stands; a session that never started must not read as
  // one that broke, and a reply shows its first words.
  test('names the live state, tells a launch failure from a stop, and shows the reply', () => {
    const live = cardRef({ status: 'running' })
    expect(agentConversationLink(live, 'replying', false)).toEqual({ tone: 'live', label: 'Running', detail: '' })
    expect(agentConversationLink(live, 'dispatching', true)).toMatchObject({ tone: 'live', label: 'Starting' })
    expect(agentConversationLink(live, 'failed', true)).toMatchObject({ tone: 'failed', detail: 'Never started' })
    expect(agentConversationLink(live, 'failed', false)).toMatchObject({ detail: 'Stopped replying' })

    const replied = cardRef({ status: 'answered', reply: '- Moved the `diff` panel' })
    expect(agentConversationLink(replied, 'replied', false)).toEqual({
      tone: 'done',
      label: 'Completed',
      detail: 'Moved the diff panel',
    })
  })
})
