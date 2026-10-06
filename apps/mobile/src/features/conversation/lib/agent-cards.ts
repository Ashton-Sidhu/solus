import type { AgentConversationResultProjection } from '@solus/contracts/session-history'
import { parseOrchestrationItems, promptTitle, type ExchangeOutcome, type SessionReport } from '@solus/contracts/session-exchange'
import type { AgentConversationUpdate, AgentExchangeStatus, AgentId, ExchangeProgress } from '@solus/contracts/types'

/**
 * Agent cards for the native transcript: one card per other Solus session per
 * turn, holding this conversation's exchanges with it. The rules follow the
 * desktop card index (`workspace-ui/.../agent-conversation-cards.ts`): live,
 * the host's `agent_conversation_update`s drive a card; on reload, an
 * orchestration tool row opens an exchange at the state the host stamped on it
 * (`agentConversationResult`), and a `[session report]` turn settles it.
 */

export interface AgentExchangeState {
  readonly messageId: string
  readonly status: AgentExchangeStatus
}

export interface AgentItem {
  readonly kind: 'agent'
  readonly id: string
  /** The other session's provider thread; a pending id until the host attaches it. */
  readonly agentSessionId: string
  readonly provider: AgentId | null
  readonly title: string
  readonly model: string | null
  /** The newest message this conversation sent it. */
  readonly prompt: string
  /** Its newest reply, once an exchange settled. */
  readonly reply: string | null
  readonly exchanges: readonly AgentExchangeState[]
  readonly startedAt: number
  readonly settledAt: number | null
  readonly durationMs: number | null
}

/** The acting orchestration tools, for Claude (`mcp__solus__*`) and Codex (bare
 *  names). read/list/search only observe; they open no exchange. */
export function isAgentConversationTool(name: string | undefined): boolean {
  if (!name) return false
  return name.endsWith('start_session') || name.endsWith('send_session') || name.endsWith('stop_session')
}

const OPEN_STATUSES: ReadonlySet<AgentExchangeStatus> = new Set([
  'dispatched', 'queued', 'running', 'awaiting_input', 'rate_limited', 'waiting_for_children', 'answered',
])

export function isOpenExchangeStatus(status: AgentExchangeStatus): boolean {
  return OPEN_STATUSES.has(status)
}

const SETTLED_STATUS = {
  completed: 'done',
  interrupted: 'interrupted',
  failed: 'failed',
} satisfies Record<ExchangeOutcome, AgentExchangeStatus>

/** A card reads as its newest open exchange, else its newest exchange. */
export function agentCardStatus(item: Pick<AgentItem, 'exchanges'>): AgentExchangeStatus {
  for (let index = item.exchanges.length - 1; index >= 0; index -= 1) {
    const exchange = item.exchanges[index]!
    if (OPEN_STATUSES.has(exchange.status)) return exchange.status
  }
  return item.exchanges.at(-1)?.status ?? 'dispatched'
}

/** Where the host said a rebuilt exchange stood when it read the page. One it
 *  no longer carries was lost to a restart, unless a later report settles it. */
function progressStatus(progress: ExchangeProgress | undefined): AgentExchangeStatus {
  if (!progress) return 'lost'
  if (progress.state === 'settled') return SETTLED_STATUS[progress.outcome ?? 'completed']
  if (progress.state === 'reply_queued') return 'running'
  return progress.state
}

interface Opening {
  messageId: string | undefined
  prompt: string
  provider?: AgentId
  title?: string
  model?: string
  timestamp: number
}

/** Where the model keeps cards: `add` puts a new card in the feed at the current position. */
export interface AgentCardStore {
  get(id: string): AgentItem | undefined
  add(item: AgentItem): void
  update(item: AgentItem): void
}

const sessionToolInput = (input: string | undefined): {
  session_id?: string; prompt?: string; message?: string; model_id?: string; agent_provider?: AgentId
} => {
  try {
    const parsed: unknown = JSON.parse(input || '{}')
    if (!parsed || typeof parsed !== 'object') return {}
    const read = (key: string) => {
      const value = (parsed as { [key: string]: unknown })[key]
      return typeof value === 'string' ? value : undefined
    }
    const provider = read('agent_provider')
    return {
      session_id: read('session_id'),
      prompt: read('prompt'),
      message: read('message'),
      model_id: read('model_id'),
      agent_provider: provider === 'claude-code' || provider === 'codex' || provider === 'opencode' ? provider : undefined,
    }
  } catch {
    return {}
  }
}

