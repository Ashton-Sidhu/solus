import type { Message, RelayExchange, RelayRef } from '../../../shared/types'
import { nextMsgId } from './session.utils'

/** Matches the session-orchestration tools for both Claude (`mcp__solus__*`)
 *  and Codex (bare names). read/list/search are observations, not relays. */
export function isSessionRelayTool(name: string | undefined): boolean {
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
  peerSessionId: string
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
    peerSessionId: head[1],
    kind: head[2] === 'finished' ? 'settled' : 'awaiting',
    status: head[3],
    body: at === -1 ? '' : text.slice(at + marker.length),
  }
}

/**
 * Rebuilds relay cards from a persisted transcript: session-tool rows open
 * exchanges, `[session report]` user turns resolve them (oldest-first — the
 * same FIFO the control plane uses), and genuine user turns cut the one-card-
 * per-peer-per-turn boundary. Mirrors the live RelayTracker's keying exactly.
 */
export class RelayTranscriptBuilder {
  private currentByPeer = new Map<string, Message>()
  private countByPeer = new Map<string, number>()
  private unresolvedByPeer = new Map<string, RelayExchange[]>()
  private latestByPeer = new Map<string, Message>()

  constructor(private messages: Message[]) {}

  /** A genuine user turn: the next dispatch per peer starts a fresh card. */
  closeTurn(): void {
    this.currentByPeer.clear()
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
      const peer = typeof input.session_id === 'string' ? input.session_id : null
      const message = peer ? this.latestByPeer.get(peer) : undefined
      if (message?.relayRef) message.relayRef.closedByPeer = true
      return
    }

    if (toolName.endsWith('create_session')) {
      const peer = resultText?.match(SESSION_ID_IN_RESULT)?.[1]
      if (!peer) return
      this.openExchange(peer, {
        prompt: typeof input.prompt === 'string' ? input.prompt : '',
        origin: 'created',
        model: typeof input.model_id === 'string' ? input.model_id : undefined,
        reasoningEffort: typeof input.reasoning_effort === 'string' ? input.reasoning_effort : undefined,
        cwd: typeof input.cwd === 'string' ? input.cwd : '',
        timestamp,
      })
      return
    }

    const peer = typeof input.session_id === 'string' ? input.session_id : null
    if (!peer) return
    if (toolName.endsWith('prompt_session')) {
      this.openExchange(peer, {
        prompt: typeof input.prompt === 'string' ? input.prompt : '',
        origin: 'prompted',
        delivery: input.delivery === 'steer' ? 'steer' : undefined,
        cwd: '',
        timestamp,
      })
    } else if (toolName.endsWith('wait_for_session')) {
      // A watch that never armed (target was idle) produced no exchange.
      if (resultText?.includes('no watcher was registered')) return
      this.openExchange(peer, { prompt: '', origin: 'watched', cwd: '', timestamp })
    }
  }

  /** Returns true when the user row was a session report and was consumed —
   *  the caller must NOT render it as a user bubble. */
  applyUserRow(text: string): boolean {
    const report = parseSessionReport(text)
    if (!report) return false
    const pending = this.unresolvedByPeer.get(report.peerSessionId)
    const exchange = pending?.[0]
    if (!exchange) return true
    if (report.kind === 'awaiting') {
      exchange.status = 'awaiting_input'
      exchange.question = { kind: 'question', text: report.body.trim() }
      return true
    }
    pending!.shift()
    exchange.status = report.status === 'interrupted' ? 'interrupted' : report.status === 'failed' ? 'failed' : 'done'
    exchange.question = undefined
    exchange.reply = report.body.trim()
    return true
  }

  private openExchange(
    peer: string,
    opts: {
      prompt: string
      origin: RelayRef['origin']
      delivery?: 'steer'
      model?: string
      reasoningEffort?: string
      cwd: string
      timestamp: number
    },
  ): void {
    const index = (this.countByPeer.get(peer) ?? 0) + 1
    this.countByPeer.set(peer, index)
    const exchange: RelayExchange = {
      exchangeId: `rebuilt:${peer}:${index}`,
      index,
      prompt: opts.prompt,
      delivery: opts.delivery,
      dispatchedAt: opts.timestamp,
      status: 'dispatched',
    }
    const pending = this.unresolvedByPeer.get(peer) ?? []
    pending.push(exchange)
    this.unresolvedByPeer.set(peer, pending)

    const current = this.currentByPeer.get(peer)
    if (current?.relayRef) {
      current.relayRef.exchanges.push(exchange)
      if (opts.model) current.relayRef.model = opts.model
      return
    }
    const message: Message = {
      id: nextMsgId(),
      role: 'assistant',
      content: '',
      relayRef: {
        peerSessionId: peer,
        // Provider is not recorded in the tool row; the relay status store's
        // index hydration corrects it before the card is read.
        provider: 'claude-code',
        title: opts.prompt ? truncateTitle(opts.prompt) : peer.slice(0, 8),
        cwd: opts.cwd,
        model: opts.model,
        reasoningEffort: opts.reasoningEffort,
        origin: opts.origin,
        exchanges: [exchange],
      },
      timestamp: opts.timestamp,
    }
    this.messages.push(message)
    this.currentByPeer.set(peer, message)
    this.latestByPeer.set(peer, message)
  }
}

function truncateTitle(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine
}
