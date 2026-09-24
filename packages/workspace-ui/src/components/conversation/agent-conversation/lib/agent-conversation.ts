import type { AgentConversationRef, AgentExchange, AgentExchangeStatus, AgentId, SentSessionMessage, SessionMeta } from '@solus/contracts/types'
import { exchangeRequestText, type ExchangeRequest, type SessionOutput } from '@solus/contracts/session-exchange'
import { loadServers, LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import { agentLabel } from '../../../../lib/agentAvailability'
import type { GroupedItem } from '../../lib/turns'
import { resolveSessionLinkMeta } from '../../lib/session-link'

/** The card's single headline state — one treatment, one verb, no layout shift.
 *  `lost` is a message whose reply a host restart took; `limited` is a turn
 *  parked on its provider's rate limit, which resumes on its own. */
export type AgentConversationCardState = 'dispatching' | 'replying' | 'waiting' | 'limited' | 'replied' | 'failed' | 'lost' | 'closed'

const OPEN_STATUSES = new Set<AgentExchangeStatus>(['dispatched', 'queued', 'running', 'awaiting_input', 'rate_limited', 'answered'])

/** A start_session card before its session exists — nothing to open, track or
 *  interrupt yet. */
export function isPendingAgent(ref: AgentConversationRef): boolean {
  return ref.agentSessionId.startsWith('pending:')
}

/** A message rebuilt from the transcript and not yet answered there: only the
 *  host can say whether it is still being carried. */
export function awaitsHostWord(ref: AgentConversationRef): boolean {
  const last = ref.exchanges[ref.exchanges.length - 1]
  return !!last?.restored && OPEN_STATUSES.has(last.status)
}

/**
 * The card's state, read off its last exchange: the host's orchestrator says
 * where every live exchange stands. `carried` is the host's word on a message
 * rebuilt from the transcript (see `sent-messages.store`): undefined while
 * unasked, null once the host no longer carries it — a restart ended it.
 */
export function agentConversationCardState(
  ref: AgentConversationRef,
  carried: SentSessionMessage | null | undefined,
): AgentConversationCardState {
  if (ref.closedByAgent) return 'closed'
  const last = ref.exchanges[ref.exchanges.length - 1]
  if (!last) return 'dispatching'
  if (last.restored && OPEN_STATUSES.has(last.status)) {
    if (carried === undefined) return 'dispatching'
    if (carried === null) return 'lost'
    if (carried.state === 'awaiting_input') return 'waiting'
    if (carried.state === 'rate_limited') return 'limited'
    return carried.state === 'queued' ? 'dispatching' : 'replying'
  }
  switch (last.status) {
    case 'dispatched':
    case 'queued':
      return 'dispatching'
    case 'running':
    case 'answered':
      return 'replying'
    case 'awaiting_input':
      return 'waiting'
    case 'rate_limited':
      return 'limited'
    case 'failed':
      return 'failed'
    case 'lost':
      return 'lost'
    case 'done':
    case 'interrupted':
      return 'replied'
  }
}

/** What the card's last exchange is waiting on a person for, if it is waiting. */
export function pendingRequest(ref: AgentConversationRef, carried: SentSessionMessage | null | undefined): ExchangeRequest | null {
  const last = ref.exchanges[ref.exchanges.length - 1]
  if (!last) return null
  // The transcript never recorded a rebuilt request; the host still has it.
  if (last.restored) return carried?.state === 'awaiting_input' ? carried.request ?? null : null
  return last.status === 'awaiting_input' ? last.request ?? null : null
}

/** A plan the other agent's last finished turn brought back, which a person can
 *  still approve or send back from here. The host refuses a decision on a plan
 *  that was already acted on. */
export function planAwaitingDecision(ref: AgentConversationRef): Extract<SessionOutput, { kind: 'plan' }> | null {
  if (ref.closedByAgent) return null
  const last = ref.exchanges[ref.exchanges.length - 1]
  if (last?.status !== 'done') return null
  return last.outputs?.findLast((output) => output.kind === 'plan') ?? null
}

/** The task the other session works on, as its latest report named it. */
export function cardTaskId(ref: AgentConversationRef): string | undefined {
  return ref.exchanges.findLast((exchange) => exchange.taskId)?.taskId
}

/** When a card parked on a rate limit resumes, if its provider said. The host
 *  carries it for a message rebuilt from the transcript. */
export function rateLimitedUntil(ref: AgentConversationRef, carried: SentSessionMessage | null | undefined): number | undefined {
  const last = ref.exchanges[ref.exchanges.length - 1]
  if (!last) return undefined
  if (last.restored) return carried?.state === 'rate_limited' ? carried.resetsAt : undefined
  return last.status === 'rate_limited' ? last.rateLimitedUntil : undefined
}

/** Live states keep their colour, clock and footer; settled states drop all three. */
export function isLiveAgentConversationState(state: AgentConversationCardState): boolean {
  return state === 'dispatching' || state === 'replying' || state === 'waiting' || state === 'limited'
}

/** This agent has been asked something and hasn't answered yet — including a
 *  pause where it is waiting on the user, which still leaves the turn owed a
 *  reply. Deliberately status-free: it reads the exchange the transcript
 *  already carries, so it holds for a turn whose live feed hasn't landed. */
export function isAwaitingReply(ref: AgentConversationRef): boolean {
  if (ref.closedByAgent) return false
  const last = ref.exchanges[ref.exchanges.length - 1]
  if (!last || last.reply) return false
  return OPEN_STATUSES.has(last.status)
}

/** Agents this turn has asked and not yet heard back from, in dispatch order.
 *  While the parent has no tool running, this — not "planning the next step" —
 *  is what it is actually doing. */
export function agentsAwaitingReply(items: GroupedItem[]): string[] {
  const names: string[] = []
  for (const item of items) {
    if (item.kind !== 'agent-conversation-group') continue
    for (const message of item.messages) {
      const ref = message.agentConversationRef
      if (!ref || !isAwaitingReply(ref)) continue
      const name = agentLabel(ref.provider)
      if (!names.includes(name)) names.push(name)
    }
  }
  return names
}

/** Name the agents, never the mechanism — and past two, count them rather than
 *  running a list into the row's truncation. */
export function waitingOnLabel(names: string[]): string | null {
  if (names.length === 0) return null
  if (names.length === 1) return `Waiting on ${names[0]}…`
  if (names.length === 2) return `Waiting on ${names[0]} and ${names[1]}…`
  return `Waiting on ${names.length} agents…`
}

// ─── Messages ───

/** The rendered unit. An exchange is a prompt and its answer; the card draws
 *  each as its own labelled block, both left-aligned, so attribution is carried
 *  by words rather than by alignment. */
export interface AgentMessage {
  key: string
  from: 'you' | 'agent'
  kind: 'prompt' | 'reply' | 'question'
  text: string
  /** The agent's reply slot before any of it has landed — the typing indicator. */
  pending: boolean
}

/** Flattens the exchange list into the message stream the card reads. A pending
 *  message is always emitted for an unsettled tail; the card drops it once the
 *  exchange stops being live, so a lost settle reads as a quiet fact rather
 *  than dots that never stop. */
export function agentMessages(ref: AgentConversationRef): AgentMessage[] {
  const messages: AgentMessage[] = []
  for (const exchange of ref.exchanges) {
    if (exchange.prompt) {
      messages.push({ key: `${exchange.messageId}:you`, from: 'you', kind: 'prompt', text: exchange.prompt, pending: false })
    }
    messages.push(...agentSideOf(exchange))
  }
  return messages
}

function agentSideOf(exchange: AgentExchange): AgentMessage[] {
  const key = `${exchange.messageId}:agent`
  // Request then answer then reply are one exchange, so an answered pause keeps
  // both halves rather than collapsing to whichever came last.
  const asked = exchange.request && (exchange.status === 'awaiting_input' || exchange.answers?.length)
    ? [{ key, from: 'agent' as const, kind: 'question' as const, text: exchangeRequestText(exchange.request), pending: false }]
    : []
  const answered = exchange.answers?.length
    ? [{ key: `${exchange.messageId}:answer`, from: 'you' as const, kind: 'prompt' as const, text: exchange.answers.join('\n'), pending: false }]
    : []
  const replyKey = `${exchange.messageId}:reply`
  if (exchange.reply) {
    return [...asked, ...answered, { key: replyKey, from: 'agent', kind: 'reply', text: exchange.reply, pending: false }]
  }
  // One pending slot at most, and never beside an unanswered question — the
  // question IS what the exchange is doing right now.
  if (exchange.status === 'dispatched' || exchange.status === 'queued' || exchange.status === 'running' || exchange.status === 'answered' || (exchange.status === 'awaiting_input' && !asked.length)) {
    return [...asked, ...answered, { key: replyKey, from: 'agent', kind: 'reply', text: '', pending: true }]
  }
  // Failed or interrupted with nothing said: the header carries the cause, so
  // an empty block here would only repeat it.
  return [...asked, ...answered]
}

// ─── Identity ───

/** Colour is identity, and only the remote side has one. Assigned by dispatch
 *  order rather than by vendor, so two Codex sessions in one turn are still
 *  told apart. chart-2 (needs you) and destructive (failed) are states, never
 *  identities, so neither appears here. */
const AGENT_ACCENTS = ['var(--chart-4)', 'var(--primary)', 'var(--chart-5)', 'var(--chart-3)']

export function agentAccent(index: number): string {
  return AGENT_ACCENTS[((index % AGENT_ACCENTS.length) + AGENT_ACCENTS.length) % AGENT_ACCENTS.length]
}

/** Which way the in-flight message is travelling — the direction dot points at
 *  whoever it is going to. Everything settled hides the dot and keeps the rule. */
export function directionFlow(state: AgentConversationCardState): 'to-you' | 'to-agent' | null {
  if (state === 'replying') return 'to-you'
  if (state === 'dispatching') return 'to-agent'
  return null
}

// ─── Numbers, provenance, navigation ───

/** '8s' under a minute, '1m 04s' beyond — the header's tabular column. */
export function formatAgentConversationDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}