export class AgentCards {
  /** agentSessionId → this turn's card. Cleared by every genuine user turn. */
  private readonly currentByAgent = new Map<string, string>()
  /** Exchange id → its card, so a late result lands in the card that sent it. */
  private readonly cardByExchange = new Map<string, string>()
  private nextCard = 0
  private nextExchange = 0

  constructor(private readonly store: AgentCardStore) {}

  /** A genuine user turn: the next message per agent starts a fresh card. */
  closeTurn(): void {
    this.currentByAgent.clear()
  }

  apply(update: AgentConversationUpdate): void {
    switch (update.phase) {
      case 'dispatched':
        this.open(update.agentSessionId, {
          messageId: update.messageId, prompt: update.prompt, provider: update.provider,
          title: update.title, model: update.model, timestamp: update.dispatchedAt,
        })
        return
      case 'attached': {
        const card = this.cardFor(update.messageId)
        if (!card || card.agentSessionId === update.agentSessionId) return
        if (this.currentByAgent.get(card.agentSessionId) === card.id) {
          this.currentByAgent.delete(card.agentSessionId)
          this.currentByAgent.set(update.agentSessionId, card.id)
        }
        this.store.update({ ...card, agentSessionId: update.agentSessionId })
        return
      }
      case 'accepted':
        this.setStatus(update.messageId, update.state, true)
        return
      case 'awaiting_input':
        this.setStatus(update.messageId, 'awaiting_input', false)
        return
      case 'rate_limited':
        this.setStatus(update.messageId, 'rate_limited', true)
        return
      case 'answered':
        this.setStatus(update.messageId, 'answered', false)
        return
      case 'settled':
        this.settle(update.agentSessionId, {
          messageId: update.messageId, status: update.status, reply: update.replyText,
          durationMs: update.durationMs, settledAt: update.settledAt,
        })
        return
      case 'stopped':
        this.stop(update.agentSessionId)
        return
    }
  }

  /** One acting orchestration tool row from history. */
  applyToolRow(toolName: string, toolInput: string | undefined, result: AgentConversationResultProjection | undefined, timestamp: number): void {
    const input = sessionToolInput(toolInput)
    if (toolName.endsWith('stop_session')) {
      if (input.session_id) this.stop(input.session_id)
      return
    }
    const agentSessionId = toolName.endsWith('start_session') ? result?.agentSessionId : input.session_id
    if (!agentSessionId) return
    const card = this.open(agentSessionId, {
      messageId: result?.messageId,
      prompt: (toolName.endsWith('start_session') ? input.prompt : input.message) ?? '',
      provider: result?.provider ?? input.agent_provider,
      model: input.model_id,
      timestamp,
    })
    const messageId = card.exchanges.at(-1)!.messageId
    this.setExchange(card, messageId, progressStatus(result?.progress))
    // A call that waited for its exchange carries the report no later turn does.
    if (result?.report) this.settleReport(result.report, timestamp)
  }

  /** True when the user row came from the orchestrator (reports and notices)
   *  and was consumed: it is not the person's prompt. */
  applyUserRow(text: string, timestamp: number): boolean {
    const items = parseOrchestrationItems(text)
    if (!items) return false
    for (const item of items) if (item.type === 'report') this.settleReport(item.report, timestamp)
    return true
  }

  private settleReport(report: SessionReport, timestamp: number): void {
    const settled = { status: report.status, reply: report.reply, durationMs: report.durationMs, settledAt: timestamp }
    this.settle(report.agentSessionId, { messageId: report.messageId, provider: report.provider, ...settled })
    for (const messageId of report.alsoMessageIds ?? []) {
      const card = this.cardFor(messageId)
      if (card) this.setExchange(card, messageId, SETTLED_STATUS[report.status])
    }
  }

