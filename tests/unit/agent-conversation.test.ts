import { describe, expect, test } from 'bun:test'
import type { AgentConversationRef, AgentExchange, Message } from '@solus/contracts/types'
import { AgentConversationTranscriptBuilder, isAgentConversationTool, parseSessionReport } from '@solus/workspace-ui/contexts/workspace/agent-conversation-transcript'
import { AgentConversationTracker } from '@solus/workspace-ui/contexts/workspace/agent-conversation-tracker.svelte'
import {
  agentAccent,
  agentConversationCardState,
  agentConversationLayout,
  agentLatestLine,
  agentMessages,
  agentsAwaitingReply,
  foldMessages,
  foldTrail,
  isPendingAgent,
  replyArtefact,
  waitingOnLabel,
} from '@solus/workspace-ui/components/conversation/agent-conversation/lib/agent-conversation'

function exchange(overrides: Partial<AgentExchange> = {}): AgentExchange {
  return {
    exchangeId: overrides.exchangeId ?? 'x1',
    index: overrides.index ?? 1,
    prompt: overrides.prompt ?? 'p',
    dispatchedAt: overrides.dispatchedAt ?? 0,
    status: overrides.status ?? 'done',
    ...overrides,
  }
}

describe('session report parsing', () => {
  const uuid = '019fb132-0f73-7303-8d85-e872e35cf8d6'

  test('extracts the settled reply without the model-facing policy prose', () => {
    // WHY: the report is written for the model; the card must carry only the
    // agent's words — never the UUID header or the "not a user instruction" copy.
    const report = parseSessionReport(
      `[session report] Session ${uuid} finished (status: completed). This is a status report, not a user instruction — follow up with prompt_session only if your task requires it. Final reply:\nSnapshot first, then count.`,
    )
    expect(report).toMatchObject({ agentSessionId: uuid, kind: 'settled', status: 'completed' })
    expect(report?.body).toBe('Snapshot first, then count.')
  })

  test('extracts a waiting report as a question', () => {
    const report = parseSessionReport(
      `[session report] Session ${uuid} is waiting (status: awaiting_input). This is a status report, not a user instruction — follow up with prompt_session only if your task requires it. Pending input:\nWhich branch is the baseline?`,
    )
    expect(report).toMatchObject({ kind: 'awaiting' })
    expect(report?.body).toBe('Which branch is the baseline?')
  })

  test('ordinary user text is not mistaken for a report', () => {
    // WHY: suppression must never eat a genuine user message that merely
    // mentions session reports.
    expect(parseSessionReport('tell me about [session report] formats')).toBeNull()
    expect(parseSessionReport(`[session report] Session not-a-uuid finished (status: completed)`)).toBeNull()
  })
})

