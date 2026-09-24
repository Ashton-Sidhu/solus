import type { AgentConversationRef, AgentConversationUpdate, AgentExchange, AgentExchangeStatus, AgentId, Message, Session } from '@solus/contracts/types'
import type { AgentConversationResultProjection } from '@solus/contracts/session-history'
import { parseOrchestrationItems, promptTitle, type ExchangeOutcome, type SessionOutput, type SessionReport } from '@solus/contracts/session-exchange'
import { z } from 'zod'
import { isAgentNotice, nextMsgId } from './session.utils'

/**
 * The one place a conversation's agent cards are built: one card per other
 * session per turn, each holding the exchanges this conversation had with it.
 *
 * Live, the host's orchestrator sends `agent_conversation_update`s. On reload,
 * the same cards come back from the transcript: an orchestration tool row opens
 * an exchange, and a `[session report]` turn — read with the codec the host
 * wrote it with — settles it. A `[session notice]` turn is consumed and never
 * shown: the host says what is still waiting. Both paths go through
 * `CardIndex`, so a card rebuilt from history is the card that was shown live.
 */

/** The acting orchestration tools, for both Claude (`mcp__solus__*`) and Codex
 *  (bare names). read/list/search observe; they open no exchange. */
export function isAgentConversationTool(name: string | undefined): boolean {
  if (!name) return false
  return name.endsWith('start_session') || name.endsWith('send_session') || name.endsWith('stop_session')
}

const SETTLED_STATUS = {
  completed: 'done',
  interrupted: 'interrupted',
  failed: 'failed',
} satisfies Record<ExchangeOutcome, AgentExchangeStatus>

const OPEN_STATUSES: ReadonlySet<AgentExchangeStatus> = new Set(['dispatched', 'queued', 'running', 'awaiting_input', 'rate_limited', 'answered'])

interface ExchangeOpening {
  /** The id the host gave the exchange, when known. */
  messageId?: string
  prompt: string
  origin: AgentConversationRef['origin']
  provider?: AgentId
  title?: string
  fireAndForget?: boolean
  delivery?: 'queue' | 'steer'
  model?: string
  reasoningEffort?: string
  cwd: string
  timestamp: number
  restored?: boolean
}

interface OpenedExchange {
  exchange: AgentExchange
  newCard: boolean
}

/** One transcript's cards and the lookups that keep each update in its card. */
class CardIndex {
  /** agentSessionId → this turn's card for it. Cleared by every genuine user
   *  turn, so each turn gets one card per agent. */
  private currentByAgent = new Map<string, Message>()
  /** Exchange id → its card, so a late result lands in the card that sent it —
   *  including a card from an earlier turn. */
  private cardByExchange = new Map<string, Message>()
  /** agentSessionId → its cards' exchange count; indices never renumber. */
  private countByAgent = new Map<string, number>()

  constructor(private readonly messages: Message[]) {
    for (const message of messages) {
      if (message.role === 'user' && !isAgentNotice(message.content)) this.currentByAgent.clear()
      const ref = message.agentConversationRef
      if (!ref) continue
      this.currentByAgent.set(ref.agentSessionId, message)
      for (const exchange of ref.exchanges) {
        this.cardByExchange.set(exchange.messageId, message)
        this.countByAgent.set(ref.agentSessionId, Math.max(this.countByAgent.get(ref.agentSessionId) ?? 0, exchange.index))
      }
    }
  }

  closeTurn(): void {
    this.currentByAgent.clear()
  }

