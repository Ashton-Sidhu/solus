import type { AgentConversationRef, AgentConversationUpdate, AgentExchange, Message, Session } from '../../../shared/types'
import { isAgentNotice, nextMsgId } from './session.utils'

interface AgentConversationState {
  /** agentSessionId → message id of that agent's card in the current turn.
   *  Cleared on every genuine user message, so each turn gets one card per agent. */
  currentByAgent: Map<string, string>
  /** exchangeId → message id, so settles land in the card that dispatched them —
   *  including cards from earlier turns. */
  byExchange: Map<string, string>
  /** agentSessionId → cumulative exchange count; indices never renumber. */
  countByAgent: Map<string, number>
}

const SETTLED_STATUS = {
  completed: 'done',
  interrupted: 'interrupted',
  failed: 'failed',
} satisfies Record<'completed' | 'interrupted' | 'failed', AgentExchange['status']>

interface AgentConversationApplyResult {
  newCard: boolean
  needsAttention: boolean
}

/** Maintains one card per other agent per turn, mutating messages in
 *  place as `agent_conversation_update` events land (same contract as WorkStreamTracker:
 *  keep the pushed message id, patch its ref). */
export class AgentConversationTracker {
  // Keyed by the messages array so clearTab's replacement drops its tracker
  // state. Performance-sensitive hydration expands the same reactive array in
  // place; those callers explicitly rebuild the indexes below.
  private states = new WeakMap<Message[], AgentConversationState>()

  private state(session: Session): AgentConversationState {
    let state = this.states.get(session.messages)
    if (!state) {
      state = { currentByAgent: new Map(), byExchange: new Map(), countByAgent: new Map() }
      this.states.set(session.messages, state)
    }
    return state
  }

  /** Re-index a transcript after hydration replaces its contents in place. */
  rebuild(session: Session): void {
    const state: AgentConversationState = {
      currentByAgent: new Map(),
      byExchange: new Map(),
      countByAgent: new Map(),
    }
    for (const message of session.messages) {
      if (message.role === 'user' && !isAgentNotice(message.content)) {
        state.currentByAgent.clear()
      }
      const conversation = message.agentConversationRef
      if (!conversation) continue
      state.currentByAgent.set(conversation.agentSessionId, message.id)
      for (const exchange of conversation.exchanges) {
        state.byExchange.set(exchange.exchangeId, message.id)
        state.countByAgent.set(
          conversation.agentSessionId,
          Math.max(state.countByAgent.get(conversation.agentSessionId) ?? 0, exchange.index),
        )
      }
    }
    this.states.set(session.messages, state)
  }

  /** A genuine user message closes the turn: the next dispatch per agent starts
   *  a fresh card. Exchange correlation (`byExchange`) survives — late settles
   *  still land in the older turn's card. */
  closeTurn(session: Session): void {
    this.states.get(session.messages)?.currentByAgent.clear()
  }