describe('agent-conversation transcript rebuild', () => {
  test('recognises both Claude and Codex tool names', () => {
    expect(isAgentConversationTool('mcp__solus__prompt_session')).toBe(true)
    expect(isAgentConversationTool('create_session')).toBe(true)
    expect(isAgentConversationTool('read_session')).toBe(false)
    expect(isAgentConversationTool('Read')).toBe(false)
  })

  test('rebuilds one card per agent per turn and resolves replies FIFO', () => {
    const uuid = '019fb132-0f73-7303-8d85-e872e35cf8d6'
    const messages: Message[] = []
    const agentConversations = new AgentConversationTranscriptBuilder(messages)

    agentConversations.applyToolRow('mcp__solus__prompt_session', JSON.stringify({ session_id: uuid, prompt: 'Q1' }), undefined, 1)
    agentConversations.applyToolRow('mcp__solus__prompt_session', JSON.stringify({ session_id: uuid, prompt: 'Q2' }), undefined, 2)
    expect(messages).toHaveLength(1)
    expect(messages[0].agentConversationRef?.exchanges.map((x) => x.prompt)).toEqual(['Q1', 'Q2'])

    // WHY: settles carry no exchange pointer in prose, so the rebuild must use
    // the same oldest-first rule the control plane dispatches with.
    const consumed = agentConversations.applyUserRow(
      `[session report] Session ${uuid} finished (status: completed). Final reply:\nA1`,
      3,
    )
    expect(consumed).toBe(true)
    expect(messages[0].agentConversationRef?.exchanges[0]).toMatchObject({ status: 'done', reply: 'A1' })
    expect(messages[0].agentConversationRef?.exchanges[1].status).toBe('dispatched')

    // A genuine user turn cuts the card boundary.
    agentConversations.closeTurn()
    agentConversations.applyToolRow('prompt_session', JSON.stringify({ session_id: uuid, prompt: 'Q3' }), undefined, 3)
    expect(messages).toHaveLength(2)
    expect(messages[1].agentConversationRef?.exchanges[0].index).toBe(3)
  })

  test('create_session learns the agent session id from the tool result link', () => {
    const uuid = '019fb132-0f73-7303-8d85-e872e35cf8d6'
    const messages: Message[] = []
    const agentConversations = new AgentConversationTranscriptBuilder(messages)
    agentConversations.applyToolRow(
      'mcp__solus__create_session',
      JSON.stringify({ prompt: 'Review the change', model_id: 'gpt-5.5' }),
      `Created session [abc](session://open?provider=codex&sessionId=${uuid}&cwd=%2Frepo) running on codex/gpt-5.5 (reasoning: high).`,
      5,
    )
    expect(messages[0].agentConversationRef).toMatchObject({ agentSessionId: uuid, origin: 'created', model: 'gpt-5.5' })
  })

  test('a launched session stays flagged until this side talks to it', () => {
    // WHY: fire-and-forget owes this conversation no reply, which is what earns
    // the card its collapsed rest state. Prompting it makes it a conversation
    // again, and a conversation has to be readable where it happens.
    const uuid = '019fb132-0f73-7303-8d85-e872e35cf8d6'
    const messages: Message[] = []
    const agentConversations = new AgentConversationTranscriptBuilder(messages)
    agentConversations.applyToolRow(
      'mcp__solus__create_session',
      JSON.stringify({ prompt: 'Kick off the migration', model_id: 'gpt-5.5', mode: 'fire_and_forget' }),
      `Created session [abc](session://open?provider=codex&sessionId=${uuid}&cwd=%2Frepo) running on codex/gpt-5.5 (reasoning: high).`,
      5,
    )
    expect(messages[0].agentConversationRef?.fireAndForget).toBe(true)

    agentConversations.applyToolRow('prompt_session', JSON.stringify({ session_id: uuid, prompt: 'How far in?' }), undefined, 6)
    expect(messages[0].agentConversationRef?.fireAndForget).toBeUndefined()
  })

  test('a wait that never armed produces no exchange', () => {
    const messages: Message[] = []
    const agentConversations = new AgentConversationTranscriptBuilder(messages)
    agentConversations.applyToolRow(
      'wait_for_session',
      JSON.stringify({ session_id: '019fb132-0f73-7303-8d85-e872e35cf8d6' }),
      'Session x is currently idle, not running/busy; no watcher was registered. Use read_session to inspect its latest reply.',
      1,
    )
    expect(messages).toHaveLength(0)
  })
})

function ref(prompts: string[], overrides: Partial<AgentConversationRef> = {}): AgentConversationRef {
  return {
    agentSessionId: overrides.agentSessionId ?? 's1',
    provider: 'codex',
    title: 'peer',
    cwd: '/r',
    origin: 'prompted',
    exchanges: prompts.map((prompt, i) => exchange({ exchangeId: `x${i}`, index: i + 1, prompt })),
    ...overrides,
  }
}

