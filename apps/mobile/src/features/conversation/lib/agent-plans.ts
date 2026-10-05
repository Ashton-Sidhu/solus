import type { AgentConversationUpdate } from '@solus/contracts/types'
import type { ExchangeRequest, SessionOutput } from '@solus/contracts/session-exchange'

/**
 * Plans written by sessions this conversation sent work to, and whether one
 * waits on this session's decision. The rules are the desktop card's
 * (`agent-conversation-cards.ts`, `lib/agent-conversation.ts`): a plan waits
 * while the target's turn is held open on it, or when the target's last turn
 * finished with a plan the sender has not acted on. The host is the judge: a
 * decision on a plan already acted on elsewhere is refused, not applied.
 *
 * Live events only. A reloaded conversation does not rebuild these cards
 * from history yet (see apps/mobile/README.md).
 */

type ExchangeStatus = 'dispatched' | 'queued' | 'running' | 'awaiting_input' | 'rate_limited' | 'answered' | 'done' | 'failed' | 'interrupted'

interface Exchange {
  messageId: string
  status: ExchangeStatus
  request: ExchangeRequest | null
  outputs: SessionOutput[]
}

interface Card {
  agentSessionId: string
  title: string
  closedByAgent: boolean
  exchanges: Exchange[]
}

/** A plan from another session that waits on this one. */
export interface AgentPlanAwaiting {
  /** The provider thread of the session that wrote the plan: the decision's target. */
  targetSessionId: string
  /** The exchange the plan answers; a decision is remembered against it. */
  messageId: string
  sessionTitle: string
  planTitle: string
  /** The plan's text when the turn is held open on it; a finished turn's plan is named only. */
  content: string | null
}

export class AgentPlans {
  private readonly cards = new Map<string, Card>()
  /** Decided here; hidden until the host's next update for that exchange. */
  private readonly decided = new Set<string>()

  apply(update: AgentConversationUpdate): void {
    switch (update.phase) {
      case 'dispatched': {
        const card = this.cards.get(update.agentSessionId) ?? { agentSessionId: update.agentSessionId, title: update.title, closedByAgent: false, exchanges: [] }
        card.closedByAgent = false
        card.title = update.title
        card.exchanges.push({ messageId: update.messageId, status: 'dispatched', request: null, outputs: [] })
        this.cards.set(update.agentSessionId, card)
        return
      }
      case 'attached': {
        // A card opened before its session existed is keyed `pending:<messageId>`.
        const pending = this.cards.get(`pending:${update.messageId}`)
        if (!pending) return
        this.cards.delete(pending.agentSessionId)
        pending.agentSessionId = update.agentSessionId
        this.cards.set(update.agentSessionId, pending)
        return
      }
      case 'accepted':
        this.patch(update.agentSessionId, update.messageId, { status: update.state })
        return
      case 'awaiting_input':
        this.patch(update.agentSessionId, update.messageId, { status: 'awaiting_input', request: update.request })
        return
      case 'answered':
        this.patch(update.agentSessionId, update.messageId, { status: 'answered', request: null })
        return
      case 'rate_limited':
        this.patch(update.agentSessionId, update.messageId, { status: 'rate_limited' })
        return
      case 'settled': {
        const status: ExchangeStatus = update.status === 'completed' ? 'done' : update.status
        this.patch(update.agentSessionId, update.messageId, { status, request: null, outputs: update.outputs ?? [] })
        return
      }
      case 'stopped': {
        const card = this.cards.get(update.agentSessionId)
        if (!card) return
        for (const exchange of card.exchanges) {
          if (exchange.status !== 'done' && exchange.status !== 'failed' && exchange.status !== 'queued') exchange.status = 'interrupted'
        }
        card.closedByAgent = !card.exchanges.some((exchange) => exchange.status === 'queued')
        return
      }
    }
  }

  /** The plans waiting on this session now. */
  awaiting(): AgentPlanAwaiting[] {
    const plans: AgentPlanAwaiting[] = []
    for (const card of this.cards.values()) {
      const last = card.exchanges[card.exchanges.length - 1]
      if (!last || this.decided.has(decisionKey(card.agentSessionId, last.messageId))) continue
      if (last.status === 'awaiting_input' && last.request?.kind === 'plan') {
        plans.push({ targetSessionId: card.agentSessionId, messageId: last.messageId, sessionTitle: card.title, planTitle: last.request.plan.title, content: last.request.plan.content })
        continue
      }
      if (card.closedByAgent || last.status !== 'done') continue
      const plan = last.outputs.findLast((output) => output.kind === 'plan')
      if (plan?.kind === 'plan') plans.push({ targetSessionId: card.agentSessionId, messageId: last.messageId, sessionTitle: card.title, planTitle: plan.title, content: null })
    }
    return plans
  }

  /** The host accepted a decision; the card leaves until the target answers. */
  markDecided(targetSessionId: string, messageId: string): void {
    this.decided.add(decisionKey(targetSessionId, messageId))
  }

  private patch(agentSessionId: string, messageId: string, change: Partial<Exchange>): void {
    const card = this.cards.get(agentSessionId)
    const exchange = card?.exchanges.find((candidate) => candidate.messageId === messageId) ?? card?.exchanges[card.exchanges.length - 1]
    if (!exchange) return
    Object.assign(exchange, change)
    // A new answer from the target replaces a decision made here.
    this.decided.delete(decisionKey(agentSessionId, exchange.messageId))
  }
}

function decisionKey(targetSessionId: string, messageId: string): string {
  return `${targetSessionId}\u0000${messageId}`
}
