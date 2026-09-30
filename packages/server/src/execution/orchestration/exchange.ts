import type { AgentId } from '@solus/contracts/types'
import type { ExchangeOutcome, ExchangeRequest, OrchestrationItem, SessionOutput } from '@solus/contracts/session-exchange'
import { addOutput } from './session-outputs'

/**
 * One message from a sender session to a target session, from the moment the
 * orchestrator accepts it until its turn settles. The orchestrator is the only
 * owner: every change goes through `applyExchangeEvent`, which decides whether
 * the change is legal, and every legal change is published once.
 */

export type ExchangeState = 'dispatched' | 'queued' | 'running' | 'awaiting_input' | 'rate_limited' | 'settled'

export interface Exchange {
  exchangeId: string
  kind: 'create' | 'prompt'
  /** Solus id of the session that sent the message; its cards hear every change. */
  senderSessionId: string
  /** The sender's provider thread, which a report is delivered to. */
  senderAgentSessionId: string
  /** Solus id of the target, known once the message is accepted. */
  targetSessionId: string
  /** The id the sender's card knows the target by: `pending:<exchange>` until a created session starts. */
  targetAgentSessionId: string
  provider: AgentId
  /** Whether the result wakes the sender's model, or is only shown on its card. */
  notify: boolean
  /** The run the message is bound to. A result from any other run is stale. */
  runId?: string
  state: ExchangeState
  /** What the target's turn waits on a person for, kept after it is answered. */
  request?: ExchangeRequest
  /** What the turn produced, in the order it appeared: answers, plans, works,
   *  changed files, sessions it started. */
  outputs: SessionOutput[]
  /** Notices sent to the sender for this exchange that may still wait in its queue. */
  notices: string[]
  /** While `rate_limited`: when the provider's limit resets. */
  rateLimitResetsAt?: number
  /** A sender's tool call waiting on this exchange: the first report or notice
   *  goes to it instead of the sender's queue, or nothing when the time runs out. */
  wait?: { resolve: (item: OrchestrationItem | null) => void; timer: ReturnType<typeof setTimeout> }
  outcome?: ExchangeOutcome
  /** A person asked for changes to a plan: the run ends, and the revision continues this exchange. */
  revising: boolean
  dispatchedAt: number
}

export type ExchangeEvent =
  | { type: 'queued'; runId: string }
  | { type: 'started'; runId: string }
  | { type: 'input_requested'; request: ExchangeRequest }
  | { type: 'input_resolved'; outputs: SessionOutput[] }
  /** The target's provider refused the turn on a limit; it resumes at the reset. */
  | { type: 'rate_limited' }
  | { type: 'revision_requested' }
  | { type: 'settled'; runId?: string; outcome: ExchangeOutcome }

export function isOpenExchange(exchange: Exchange): boolean {
  return exchange.state !== 'settled'
}

/** Applies one event; false when the event does not apply to where the exchange stands. */
export function applyExchangeEvent(exchange: Exchange, event: ExchangeEvent): boolean {
  if (exchange.state === 'settled') return false
  switch (event.type) {
    case 'queued': return queue(exchange, event.runId)
    case 'started': return start(exchange, event.runId)
    case 'input_requested':
      // A turn that asks something has started, even if its provider spoke
      // before the launch finished reporting it.
      exchange.state = 'awaiting_input'
      exchange.request = event.request
      return true
    case 'input_resolved':
      if (exchange.state !== 'awaiting_input') return false
      exchange.state = 'running'
      for (const output of event.outputs) addOutput(exchange.outputs, output)
      return true
    case 'rate_limited':
      if (exchange.state === 'rate_limited' || exchange.state === 'awaiting_input') return false
      exchange.state = 'rate_limited'
      return true
    case 'revision_requested':
      if (exchange.state !== 'awaiting_input' && exchange.state !== 'running') return false
      exchange.revising = true
      return true
    case 'settled': return settle(exchange, event.runId, event.outcome)
  }
}

function queue(exchange: Exchange, runId: string): boolean {
  if (exchange.state !== 'dispatched' && !exchange.revising) return false
  exchange.state = 'queued'
  exchange.runId = runId
  exchange.revising = false
  return true
}

/** A run takes over this exchange: its first run, a queued one that reached
 *  the front, a steer joining the live turn, or a plan revision. */
function start(exchange: Exchange, runId: string): boolean {
  // A run parked on a rate limit starts again under its own id when the limit ends.
  if (exchange.runId === runId && exchange.state !== 'dispatched' && exchange.state !== 'queued' && exchange.state !== 'rate_limited') return false
  // The run already asked for a person before its start was reported: it is
  // still waiting, now bound to its run.
  if (exchange.state === 'awaiting_input' && !exchange.revising && (!exchange.runId || exchange.runId === runId)) {
    exchange.runId = runId
    return false
  }
  exchange.state = 'running'
  exchange.runId = runId
  exchange.revising = false
  return true
}

function settle(exchange: Exchange, runId: string | undefined, outcome: ExchangeOutcome): boolean {
  // The run a revision replaced ends without ending the exchange.
  if (exchange.revising) return false
  if (runId && exchange.runId && runId !== exchange.runId) return false
  exchange.state = 'settled'
  exchange.outcome = outcome
  return true
}