  /** The exchange opened, and whether it needed a new card. */
  open(agentSessionId: string, opening: ExchangeOpening): OpenedExchange {
    const index = (this.countByAgent.get(agentSessionId) ?? 0) + 1
    this.countByAgent.set(agentSessionId, index)
    const exchange: AgentExchange = {
      messageId: opening.messageId ?? `rebuilt:${agentSessionId}:${index}`,
      index,
      prompt: opening.prompt,
      delivery: opening.delivery,
      dispatchedAt: opening.timestamp,
      status: 'dispatched',
    }
    if (opening.restored) exchange.restored = true
    const current = this.currentByAgent.get(agentSessionId)
    if (current?.agentConversationRef) {
      const ref = current.agentConversationRef
      ref.exchanges.push(exchange)
      // A fresh message reopens an agent that was stopped earlier this turn,
      // and means this side is talking to it after all.
      ref.closedByAgent = undefined
      ref.fireAndForget = undefined
      if (opening.title) ref.title = opening.title
      if (opening.model) ref.model = opening.model
      if (opening.reasoningEffort) ref.reasoningEffort = opening.reasoningEffort
      if (opening.provider) ref.provider = opening.provider
      this.cardByExchange.set(exchange.messageId, current)
      return { exchange, newCard: false }
    }
    const message: Message = {
      id: nextMsgId(),
      role: 'assistant',
      content: '',
      agentConversationRef: {
        agentSessionId,
        // Unknown until the tool row or the host names it; the status store's
        // index hydration corrects it before the card is read.
        provider: opening.provider ?? 'claude-code',
        title: opening.title || (opening.prompt ? promptTitle(opening.prompt) : agentSessionId.slice(0, 8)),
        cwd: opening.cwd,
        model: opening.model,
        reasoningEffort: opening.reasoningEffort,
        origin: opening.origin,
        fireAndForget: opening.fireAndForget,
        exchanges: [exchange],
      },
      timestamp: opening.timestamp,
    }
    this.messages.push(message)
    this.currentByAgent.set(agentSessionId, message)
    this.cardByExchange.set(exchange.messageId, message)
    return { exchange, newCard: true }
  }

  exchange(messageId: string | undefined, agentSessionId: string): AgentExchange | undefined {
    const tracked = messageId ? this.cardByExchange.get(messageId) : undefined
    const card = tracked?.agentConversationRef ? tracked : this.latestCard(agentSessionId)
    const exchanges = card?.agentConversationRef?.exchanges ?? []
    // A report that names no exchange is older than this format: the oldest open one is its answer.
    return messageId
      ? exchanges.find((exchange) => exchange.messageId === messageId)
      : exchanges.find((exchange) => OPEN_STATUSES.has(exchange.status))
  }

  card(messageId: string): Message | undefined {
    return this.cardByExchange.get(messageId)
  }

  latestCard(agentSessionId: string): Message | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]!.agentConversationRef?.agentSessionId === agentSessionId) return this.messages[i]
    }
    return undefined
  }

  /** A pending card's session started: rebind it to the real id. */
  rebind(message: Message, agentSessionId: string): void {
    const ref = message.agentConversationRef
    if (!ref) return
    const pendingId = ref.agentSessionId
    ref.agentSessionId = agentSessionId
    if (this.currentByAgent.get(pendingId) === message) {
      this.currentByAgent.delete(pendingId)
      this.currentByAgent.set(agentSessionId, message)
    }
    const count = this.countByAgent.get(pendingId)
    if (count !== undefined) {
      this.countByAgent.delete(pendingId)
      this.countByAgent.set(agentSessionId, count)
    }
  }
}

/** What a person answered, one line each, as the report's outputs say it. */
function answersFrom(outputs: readonly SessionOutput[]): string[] {
  const answers: string[] = []
  for (const output of outputs) {
    if (output.kind === 'question' && output.answer !== undefined) answers.push(`${output.question} → ${output.answer}`)
    if (output.kind === 'permission') answers.push(`${output.allowed ? 'Allowed' : 'Denied'} ${output.tool}`)
  }
  return answers
}

function settle(exchange: AgentExchange, report: Pick<SessionReport, 'status' | 'reply' | 'outputs' | 'taskId' | 'durationMs'>): void {
  exchange.status = SETTLED_STATUS[report.status]
  // A request a person answered stays with the exchange — question, answer and
  // reply are one story. Live, the answers arrived one by one; rebuilt, they
  // come from the report. One nobody answered here was resolved elsewhere.
  if (!exchange.answers?.length) {
    const answers = answersFrom(report.outputs)
    if (answers.length) exchange.answers = answers
  }
  if (!exchange.answers?.length) exchange.request = undefined
  exchange.reply = report.reply
  if (report.outputs.length) exchange.outputs = report.outputs
  if (report.taskId) exchange.taskId = report.taskId
  if (report.durationMs !== undefined) exchange.durationMs = report.durationMs
}