describe('agent-conversation layout', () => {
  test('one agent is a two-voice card; two or more share one switchboard', () => {
    // WHY: a turn that asked four agents something would otherwise cost four
    // headers, four clocks and four footers. The tab row is the roster, and it
    // scrolls rather than growing the card.
    const agents = (count: number) =>
      Array.from({ length: count }, (_, i) => ref(['a', 'b'], { agentSessionId: `s${i}` }))
    expect(agentConversationLayout(agents(1))).toBe('single')
    expect(agentConversationLayout(agents(2))).toBe('switchboard')
    expect(agentConversationLayout(agents(9))).toBe('switchboard')
  })

  test('a blocked agent shows its question in the at-rest line, not its last reply', () => {
    // WHY: that line is the only place the block is visible. Showing the reply
    // it managed before stalling hides the thing that needs a human.
    const blocked = ref(['why?'])
    blocked.exchanges[0].reply = 'Two paths can drop a live entry.'
    blocked.exchanges[0].question = { kind: 'question', text: 'Which branch is the baseline?' }
    expect(agentLatestLine(blocked, 'waiting')).toBe('Which branch is the baseline?')
    expect(agentLatestLine(blocked, 'done')).toBe('Two paths can drop a live entry.')
  })

  test('colour is assigned by dispatch order, not by vendor', () => {
    // WHY: two sessions of the same agent must be told apart, and the two
    // colours that mean something — chart-2 "needs you", destructive "failed" —
    // are states, so neither may ever be handed out as an identity.
    expect([0, 1, 2, 3].map(agentAccent)).toEqual([
      'var(--chart-4)',
      'var(--primary)',
      'var(--chart-5)',
      'var(--chart-3)',
    ])
    expect(agentAccent(4)).toBe(agentAccent(0))
  })
})

describe('agent-conversation messages', () => {
  test('an exchange is two messages, each saying who said it', () => {
    // WHY: attribution is carried by words, not by alignment — so the prompt
    // and the reply have to be separate blocks the card can label.
    const conversation = ref(['Snapshot, or hold the lock?'])
    conversation.exchanges[0].reply = 'Snapshot first.'
    expect(agentMessages(conversation).map((message) => [message.from, message.text])).toEqual([
      ['you', 'Snapshot, or hold the lock?'],
      ['agent', 'Snapshot first.'],
    ])
  })

  test('an unsettled tail is one pending slot — the typing indicator', () => {
    // WHY: the dots occupy the position the reply will take, and there is
    // exactly one of them; two pending slots would mean two agents in one card.
    const conversation = ref(['a', 'b'])
    conversation.exchanges[0].reply = 'first answer'
    conversation.exchanges[1].status = 'dispatched'
    const pending = agentMessages(conversation).filter((message) => message.pending)
    expect(pending).toHaveLength(1)
    expect(pending[0].from).toBe('agent')
  })

  test('a failure with nothing said adds no empty block', () => {
    // WHY: the header already carries the cause. A labelled block with no words
    // under it would state the failure twice and cost a third of the card.
    const conversation = ref(['a'])
    conversation.exchanges[0].status = 'failed'
    expect(agentMessages(conversation)).toHaveLength(1)
  })

  test('live keeps the last two messages open; at rest keeps the final reply only', () => {
    // WHY: the constant-height contract — a fifteen-message negotiation must
    // not grow the card without bound.
    const conversation = ref(['q1', 'q2'])
    conversation.exchanges[0].reply = 'a1'
    conversation.exchanges[1].reply = 'a2'
    const messages = agentMessages(conversation)
    expect(foldMessages(messages, false).open.map((m) => m.text)).toEqual(['q2', 'a2'])
    expect(foldMessages(messages, true).open.map((m) => m.text)).toEqual(['a2'])
    expect(foldMessages(messages.slice(0, 2), false).folded).toHaveLength(0)
  })

  test('the fold trail quotes the folded replies, never the prompts', () => {
    // WHY: quote, don't summarise. The trail is the agent's own first clause;
    // any real synthesis belongs in the parent's prose below the card, where it
    // is attributable.
    const conversation = ref(['why is p99 doubling?', 'and the refcount?'])
    conversation.exchanges[0].reply = 'The sweep holds the lock. Everything else is noise.'
    conversation.exchanges[1].reply = 'Throughput is unchanged.'
    const { folded } = foldMessages(agentMessages(conversation), false)
    expect(foldTrail(folded)).toBe('The sweep holds the lock.')
  })
})