  private open(agentSessionId: string, opening: Opening): AgentItem {
    const messageId = opening.messageId ?? `rebuilt:${agentSessionId}:${(this.nextExchange += 1)}`
    const exchange: AgentExchangeState = { messageId, status: 'dispatched' }
    const currentId = this.currentByAgent.get(agentSessionId)
    const current = currentId ? this.store.get(currentId) : undefined
    let card: AgentItem
    if (current) {
      card = {
        ...current,
        prompt: opening.prompt || current.prompt,
        title: opening.title || current.title,
        model: opening.model ?? current.model,
        provider: opening.provider ?? current.provider,
        exchanges: [...current.exchanges, exchange],
        settledAt: null,
        durationMs: null,
      }
      this.store.update(card)
    } else {
      this.nextCard += 1
      card = {
        kind: 'agent',
        id: `agent:${this.nextCard}`,
        agentSessionId,
        provider: opening.provider ?? null,
        title: opening.title || (opening.prompt ? promptTitle(opening.prompt) : 'Agent session'),
        model: opening.model ?? null,
        prompt: opening.prompt,
        reply: null,
        exchanges: [exchange],
        startedAt: opening.timestamp,
        settledAt: null,
        durationMs: null,
      }
      this.store.add(card)
      this.currentByAgent.set(agentSessionId, card.id)
    }
    this.cardByExchange.set(messageId, card.id)
    return card
  }

  private settle(agentSessionId: string, settled: {
    messageId?: string; status: ExchangeOutcome; reply: string; durationMs?: number; settledAt: number; provider?: AgentId
  }): void {
    // The card that sent it, else the agent's card this turn; a reply whose
    // dispatch fell outside what is loaded still gets a card.
    const card = (settled.messageId ? this.cardFor(settled.messageId) : undefined)
      ?? this.latestOpenCard(agentSessionId)
      ?? this.open(agentSessionId, { messageId: settled.messageId, prompt: '', provider: settled.provider, timestamp: settled.settledAt })
    const messageId = settled.messageId && card.exchanges.some((exchange) => exchange.messageId === settled.messageId)
      ? settled.messageId
      : (card.exchanges.find((exchange) => OPEN_STATUSES.has(exchange.status) || exchange.status === 'lost') ?? card.exchanges.at(-1)!).messageId
    const latest = this.store.get(card.id) ?? card
    this.store.update({
      ...latest,
      provider: settled.provider ?? latest.provider,
      reply: settled.reply.trim() || latest.reply,
      exchanges: latest.exchanges.map((exchange) => exchange.messageId === messageId ? { messageId, status: SETTLED_STATUS[settled.status] } : exchange),
      settledAt: settled.settledAt,
      durationMs: settled.durationMs ?? null,
    })
  }

  /** Stop keeps the queue, so a message still waiting will run. */
  private stop(agentSessionId: string): void {
    const card = this.latestCard(agentSessionId)
    if (!card) return
    const exchanges = card.exchanges.map((exchange) =>
      OPEN_STATUSES.has(exchange.status) && exchange.status !== 'queued' ? { ...exchange, status: 'interrupted' as const } : exchange)
    if (exchanges.some((exchange, index) => exchange !== card.exchanges[index])) this.store.update({ ...card, exchanges })
  }

  /** `onlyOpen`: a late progress update never reopens a settled exchange. */
  private setStatus(messageId: string, status: AgentExchangeStatus, onlyOpen: boolean): void {
    const card = this.cardFor(messageId)
    if (!card) return
    const exchange = card.exchanges.find((candidate) => candidate.messageId === messageId)
    if (!exchange || (onlyOpen && !OPEN_STATUSES.has(exchange.status))) return
    this.setExchange(card, messageId, status)
  }

  private setExchange(card: AgentItem, messageId: string, status: AgentExchangeStatus): void {
    const latest = this.store.get(card.id) ?? card
    const exchanges = latest.exchanges.map((exchange) => exchange.messageId === messageId ? { messageId, status } : exchange)
    this.store.update({ ...latest, exchanges })
  }

  private cardFor(messageId: string): AgentItem | undefined {
    const id = this.cardByExchange.get(messageId)
    return id ? this.store.get(id) : undefined
  }

  private latestOpenCard(agentSessionId: string): AgentItem | undefined {
    const card = this.latestCard(agentSessionId)
    return card?.exchanges.some((exchange) => OPEN_STATUSES.has(exchange.status) || exchange.status === 'lost') ? card : undefined
  }

  private latestCard(agentSessionId: string): AgentItem | undefined {
    const currentId = this.currentByAgent.get(agentSessionId)
    if (currentId) return this.store.get(currentId)
    let latest: AgentItem | undefined
    for (const id of this.cardByExchange.values()) {
      const card = this.store.get(id)
      if (card?.agentSessionId === agentSessionId && (!latest || card.startedAt >= latest.startedAt)) latest = card
    }
    return latest
  }
}