/** Wall time the card covers: settled sum where known, live tail included. */
export function agentConversationElapsedMs(ref: AgentConversationRef, now: number): number {
  const first = ref.exchanges[0]
  if (!first) return 0
  const last = ref.exchanges[ref.exchanges.length - 1]
  const end = last.settledAt ?? (OPEN_STATUSES.has(last.status) ? now : last.dispatchedAt)
  return Math.max(0, end - first.dispatchedAt)
}

/** Host segment of the provenance line. Local sessions omit it — the host is
 *  only a fact worth stating when it differs from where the user is. */
export function hostLabelFor(serverId: string | undefined): string | null {
  if (!serverId || serverId === LOCAL_SERVER_ID) return null
  try {
    return loadServers().find((server) => server.id === serverId)?.label ?? null
  } catch {
    return null
  }
}

/** `host · model effort` — provenance on demand only: this lives in the ⋯ menu,
 *  never in the resting card. */
export function provenanceLine(ref: AgentConversationRef, meta: SessionMeta | undefined, hostLabel: string | null): string {
  const model = meta?.model ?? ref.model
  const effort = meta?.reasoningEffort ?? ref.reasoningEffort
  return [
    hostLabel,
    model ? `${model}${effort ? ` ${effort}` : ''}` : null,
  ].filter(Boolean).join(' · ')
}