describe('the answered phase carries no exchangeId', () => {
  function session(): { messages: Message[] } {
    return { messages: [] }
  }

  test('it resolves the exchange that is actually parked, and the settle still lands there', () => {
    // WHY: the answering tool acts on a SESSION — it never learns an exchangeId.
    // The tracker has to find the parked exchange itself, and the eventual
    // settle must land in that same one rather than opening an orphan.
    const tracker = new AgentConversationTracker()
    const agentSession = session() as any
    tracker.apply(agentSession, {
      phase: 'dispatched',
      agentSessionId: 's1',
      exchangeId: 'x1',
      origin: 'prompted',
      prompt: 'Rework the eviction pass',
      provider: 'codex',
      title: 'peer',
      cwd: '/r',
      dispatchedAt: 0,
    })
    tracker.apply(agentSession, {
      phase: 'awaiting_input',
      agentSessionId: 's1',
      exchangeId: 'x1',
      kind: 'question',
      questionText: 'Snapshot or hold the lock?',
    })
    tracker.apply(agentSession, { phase: 'answered', agentSessionId: 's1', answerText: 'Snapshot' })

    const exchanges = agentSession.messages[0].agentConversationRef.exchanges
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0]).toMatchObject({ status: 'answered', answer: 'Snapshot' })

    tracker.apply(agentSession, {
      phase: 'settled',
      agentSessionId: 's1',
      exchangeId: 'x1',
      status: 'completed',
      replyText: 'Snapshot it is.',
      settledAt: 5,
    })
    expect(agentSession.messages[0].agentConversationRef.exchanges).toHaveLength(1)
    expect(exchanges[0]).toMatchObject({ status: 'done', reply: 'Snapshot it is.', answer: 'Snapshot' })
    expect(exchanges[0].question.text).toBe('Snapshot or hold the lock?')
  })

  test('an answer with nothing parked changes nothing rather than patching the wrong exchange', () => {
    const tracker = new AgentConversationTracker()
    const agentSession = session() as any
    tracker.apply(agentSession, {
      phase: 'dispatched',
      agentSessionId: 's1',
      exchangeId: 'x1',
      origin: 'prompted',
      prompt: 'p',
      provider: 'codex',
      title: 'peer',
      cwd: '/r',
      dispatchedAt: 0,
    })
    tracker.apply(agentSession, { phase: 'answered', agentSessionId: 's1', answerText: 'Snapshot' })
    expect(agentSession.messages[0].agentConversationRef.exchanges[0].status).toBe('dispatched')
  })

  test('a settle after in-place history expansion updates the rehydrated exchange', () => {
    // WHY: transcript arrays stay reactive by identity. Replacing their contents
    // must rebuild correlation indexes rather than append an orphan settle.
    const tracker = new AgentConversationTracker()
    const agentSession = session() as any
    tracker.apply(agentSession, {
      phase: 'dispatched',
      agentSessionId: 's1',
      exchangeId: 'x1',
      origin: 'prompted',
      prompt: 'Inspect the cache',
      provider: 'codex',
      title: 'peer',
      cwd: '/r',
      dispatchedAt: 1,
    })
    const rehydratedExchange = exchange({
      exchangeId: 'x1',
      prompt: 'Inspect the cache',
      status: 'dispatched',
    })
    agentSession.messages.splice(0, agentSession.messages.length, {
      id: 'older-user',
      role: 'user',
      content: 'Earlier context',
      timestamp: 0,
    }, {
      id: 'rehydrated-card',
      role: 'assistant',
      content: '',
      timestamp: 1,
      agentConversationRef: {
        agentSessionId: 's1',
        provider: 'codex',
        title: 'peer',
        cwd: '/r',
        origin: 'prompted',
        exchanges: [rehydratedExchange],
      },
    })
    tracker.rebuild(agentSession)

    tracker.apply(agentSession, {
      phase: 'settled',
      agentSessionId: 's1',
      exchangeId: 'x1',
      status: 'completed',
      replyText: 'The cache is bounded.',
      settledAt: 5,
    })

    expect(agentSession.messages).toHaveLength(2)
    expect(rehydratedExchange).toMatchObject({
      status: 'done',
      reply: 'The cache is bounded.',
    })
  })
})

