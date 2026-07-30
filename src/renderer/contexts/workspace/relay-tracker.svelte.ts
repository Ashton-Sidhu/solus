import type { RelayExchange, RelayRef, Session, SessionRelayUpdate } from '../../../shared/types'
import { nextMsgId } from './session.utils'

interface RelayState {
  /** peerSessionId → message id of that peer's relay card in the current turn.
   *  Cleared on every genuine user message, so each turn gets one card per peer. */
  currentByPeer: Map<string, string>
  /** exchangeId → message id, so settles land in the card that dispatched them —
   *  including cards from earlier turns. */
  byExchange: Map<string, string>
  /** peerSessionId → cumulative exchange count; indices never renumber. */
  countByPeer: Map<string, number>
}

const SETTLED_STATUS: Record<'completed' | 'interrupted' | 'failed', RelayExchange['status']> = {
  completed: 'done',
  interrupted: 'interrupted',
  failed: 'failed',
}

/** Maintains one relay card per peer session per turn, mutating messages in
 *  place as `session_relay` events land (same contract as WorkStreamTracker:
 *  keep the pushed message id, patch its ref). */
export class RelayTracker {
  private states = new WeakMap<Session, RelayState>()

  private state(session: Session): RelayState {
    let state = this.states.get(session)
    if (!state) {
      state = { currentByPeer: new Map(), byExchange: new Map(), countByPeer: new Map() }
      this.states.set(session, state)
    }
    return state
  }

  /** A genuine user message closes the turn: the next dispatch per peer starts
   *  a fresh card. Exchange correlation (`byExchange`) survives — late settles
   *  still land in the older turn's card. */
  closeTurn(session: Session): void {
    this.states.get(session)?.currentByPeer.clear()
  }

  /** Returns true when the update was consumed (it always is — relay events
   *  never fall through to other reducer arms). */
  apply(session: Session, update: SessionRelayUpdate): { newCard: boolean; needsAttention: boolean } {
    const state = this.state(session)
    switch (update.phase) {
      case 'dispatched': {
        const index = (state.countByPeer.get(update.peerSessionId) ?? 0) + 1
        state.countByPeer.set(update.peerSessionId, index)
        const exchange: RelayExchange = {
          exchangeId: update.exchangeId,
          index,
          prompt: update.prompt,
          delivery: update.delivery,
          dispatchedAt: update.dispatchedAt,
          status: 'dispatched',
        }
        const existing = this.messageFor(session, state.currentByPeer.get(update.peerSessionId))
        if (existing?.relayRef) {
          existing.relayRef.exchanges.push(exchange)
          // Later dispatches carry fresher metadata (the CLI slug may have
          // landed since the first prompt) — latest wins.
          existing.relayRef.title = update.title || existing.relayRef.title
          if (update.model) existing.relayRef.model = update.model
          if (update.reasoningEffort) existing.relayRef.reasoningEffort = update.reasoningEffort
          state.byExchange.set(update.exchangeId, existing.id)
          return { newCard: false, needsAttention: false }
        }
        const relayRef: RelayRef = {
          peerSessionId: update.peerSessionId,
          provider: update.provider,
          title: update.title,
          cwd: update.cwd,
          model: update.model,
          reasoningEffort: update.reasoningEffort,
          origin: update.origin,
          exchanges: [exchange],
        }
        const msgId = nextMsgId()
        session.messages.push({
          id: msgId,
          role: 'assistant',
          content: '',
          relayRef,
          timestamp: Date.now(),
        })
        state.currentByPeer.set(update.peerSessionId, msgId)
        state.byExchange.set(update.exchangeId, msgId)
        return { newCard: true, needsAttention: false }
      }

      case 'awaiting_input': {
        const exchange = this.exchangeFor(session, state, update.peerSessionId, update.exchangeId)
        if (!exchange) return { newCard: false, needsAttention: false }
        exchange.status = 'awaiting_input'
        exchange.question = { kind: update.kind, questionId: update.questionId, text: update.questionText }
        return { newCard: false, needsAttention: true }
      }

      case 'settled': {
        let exchange = this.exchangeFor(session, state, update.peerSessionId, update.exchangeId)
        if (!exchange) {
          // Renderer reloaded mid-flight: the dispatch card is gone, but the
          // reply still deserves a home in the current turn.
          exchange = this.orphanExchange(session, state, update)
        }
        exchange.status = SETTLED_STATUS[update.status]
        exchange.question = undefined
        exchange.reply = update.replyText
        exchange.durationMs = update.durationMs
        exchange.toolCallCount = update.toolCallCount
        exchange.settledAt = update.settledAt
        return { newCard: false, needsAttention: true }
      }

      case 'stopped': {
        const message = this.latestRelayMessage(session, update.peerSessionId)
        if (message?.relayRef) {
          message.relayRef.closedByPeer = true
          for (const exchange of message.relayRef.exchanges) {
            if (exchange.status === 'dispatched' || exchange.status === 'awaiting_input') {
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

  private latestRelayMessage(session: Session, peerSessionId: string) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].relayRef?.peerSessionId === peerSessionId) return session.messages[i]
    }
    return undefined
  }

  private exchangeFor(
    session: Session,
    state: RelayState,
    peerSessionId: string,
    exchangeId: string,
  ): RelayExchange | undefined {
    const tracked = this.messageFor(session, state.byExchange.get(exchangeId))
    const message = tracked?.relayRef ? tracked : this.latestRelayMessage(session, peerSessionId)
    return message?.relayRef?.exchanges.find((exchange) => exchange.exchangeId === exchangeId)
  }

  private orphanExchange(
    session: Session,
    state: RelayState,
    update: Extract<SessionRelayUpdate, { phase: 'settled' }>,
  ): RelayExchange {
    const index = (state.countByPeer.get(update.peerSessionId) ?? 0) + 1
    state.countByPeer.set(update.peerSessionId, index)
    const exchange: RelayExchange = {
      exchangeId: update.exchangeId,
      index,
      prompt: '',
      dispatchedAt: update.settledAt,
      status: 'dispatched',
    }
    const current = this.messageFor(session, state.currentByPeer.get(update.peerSessionId))
      ?? this.latestRelayMessage(session, update.peerSessionId)
    if (current?.relayRef) {
      current.relayRef.exchanges.push(exchange)
      state.byExchange.set(update.exchangeId, current.id)
      return exchange
    }
    const msgId = nextMsgId()
    session.messages.push({
      id: msgId,
      role: 'assistant',
      content: '',
      relayRef: {
        peerSessionId: update.peerSessionId,
        // Unknown provider on an orphan settle; hydration from the session
        // index corrects it before the card matters.
        provider: 'claude-code',
        title: update.peerSessionId.slice(0, 8),
        cwd: '',
        origin: 'prompted',
        exchanges: [exchange],
      },
      timestamp: Date.now(),
    })
    state.currentByPeer.set(update.peerSessionId, msgId)
    state.byExchange.set(update.exchangeId, msgId)
    return exchange
  }
}
