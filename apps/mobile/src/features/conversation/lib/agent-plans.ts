import type { AgentConversationUpdate } from '@solus/contracts/types'
import type { ExchangeRequest } from '@solus/contracts/session-exchange'

/**
 * Plans written by sessions this conversation sent work to, and whether one
 * waits on this session's decision. The rule is the desktop card's
 * (`agent-conversation-cards.ts`, `lib/agent-conversation.ts`): a plan waits
 * while the target's turn is held open on it. The host is the judge: a
 * decision on a plan already acted on elsewhere is refused, not applied.
 *
 * Live events only. A reloaded conversation does not rebuild these cards
 * from history yet (see apps/mobile/README.md).
 */

type ExchangeStatus = 'dispatched' | 'queued' | 'running' | 'awaiting_input' | 'rate_limited' | 'waiting_for_children' | 'answered' | 'done' | 'failed' | 'interrupted'

interface Exchange {
  messageId: string
  status: ExchangeStatus
  request: ExchangeRequest | null
}

interface Card {
  sessionId: string
  title: string
  exchanges: Exchange[]
}

/** A plan from another session that waits on this one. */
export interface AgentPlanAwaiting {
  /** The session that wrote the plan: the decision's target. */
  targetSessionId: string
  /** The exchange the plan answers; a decision is remembered against it. */
  messageId: string
  sessionTitle: string
  planTitle: string
  content: string
}

export class AgentPlans {
  private readonly cards = new Map<string, Card>()
  /** Decided here; hidden until the host's next update for that exchange. */
  private readonly decided = new Set<string>()

  apply(update: AgentConversationUpdate): void {
    switch (update.phase) {
      case 'dispatched': {
        const card = this.cards.get(update.sessionId) ?? { sessionId: update.sessionId, title: update.title, exchanges: [] }
        card.title = update.title
        card.exchanges.push({ messageId: update.messageId, status: 'dispatched', request: null })
        this.cards.set(update.sessionId, card)
        return
      }
      // The session's id is known from dispatch; nothing on the card changes.
      case 'attached':
        return
      case 'accepted':
        this.patch(update.sessionId, update.messageId, { status: update.state })
        return
      case 'awaiting_input':
        this.patch(update.sessionId, update.messageId, { status: 'awaiting_input', request: update.request })
        return
      case 'answered':
        this.patch(update.sessionId, update.messageId, { status: 'answered', request: null })
        return
      case 'rate_limited':
        this.patch(update.sessionId, update.messageId, { status: 'rate_limited' })
        return
      case 'settled': {
        const status: ExchangeStatus = update.status === 'completed' ? 'done' : update.status
        this.patch(update.sessionId, update.messageId, { status, request: null })
        return
      }
      case 'stopped': {
        const card = this.cards.get(update.sessionId)
        if (!card) return
        for (const exchange of card.exchanges) {
          if (exchange.status !== 'done' && exchange.status !== 'failed' && exchange.status !== 'queued') exchange.status = 'interrupted'
        }
        return
      }
    }
  }

  /** The plans waiting on this session now. */
  awaiting(): AgentPlanAwaiting[] {
    const plans: AgentPlanAwaiting[] = []
    for (const card of this.cards.values()) {
      const last = card.exchanges[card.exchanges.length - 1]
      if (!last || this.decided.has(decisionKey(card.sessionId, last.messageId))) continue
      if (last.status === 'awaiting_input' && last.request?.kind === 'plan') {
        plans.push({ targetSessionId: card.sessionId, messageId: last.messageId, sessionTitle: card.title, planTitle: last.request.plan.title, content: last.request.plan.content })
      }
    }
    return plans
  }

  /** The host accepted a decision; the card leaves until the target answers. */
  markDecided(targetSessionId: string, messageId: string): void {
    this.decided.add(decisionKey(targetSessionId, messageId))
  }

  private patch(sessionId: string, messageId: string, change: Partial<Exchange>): void {
    const card = this.cards.get(sessionId)
    const exchange = card?.exchanges.find((candidate) => candidate.messageId === messageId) ?? card?.exchanges[card.exchanges.length - 1]
    if (!exchange) return
    Object.assign(exchange, change)
    // A new answer from the target replaces a decision made here.
    this.decided.delete(decisionKey(sessionId, exchange.messageId))
  }
}

function decisionKey(targetSessionId: string, messageId: string): string {
  return `${targetSessionId}\u0000${messageId}`
}