describe('a peer question this side answered', () => {
  function answered(): AgentConversationRef {
    const conversation = ref(['Rework the eviction pass'])
    conversation.exchanges[0].status = 'awaiting_input'
    conversation.exchanges[0].question = { kind: 'question', questionId: 'q-1', text: 'Snapshot or hold the lock?' }
    return conversation
  }

  test('the card reads as replying, not waiting — the peer is unblocked', () => {
    // WHY: 'waiting' is the state that asks a human to go and act. Once this
    // side has answered there is nothing for anyone to do but wait for the
    // reply, and the status feed may take seconds to catch up.
    const conversation = answered()
    expect(agentConversationCardState(conversation, 'awaiting_input', Date.now())).toBe('waiting')
    conversation.exchanges[0].status = 'answered'
    conversation.exchanges[0].answer = 'Snapshot'
    expect(agentConversationCardState(conversation, 'awaiting_input', Date.now())).toBe('replying')
  })

  test('question, answer and the pending reply are one exchange, in that order', () => {
    // WHY: collapsing to whichever came last would erase either what was asked
    // or what was answered, and the card is the only record of the exchange.
    const conversation = answered()
    conversation.exchanges[0].status = 'answered'
    conversation.exchanges[0].answer = 'Snapshot'
    expect(agentMessages(conversation).map((m) => [m.from, m.kind, m.text, m.pending])).toEqual([
      ['you', 'prompt', 'Rework the eviction pass', false],
      ['agent', 'question', 'Snapshot or hold the lock?', false],
      ['you', 'prompt', 'Snapshot', false],
      ['agent', 'reply', '', true],
    ])
  })

  test('the answer is the at-rest line while the reply is still in flight', () => {
    const conversation = answered()
    conversation.exchanges[0].status = 'answered'
    conversation.exchanges[0].answer = 'Snapshot'
    expect(agentLatestLine(conversation, 'replying')).toBe('Snapshot')
  })

  test('the settle lands in the same exchange and keeps the answered pause', () => {
    // WHY: answered → settled is one round trip. Dropping the question on settle
    // would leave a reply with nothing explaining what it answered.
    const conversation = answered()
    conversation.exchanges[0].status = 'answered'
    conversation.exchanges[0].answer = 'Snapshot'
    conversation.exchanges[0].status = 'done'
    conversation.exchanges[0].reply = 'Snapshot it is — p99 halves.'
    expect(agentMessages(conversation).map((m) => m.text)).toEqual([
      'Rework the eviction pass',
      'Snapshot or hold the lock?',
      'Snapshot',
      'Snapshot it is — p99 halves.',
    ])
  })

  test('an unanswered pause the peer resolved elsewhere leaves only the reply', () => {
    const conversation = answered()
    conversation.exchanges[0].status = 'done'
    conversation.exchanges[0].question = undefined
    conversation.exchanges[0].reply = 'Went with snapshot.'
    expect(agentMessages(conversation).map((m) => m.text)).toEqual(['Rework the eviction pass', 'Went with snapshot.'])
  })
})

describe('what the turn is waiting on', () => {
  const group = (refs: AgentConversationRef[]) => [
    { kind: 'agent-conversation-group' as const, messages: refs.map((agentConversationRef, i) => ({ id: `m${i}`, agentConversationRef }) as Message) },
  ]

  test('a parent blocked on another agent is waiting, not planning', () => {
    // WHY: "Planning the next step" claims the parent is doing something. It
    // isn't — it is blocked on a reply, and the row should name whose.
    const asked = ref(['q'], { provider: 'codex' })
    asked.exchanges[0].status = 'dispatched'
    expect(agentsAwaitingReply(group([asked]))).toEqual(['Codex'])
    expect(waitingOnLabel(['Codex'])).toBe('Waiting on Codex…')
  })

  test('an agent that has replied is no longer being waited on', () => {
    const answered = ref(['q'])
    answered.exchanges[0].reply = 'done'
    expect(agentsAwaitingReply(group([answered]))).toEqual([])
    expect(waitingOnLabel([])).toBeNull()
  })

  test('past two, the row counts them rather than running a list into the truncation', () => {
    expect(waitingOnLabel(['Codex', 'Claude Code'])).toBe('Waiting on Codex and Claude Code…')
    expect(waitingOnLabel(['Codex', 'Claude Code', 'OpenCode'])).toBe('Waiting on 3 agents…')
  })
})

