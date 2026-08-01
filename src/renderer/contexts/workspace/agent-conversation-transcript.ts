import type { AgentConversationRef, AgentExchange, Message } from '../../../shared/types'
import { nextMsgId } from './session.utils'

/** Matches the session-orchestration tools for both Claude (`mcp__solus__*`)
 *  and Codex (bare names). read/list/search are observations, not agent actions. */
export function isAgentConversationTool(name: string | undefined): boolean {
  if (!name) return false
  return (
    name.endsWith('create_session') ||
    name.endsWith('prompt_session') ||
    name.endsWith('wait_for_session') ||
    name.endsWith('stop_session')
  )
}

const REPORT_HEAD = /^\[session report\] Session ([0-9a-f-]{36}) (finished|is waiting) \(status: ([a-z_]+)\)/
const SESSION_ID_IN_RESULT = /sessionId=([0-9a-f-]{36})/

interface ParsedReport {
  agentSessionId: string
  kind: 'settled' | 'awaiting'
  status: string
  body: string
}

/** Parse a persisted `[session report]` user turn (session-report.ts formats).
 *  Null means "not a report" — the caller renders the row as ordinary text. */
export function parseSessionReport(text: string): ParsedReport | null {
  const head = text.match(REPORT_HEAD)
  if (!head) return null
  const marker = head[2] === 'finished' ? 'Final reply:\n' : 'Pending input:\n'
  const at = text.indexOf(marker)
  return {
    agentSessionId: head[1],
    kind: head[2] === 'finished' ? 'settled' : 'awaiting',
    status: head[3],
    body: at === -1 ? '' : text.slice(at + marker.length),
  }
}

/**
 * Rebuilds agent-conversation cards from a persisted transcript: session-tool rows open
 * exchanges, `[session report]` user turns resolve them (oldest-first — the
 * same FIFO the control plane uses), and genuine user turns cut the one-card-
 * per-agent-per-turn boundary. Mirrors the live AgentConversationTracker's keying exactly.
 */
export class AgentConversationTranscriptBuilder {
  private currentByAgent = new Map<string, Message>()
  private countByAgent = new Map<string, number>()
  private unresolvedByAgent = new Map<string, AgentExchange[]>()
  private latestByAgent = new Map<string, Message>()

  constructor(private messages: Message[]) {}

  /** A genuine user turn: the next dispatch per agent starts a fresh card. */
  closeTurn(): void {
    this.currentByAgent.clear()
  }

  /** Handle one session-tool row (already pushed as a tool row for debug
   *  visibility). `resultText` is the tool result, used to learn the created
   *  session's id. */
  applyToolRow(
    toolName: string,
    toolInput: string | undefined,
    resultText: string | undefined,
    timestamp: number,
  ): void {
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse(toolInput || '{}')
    } catch {}

    if (toolName.endsWith('stop_session')) {
      const agentSessionId = typeof input.session_id === 'string' ? input.session_id : null
      const message = agentSessionId ? this.latestByAgent.get(agentSessionId) : undefined
      if (message?.agentConversationRef) message.agentConversationRef.closedByAgent = true
      return
    }

    if (toolName.endsWith('create_session')) {
      const agentSessionId = resultText?.match(SESSION_ID_IN_RESULT)?.[1]
      if (!agentSessionId) return
      this.openExchange(agentSessionId, {
        prompt: typeof input.prompt === 'string' ? input.prompt : '',
        origin: 'created',
        fireAndForget: input.mode === 'fire_and_forget',
        model: typeof input.model_id === 'string' ? input.model_id : undefined,
        reasoningEffort: typeof input.reasoning_effort === 'string' ? input.reasoning_effort : undefined,
        cwd: typeof input.cwd === 'string' ? input.cwd : '',
        timestamp,
      })
      return
    }