interface CardUpdateResult {
  newCard: boolean
  needsAttention: boolean
}

/** Live cards, one index per mounted transcript. */
export class AgentConversationCards {
  // Keyed by the messages array so clearTab's replacement drops its index.
  // Hydration expands the same reactive array in place; it calls `rebuild`.
  private indexes = new WeakMap<Message[], CardIndex>()

  private index(session: Session): CardIndex {
    let index = this.indexes.get(session.messages)
    if (!index) {
      index = new CardIndex(session.messages)
      this.indexes.set(session.messages, index)
    }
    return index
  }

  /** Re-index a transcript after hydration replaced its contents in place. */
  rebuild(session: Session): void {
    this.indexes.set(session.messages, new CardIndex(session.messages))
  }

  /** A genuine user message: the next message per agent starts a fresh card. */
  closeTurn(session: Session): void {
    this.indexes.get(session.messages)?.closeTurn()
  }

  apply(session: Session, update: AgentConversationUpdate): CardUpdateResult {
    const index = this.index(session)
    switch (update.phase) {
      case 'dispatched': {
        const { newCard } = index.open(update.agentSessionId, {
          messageId: update.messageId,
          prompt: update.prompt,
          origin: update.origin,
          provider: update.provider,
          title: update.title,
          fireAndForget: update.fireAndForget,
          delivery: update.delivery,
          model: update.model,
          reasoningEffort: update.reasoningEffort,
          cwd: update.cwd,
          timestamp: update.dispatchedAt,
        })
        return { newCard, needsAttention: false }
      }
      case 'attached': {
        const card = index.card(update.messageId)
        if (card?.agentConversationRef) {
          index.rebind(card, update.agentSessionId)
          if (update.cwd) card.agentConversationRef.cwd = update.cwd
        }
        return { newCard: false, needsAttention: false }
      }
      case 'accepted': {
        const exchange = index.exchange(update.messageId, update.agentSessionId)
        if (exchange && OPEN_STATUSES.has(exchange.status)) {
          exchange.status = update.state
          exchange.rateLimitedUntil = undefined
        }
        return { newCard: false, needsAttention: false }
      }
      case 'awaiting_input': {
        const exchange = index.exchange(update.messageId, update.agentSessionId)
        if (!exchange) return { newCard: false, needsAttention: false }
        exchange.status = 'awaiting_input'
        exchange.request = update.request
        return { newCard: false, needsAttention: true }
      }
      case 'rate_limited': {
        const exchange = index.exchange(update.messageId, update.agentSessionId)
        if (!exchange || !OPEN_STATUSES.has(exchange.status)) return { newCard: false, needsAttention: false }
        exchange.status = 'rate_limited'
        exchange.rateLimitedUntil = update.resetsAt
        return { newCard: false, needsAttention: true }
      }
      case 'answered': {
        const exchange = index.exchange(update.messageId, update.agentSessionId)
        if (!exchange) return { newCard: false, needsAttention: false }
        exchange.status = 'answered'
        ;(exchange.answers ??= []).push(update.answerText)
        return { newCard: false, needsAttention: false }
      }
      case 'settled':
        this.settled(index, update)
        return { newCard: false, needsAttention: true }
      case 'stopped':
        this.stopped(index, update.agentSessionId)
        return { newCard: false, needsAttention: false }
    }
  }

  private settled(index: CardIndex, update: Extract<AgentConversationUpdate, { phase: 'settled' }>): void {
    // A reload mid-flight lost the card that sent it; the reply still deserves
    // a home in the current turn.
    const exchange = index.exchange(update.messageId, update.agentSessionId)
      ?? index.open(update.agentSessionId, { messageId: update.messageId, prompt: '', origin: 'prompted', cwd: '', timestamp: update.settledAt }).exchange
    settle(exchange, { status: update.status, reply: update.replyText, outputs: update.outputs ?? [], taskId: update.taskId, durationMs: update.durationMs })
    exchange.toolCallCount = update.toolCallCount
    exchange.settledAt = update.settledAt
  }

  private stopped(index: CardIndex, agentSessionId: string): void {
    const ref = index.latestCard(agentSessionId)?.agentConversationRef
    if (!ref) return
    ref.closedByAgent = true
    for (const exchange of ref.exchanges) {
      if (OPEN_STATUSES.has(exchange.status)) exchange.status = 'interrupted'
    }
  }
}