describe('agent-conversation oversized replies', () => {
  test('a diff becomes an attachment row, keeping the framing the agent wrote', () => {
    // WHY: a conversation is not a log viewer. The card states what arrived and
    // hands off — never a 2,000px card, never a truncation with no way to the
    // full text.
    const patch = [
      'Here is the fix.',
      'diff --git a/sweep.rs b/sweep.rs',
      '--- a/sweep.rs',
      '+++ b/sweep.rs',
      '@@ -212,3 +212,3 @@',
      '-    let refs = entry.refcount.load(Acquire);',
      '+    let keys = map.snapshot_keys();',
    ].join('\n')
    expect(replyArtefact(patch)).toEqual({ label: 'Patch · 1 file, 2 lines', framing: 'Here is the fix.' })
  })

  test('ordinary prose stays inline however long it argues', () => {
    // WHY: the 262px clamp handles a long answer. Only artefacts — a diff, a
    // file dump, a test log — are refused inlining at any height.
    expect(replyArtefact('The lock is most of it. '.repeat(20))).toBeNull()
    expect(replyArtefact('x'.repeat(6001))?.label).toBe('Output · 1 line')
  })
})

describe('agent-conversation card state', () => {

  test('a starting session stays dispatching however long startup takes', () => {
    // WHY: create_session can hang for minutes (worktree setup, provider
    // handshake). The card must appear immediately and keep saying "starting"
    // rather than ageing out into a false "replied" — invisible work is the exact
    // failure this card exists to remove.
    const ref = {
      agentSessionId: 'pending:x1', provider: 'claude-code' as const, title: 'New agent', cwd: '/r',
      origin: 'created' as const,
      exchanges: [exchange({ status: 'dispatched', dispatchedAt: 0 })],
    }
    expect(isPendingAgent(ref)).toBe(true)
    expect(agentConversationCardState(ref, null, 5 * 60_000)).toBe('dispatching')
  })

  test('a restored stale exchange settles instead of shimmering forever', () => {
    // WHY: watchers are in-memory; after a restart the settle never arrives.
    // The card must degrade to a quiet settled state, not a permanent spinner.
    const ref = {
      agentSessionId: 'p', provider: 'codex' as const, title: 't', cwd: '/r',
      origin: 'prompted' as const,
      exchanges: [exchange({ status: 'dispatched', dispatchedAt: 0, restored: true })],
    }
    expect(agentConversationCardState(ref, null, 5_000)).toBe('dispatching')
    expect(agentConversationCardState(ref, null, 60_000)).toBe('replied')
    expect(agentConversationCardState(ref, 'running', 60_000)).toBe('replying')
    expect(agentConversationCardState(ref, 'awaiting_input', 60_000)).toBe('waiting')
  })

  test('a live follow-up reactivates a settled conversation until its reply lands', () => {
    // WHY: the status feed can still say idle/completed from the previous round
    // when prompt_session appends a follow-up. The new exchange, not that stale
    // status, owns whether the conversation card is active.
    const ref = {
      agentSessionId: 'p', provider: 'codex' as const, title: 't', cwd: '/r',
      origin: 'prompted' as const,
      exchanges: [
        exchange({ status: 'done', reply: 'Round one', dispatchedAt: 0 }),
        exchange({ exchangeId: 'x2', index: 2, status: 'dispatched', dispatchedAt: 1_000 }),
      ],
    }
    expect(agentConversationCardState(ref, 'completed', 60_000)).toBe('dispatching')

    ref.exchanges[1].status = 'done'
    ref.exchanges[1].reply = 'Round two'
    expect(agentConversationCardState(ref, 'completed', 60_000)).toBe('replied')
  })
})