    const agentSessionId = typeof input.session_id === 'string' ? input.session_id : null
    if (!agentSessionId) return
    if (toolName.endsWith('prompt_session')) {
      this.openExchange(agentSessionId, {
        prompt: typeof input.prompt === 'string' ? input.prompt : '',
        origin: 'prompted',
        delivery: input.delivery === 'steer' ? 'steer' : undefined,
        cwd: '',
        timestamp,
      })
    } else if (toolName.endsWith('wait_for_session')) {
      // A watch that never armed (target was idle) produced no exchange.
      if (resultText?.includes('no watcher was registered')) return
      this.openExchange(agentSessionId, { prompt: '', origin: 'watched', cwd: '', timestamp })
    }
  }

  /** Returns true when the user row was a session report and was consumed —
   *  the caller must NOT render it as a user bubble. */
  applyUserRow(text: string, timestamp: number): boolean {
    const report = parseSessionReport(text)
    if (!report) return false
    const pending = this.unresolvedByAgent.get(report.agentSessionId)
    let exchange = pending?.[0]
    if (!exchange) {
      // A stale waiting notice with nothing to attach to can drop; a settled
      // reply cannot — its dispatching tool row may sit outside the hydrated
      // history window, and suppressing the bubble without a card would lose
      // the other agent's words entirely. Synthesize the exchange.
      if (report.kind === 'awaiting') return true
      exchange = this.openExchange(report.agentSessionId, { prompt: '', origin: 'prompted', cwd: '', timestamp })
    }
    if (report.kind === 'awaiting') {
      exchange.status = 'awaiting_input'
      exchange.question = { kind: 'question', text: report.body.trim() }
      return true
    }
    const queue = this.unresolvedByAgent.get(report.agentSessionId)
    if (queue && queue[0] === exchange) queue.shift()
    exchange.status = report.status === 'interrupted' ? 'interrupted' : report.status === 'failed' ? 'failed' : 'done'
    exchange.question = undefined
    exchange.reply = report.body.trim()
    return true
  }

  private openExchange(
    agentSessionId: string,
    opts: {
      prompt: string
      origin: AgentConversationRef['origin']
      fireAndForget?: boolean
      delivery?: 'steer'
      model?: string
      reasoningEffort?: string
      cwd: string
      timestamp: number
    },
  ): AgentExchange {
    const index = (this.countByAgent.get(agentSessionId) ?? 0) + 1
    this.countByAgent.set(agentSessionId, index)
    const exchange: AgentExchange = {
      exchangeId: `rebuilt:${agentSessionId}:${index}`,
      index,
      prompt: opts.prompt,
      delivery: opts.delivery,
      dispatchedAt: opts.timestamp,
      status: 'dispatched',
      restored: true,
    }
    const pending = this.unresolvedByAgent.get(agentSessionId) ?? []
    pending.push(exchange)
    this.unresolvedByAgent.set(agentSessionId, pending)

    const current = this.currentByAgent.get(agentSessionId)
    if (current?.agentConversationRef) {
      current.agentConversationRef.exchanges.push(exchange)
      // Prompted or watched after launch — this side is talking to it after all.
      current.agentConversationRef.fireAndForget = undefined
      if (opts.model) current.agentConversationRef.model = opts.model
      return exchange
    }
    const message: Message = {
      id: nextMsgId(),
      role: 'assistant',
      content: '',
      agentConversationRef: {
        agentSessionId,
        // Provider is not recorded in the tool row; the agent status store's
        // index hydration corrects it before the card is read.
        provider: 'claude-code',
        title: opts.prompt ? truncateTitle(opts.prompt) : agentSessionId.slice(0, 8),
        cwd: opts.cwd,
        model: opts.model,
        reasoningEffort: opts.reasoningEffort,
        origin: opts.origin,
        fireAndForget: opts.fireAndForget,
        exchanges: [exchange],
      },
      timestamp: opts.timestamp,
    }
    this.messages.push(message)
    this.currentByAgent.set(agentSessionId, message)
    this.latestByAgent.set(agentSessionId, message)
    return exchange
  }
}

function truncateTitle(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine
}