export interface AgentSessionOpener {
  resume: (meta: SessionMeta, opts?: { background?: boolean }) => Promise<string>
  openInSplit: (tabId: string) => void
}

/** Resume the other agent in a tab. The index knows where it really lives, the ref's cwd is the fallback so a
 *  cross-project session still lands in the right directory.
 *
 *  `split` opens it beside this conversation and leaves focus where it is, so a
 *  live exchange stays watchable while the other side is read — which is why it
 *  resumes in the background first. */
export async function openAgentSession(
  ref: Pick<AgentConversationRef, 'agentSessionId' | 'cwd'>,
  provider: AgentId,
  sourceServerId: string | undefined,
  opener: AgentSessionOpener,
  options: { split?: boolean; background?: boolean } = {},
): Promise<void> {
  const meta = await resolveSessionLinkMeta({
    provider,
    sessionId: ref.agentSessionId,
    serverId: null,
    cwd: ref.cwd,
  }, sourceServerId)
  const tabId = await opener.resume(meta, { background: Boolean(options.split || options.background) })
  if (options.split) opener.openInSplit(tabId)
}

/** Display title: the CLI slug wins once the indexer has it. */
export function agentConversationTitle(ref: AgentConversationRef, meta: SessionMeta | undefined): string {
  return meta?.slug || ref.title
}