  /** Returns true when the update was consumed (it always is — agent-conversation events
   *  never fall through to other reducer arms). */
  apply(session: Session, update: AgentConversationUpdate): AgentConversationApplyResult {
    const state = this.state(session)
    switch (update.phase) {
      case 'dispatched': {
        const index = (state.countByAgent.get(update.agentSessionId) ?? 0) + 1
        state.countByAgent.set(update.agentSessionId, index)
        const exchange: AgentExchange = {
          exchangeId: update.exchangeId,
          index,
          prompt: update.prompt,
          delivery: update.delivery,
          dispatchedAt: update.dispatchedAt,
          status: 'dispatched',
        }
        const existing = this.messageFor(session, state.currentByAgent.get(update.agentSessionId))
        if (existing?.agentConversationRef) {
          existing.agentConversationRef.exchanges.push(exchange)
          // A fresh dispatch reopens an agent that was stopped earlier this turn.
          existing.agentConversationRef.closedByAgent = undefined
          // Only create_session launches fire-and-forget, so a dispatch onto an
          // existing card means this side is talking to it after all.
          existing.agentConversationRef.fireAndForget = undefined
          // Later dispatches carry fresher metadata (the CLI slug may have
          // landed since the first prompt) — latest wins.
          existing.agentConversationRef.title = update.title || existing.agentConversationRef.title
          if (update.model) existing.agentConversationRef.model = update.model
          if (update.reasoningEffort) existing.agentConversationRef.reasoningEffort = update.reasoningEffort
          state.byExchange.set(update.exchangeId, existing.id)
          return { newCard: false, needsAttention: false }
        }
        const agentConversationRef: AgentConversationRef = {
          agentSessionId: update.agentSessionId,
          provider: update.provider,
          title: update.title,
          cwd: update.cwd,
          model: update.model,
          reasoningEffort: update.reasoningEffort,
          origin: update.origin,
          fireAndForget: update.fireAndForget,
          exchanges: [exchange],
        }
        const msgId = nextMsgId()
        session.messages.push({
          id: msgId,
          role: 'assistant',
          content: '',
          agentConversationRef,
          timestamp: Date.now(),
        })
        state.currentByAgent.set(update.agentSessionId, msgId)
        state.byExchange.set(update.exchangeId, msgId)
        return { newCard: true, needsAttention: false }
      }

      case 'attached': {
        // Rebind the provisional card ("pending:<exchangeId>") to the session
        // that just started, so status tracking and Open have a real target.
        const message = this.messageFor(session, state.byExchange.get(update.exchangeId))
        if (!message?.agentConversationRef) return { newCard: false, needsAttention: false }
        const provisionalId = message.agentConversationRef.agentSessionId
        message.agentConversationRef.agentSessionId = update.agentSessionId
        if (update.cwd) message.agentConversationRef.cwd = update.cwd
        if (state.currentByAgent.get(provisionalId) === message.id) {
          state.currentByAgent.delete(provisionalId)
          state.currentByAgent.set(update.agentSessionId, message.id)
        }
        const count = state.countByAgent.get(provisionalId)
        if (count !== undefined) {
          state.countByAgent.delete(provisionalId)
          state.countByAgent.set(update.agentSessionId, count)
        }
        return { newCard: false, needsAttention: false }
      }

      case 'awaiting_input': {
        const exchange = this.exchangeFor(session, state, update.agentSessionId, update.exchangeId)
        if (!exchange) return { newCard: false, needsAttention: false }
        exchange.status = 'awaiting_input'
        exchange.question = { kind: update.kind, questionId: update.questionId, text: update.questionText }
        return { newCard: false, needsAttention: true }
      }

      case 'answered': {
        // The answering tool acts on a session, not on an exchange, so the card
        // is resolved the same way `stopped` resolves it: the agent's latest
        // card, and within it the exchange that is actually parked.
        const message = this.latestAgentConversationMessage(session, update.agentSessionId)
        const exchanges = message?.agentConversationRef?.exchanges
        const parked = exchanges?.findLast((exchange) => exchange.status === 'awaiting_input')
        if (!parked) return { newCard: false, needsAttention: false }
        parked.status = 'answered'
        parked.answer = update.answerText
        return { newCard: false, needsAttention: false }
      }

      case 'settled': {
        let exchange = this.exchangeFor(session, state, update.agentSessionId, update.exchangeId)
        if (!exchange) {
          // Renderer reloaded mid-flight: the dispatch card is gone, but the
          // reply still deserves a home in the current turn.
          exchange = this.orphanExchange(session, state, update)
        }
        exchange.status = SETTLED_STATUS[update.status]
        // A question this side answered stays on the card — question, answer and
        // reply are one exchange. One nobody answered was resolved elsewhere and
        // is no longer part of the story.
        if (!exchange.answer) exchange.question = undefined
        exchange.reply = update.replyText
        exchange.durationMs = update.durationMs
        exchange.toolCallCount = update.toolCallCount
        exchange.settledAt = update.settledAt
        return { newCard: false, needsAttention: true }
      }

      case 'stopped': {
        const message = this.latestAgentConversationMessage(session, update.agentSessionId)
        if (message?.agentConversationRef) {
          message.agentConversationRef.closedByAgent = true
          for (const exchange of message.agentConversationRef.exchanges) {
            if (exchange.status === 'dispatched' || exchange.status === 'awaiting_input' || exchange.status === 'answered') {
              exchange.status = 'interrupted'
            }
          }
        }
        return { newCard: false, needsAttention: false }
      }
    }
  }

  private messageFor(session: Session, msgId: string | undefined) {
    if (!msgId) return undefined
    return session.messages.find((message) => message.id === msgId)
  }

  private latestAgentConversationMessage(session: Session, agentSessionId: string) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].agentConversationRef?.agentSessionId === agentSessionId) return session.messages[i]
    }
    return undefined
  }

  private exchangeFor(
    session: Session,
    state: AgentConversationState,
    agentSessionId: string,
    exchangeId: string,
  ): AgentExchange | undefined {
    const tracked = this.messageFor(session, state.byExchange.get(exchangeId))
    const message = tracked?.agentConversationRef ? tracked : this.latestAgentConversationMessage(session, agentSessionId)
    return message?.agentConversationRef?.exchanges.find((exchange) => exchange.exchangeId === exchangeId)
  }

  private orphanExchange(
    session: Session,
    state: AgentConversationState,
    update: Extract<AgentConversationUpdate, { phase: 'settled' }>,
  ): AgentExchange {
    const index = (state.countByAgent.get(update.agentSessionId) ?? 0) + 1
    state.countByAgent.set(update.agentSessionId, index)
    const exchange: AgentExchange = {
      exchangeId: update.exchangeId,
      index,
      prompt: '',
      dispatchedAt: update.settledAt,
      status: 'dispatched',
    }
    const current = this.messageFor(session, state.currentByAgent.get(update.agentSessionId))
      ?? this.latestAgentConversationMessage(session, update.agentSessionId)
    if (current?.agentConversationRef) {
      current.agentConversationRef.exchanges.push(exchange)
      state.byExchange.set(update.exchangeId, current.id)
      return exchange
    }
    const msgId = nextMsgId()
    session.messages.push({
      id: msgId,
      role: 'assistant',
      content: '',
      agentConversationRef: {
        agentSessionId: update.agentSessionId,
        // Unknown provider on an orphan settle; hydration from the session
        // index corrects it before the card matters.
        provider: 'claude-code',
        title: update.agentSessionId.slice(0, 8),
        cwd: '',
        origin: 'prompted',
        exchanges: [exchange],
      },
      timestamp: Date.now(),
    })
    state.currentByAgent.set(update.agentSessionId, msgId)
    state.byExchange.set(update.exchangeId, msgId)
    return exchange
  }
}