const sessionToolInputSchema = z.object({
  session_id: z.string().optional(),
  prompt: z.string().optional(),
  message: z.string().optional(),
  // Fields degrade alone so an unexpected value from a newer host drops that
  // field, not the whole parsed input.
  report: z.boolean().optional().catch(undefined),
  model_id: z.string().optional(),
  reasoning_effort: z.string().optional(),
  cwd: z.string().optional(),
  agent_provider: z.enum(['claude-code', 'codex', 'opencode']).optional().catch(undefined),
  delivery: z.enum(['queue', 'steer']).optional().catch(undefined),
})

/** Cards rebuilt from one persisted transcript as it is read, row by row. */
export class TranscriptAgentConversations {
  private readonly index: CardIndex

  constructor(messages: Message[]) {
    this.index = new CardIndex(messages)
  }

  /** A genuine user turn: the next message per agent starts a fresh card. */
  closeTurn(): void {
    this.index.closeTurn()
  }

  /** One acting orchestration tool row. The host extracted its correlation facts. */
  applyToolRow(
    toolName: string,
    toolInput: string | undefined,
    result: AgentConversationResultProjection | undefined,
    timestamp: number,
  ): void {
    let input: z.infer<typeof sessionToolInputSchema> = {}
    try {
      input = sessionToolInputSchema.parse(JSON.parse(toolInput || '{}'))
    } catch {}

    if (toolName.endsWith('stop_session')) {
      const ref = input.session_id ? this.index.latestCard(input.session_id)?.agentConversationRef : undefined
      if (ref) ref.closedByAgent = true
      return
    }
    if (toolName.endsWith('start_session')) {
      if (!result?.agentSessionId) return
      const { exchange } = this.index.open(result.agentSessionId, {
        messageId: result.messageId,
        prompt: input.prompt ?? '',
        origin: 'created',
        provider: result.provider ?? input.agent_provider,
        fireAndForget: input.report === false,
        model: input.model_id,
        reasoningEffort: input.reasoning_effort,
        cwd: input.cwd ?? '',
        timestamp,
        restored: true,
      })
      this.settleWaited(exchange, result, timestamp)
      return
    }
    if (toolName.endsWith('send_session') && input.session_id) {
      const { exchange } = this.index.open(input.session_id, {
        messageId: result?.messageId,
        prompt: input.message ?? '',
        origin: 'prompted',
        provider: result?.provider,
        delivery: input.delivery === 'steer' ? 'steer' : undefined,
        cwd: '',
        timestamp,
        restored: true,
      })
      this.settleWaited(exchange, result, timestamp)
    }
  }

  /** A call that waited for its exchange carries the report no later turn does. */
  private settleWaited(exchange: AgentExchange, result: AgentConversationResultProjection | undefined, timestamp: number): void {
    if (!result?.report) return
    settle(exchange, result.report)
    exchange.restored = undefined
    exchange.settledAt = timestamp
  }

  /** True when the user turn came from the orchestrator — reports and notices —
   *  and was consumed: the caller must not render it as a user bubble. */
  applyUserRow(text: string, timestamp: number): boolean {
    const items = parseOrchestrationItems(text)
    if (!items) return false
    for (const item of items) {
      // A notice's request lives on the host while it waits, and a report ends
      // it; the notice itself changes no card.
      if (item.type === 'report') this.applyReport(item.report, timestamp)
    }
    return true
  }

  private applyReport(report: SessionReport, timestamp: number): void {
    // A report's dispatching tool row can sit outside the hydrated history
    // window; the reply still gets a card rather than being dropped.
    const exchange = this.index.exchange(report.messageId, report.agentSessionId)
      ?? this.index.open(report.agentSessionId, { messageId: report.messageId, prompt: '', origin: 'prompted', provider: report.provider, cwd: '', timestamp }).exchange
    const ref = (report.messageId ? this.index.card(report.messageId) : this.index.latestCard(report.agentSessionId))?.agentConversationRef
    if (ref && report.provider) ref.provider = report.provider
    settle(exchange, report)
    exchange.settledAt = timestamp
  }
}
