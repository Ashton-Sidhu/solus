import type { AgentConversationRef, AgentExchange, AgentId, SessionMeta, SessionStatus } from '@solus/contracts/types'
import { loadServers, LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import { agentLabel } from '../../../../lib/agentAvailability'
import type { GroupedItem } from '../../lib/turns'
import { resolveSessionLinkMeta } from '../../lib/session-link'

/** The card's single headline state — one treatment, one verb, no layout shift. */
export type AgentConversationCardState = 'dispatching' | 'replying' | 'waiting' | 'replied' | 'failed' | 'closed'

const BUSY_STATUSES = new Set<SessionStatus>(['connecting', 'running', 'rate_limited'])

/** A create_session card before its session exists — nothing to open, track or
 *  interrupt yet. */
export function isPendingAgent(ref: AgentConversationRef): boolean {
  return ref.agentSessionId.startsWith('pending:')
}

export function agentConversationCardState(ref: AgentConversationRef, agentStatus: SessionStatus | null, now: number): AgentConversationCardState {
  if (ref.closedByAgent) return 'closed'
  const last = ref.exchanges[ref.exchanges.length - 1]
  if (!last) return 'dispatching'
  if (last.status === 'awaiting_input') {
    // The question may have been answered in the other agent's own tab — no
    // agent-conversation event fires for that, so the live status feed decides:
    // moved on and the card follows it back to replying.
    return agentStatus && BUSY_STATUSES.has(agentStatus) ? 'replying' : 'waiting'
  }
  // Answered by this side — the peer is unblocked and back at work, so the card
  // reads as replying without waiting for the status feed to catch up.
  if (last.status === 'answered') return 'replying'
  if (last.status === 'failed') return 'failed'
  // Startup has no status feed yet, so it stays 'dispatching' until the session
  // attaches — never aged out into a false 'replied'.
  if (last.status === 'dispatched' && isPendingAgent(ref)) return 'dispatching'
  if (last.status === 'dispatched') {
    if (agentStatus === 'awaiting_input' || agentStatus === 'awaiting_plan') return 'waiting'
    if (agentStatus && BUSY_STATUSES.has(agentStatus)) return 'replying'
    // A live dispatch is authoritative even if the status store still carries
    // the previous round's quiet state. Only a dispatch rebuilt after restart
    // can have lost its in-memory completion watcher and age out here.
    return last.restored && now - last.dispatchedAt >= 15_000 ? 'replied' : 'dispatching'
  }
  return 'replied'
}

/** Live states keep their colour, clock and footer; settled states drop all three. */
export function isLiveAgentConversationState(state: AgentConversationCardState): boolean {
  return state === 'dispatching' || state === 'replying' || state === 'waiting'
}

/** One agent is a two-voice card; two or more share one card with a tab row. */
export type AgentConversationLayout = 'single' | 'switchboard'

export function agentConversationLayout(refs: AgentConversationRef[]): AgentConversationLayout {
  return refs.length <= 1 ? 'single' : 'switchboard'
}

/** The at-rest row's single line: the agent's own words, quoted not summarised.
 *  A blocked agent shows its question — that block is what needs a human, so it
 *  outranks the last reply. */
export function agentLatestLine(ref: AgentConversationRef, state: AgentConversationCardState): string {
  const last = ref.exchanges[ref.exchanges.length - 1]
  if (!last) return ''
  if (state === 'waiting' && last.question) return truncate(last.question.text, 90)
  // Just answered and nothing back yet — the last thing said in this card is
  // what we answered with, not the prompt that opened the exchange.
  if (last.status === 'answered' && last.answer) return truncate(last.answer, 90)
  return truncate(last.reply || last.prompt, 90)
}

/** This agent has been asked something and hasn't answered yet — including a
 *  pause where it is waiting on the user, which still leaves the turn owed a
 *  reply. Deliberately status-free: it reads the exchange the transcript
 *  already carries, so it holds for a turn whose live feed hasn't landed. */
export function isAwaitingReply(ref: AgentConversationRef): boolean {
  if (ref.closedByAgent) return false
  const last = ref.exchanges[ref.exchanges.length - 1]
  if (!last || last.reply) return false
  return last.status === 'dispatched' || last.status === 'answered' || last.status === 'awaiting_input'
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
      messages.push({ key: `${exchange.exchangeId}:you`, from: 'you', kind: 'prompt', text: exchange.prompt, pending: false })
    }
    messages.push(...agentSideOf(exchange))
  }
  return messages
}

function agentSideOf(exchange: AgentExchange): AgentMessage[] {
  const key = `${exchange.exchangeId}:agent`
  // Question then answer then reply are one exchange, so an answered pause keeps
  // both halves rather than collapsing to whichever came last.
  const asked = exchange.question && (exchange.status === 'awaiting_input' || exchange.answer)
    ? [{ key, from: 'agent' as const, kind: 'question' as const, text: exchange.question.text, pending: false }]
    : []
  const answered = exchange.answer
    ? [{ key: `${exchange.exchangeId}:answer`, from: 'you' as const, kind: 'prompt' as const, text: exchange.answer, pending: false }]
    : []
  const replyKey = `${exchange.exchangeId}:reply`
  if (exchange.reply) {
    return [...asked, ...answered, { key: replyKey, from: 'agent', kind: 'reply', text: exchange.reply, pending: false }]
  }
  // One pending slot at most, and never beside an unanswered question — the
  // question IS what the exchange is doing right now.
  if (exchange.status === 'dispatched' || exchange.status === 'answered' || (exchange.status === 'awaiting_input' && !asked.length)) {
    return [...asked, ...answered, { key: replyKey, from: 'agent', kind: 'reply', text: '', pending: true }]
  }
  // Failed or interrupted with nothing said: the header carries the cause, so
  // an empty block here would only repeat it.
  return [...asked, ...answered]
}

export interface AgentMessageFold {
  folded: AgentMessage[]
  open: AgentMessage[]
}

/** Live shows the last two messages, at rest the final reply only — a long
 *  negotiation reads at constant height. */
export function foldMessages(messages: AgentMessage[], atRest: boolean): AgentMessageFold {
  const openCount = atRest ? 1 : 2
  if (messages.length <= openCount) return { folded: [], open: messages }
  return {
    folded: messages.slice(0, messages.length - openCount),
    open: messages.slice(messages.length - openCount),
  }
}

/** The fold row's trail: the first clause of each folded reply, joined — the
 *  agent's own words, never a generated summary. */
export function foldTrail(folded: AgentMessage[]): string {
  return truncate(
    folded
      .filter((message) => message.from === 'agent' && message.text)
      .map((message) => firstClause(message.text))
      .join(' · '),
    90,
  )
}

/** The opening sentence, or the first line if it runs on — what a person would
 *  quote back when asked what the reply said. */
function firstClause(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  const stop = line.search(/[.!?](\s|$)/)
  return stop === -1 ? line : line.slice(0, stop + 1)
}

export function wordCount(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 1))}…` : oneLine
}

// ─── Identity ───

/** Colour is identity, and only the remote side has one. Assigned by dispatch
 *  order rather than by vendor, so two Codex sessions in one card are still
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

/** The tab chip's disambiguator: the worktree, which is what actually differs
 *  between two sessions of the same agent. */
export function worktreeLabel(ref: AgentConversationRef, meta: SessionMeta | undefined): string {
  const segments = (meta?.cwd || ref.cwd).replace(/\/+$/, '').split('/').filter(Boolean)
  return segments[segments.length - 1] ?? ''
}

// ─── Oversized replies ───

/** Some replies are artefacts rather than answers. Those never inline at any
 *  height: the card states what arrived and hands off to the session or the
 *  diff panel. A conversation is not a log viewer. */
export interface AgentReplyArtefact {
  /** What arrived and how big it is, in the product's words. */
  label: string
  /** The agent's own one-line framing, where it wrote one before the payload.
   *  Empty when the reply is nothing but the artefact. */
  framing: string
}

const ARTEFACT_CHARS = 6000
const DIFF_LINE_RE = /^(?:diff --git |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|--- \S)/

export function replyArtefact(text: string): AgentReplyArtefact | null {
  const lines = text.split('\n')
  const payloadStart = lines.findIndex((line) => DIFF_LINE_RE.test(line))
  if (payloadStart !== -1) {
    const files = lines.filter((line) => line.startsWith('diff --git ')).length
      || lines.filter((line) => line.startsWith('--- ')).length
      || 1
    const changed = lines.filter((line) => /^[+-][^+-]/.test(line)).length
    return {
      label: `Patch · ${plural(files, 'file')}, ${plural(changed, 'line')}`,
      framing: framingBefore(lines, payloadStart),
    }
  }
  if (text.length > ARTEFACT_CHARS) {
    return { label: `Output · ${plural(lines.length, 'line')}`, framing: firstClause(text) }
  }
  return null
}

function framingBefore(lines: string[], payloadStart: number): string {
  const lead = lines.slice(0, payloadStart).join(' ').trim()
  return lead ? firstClause(lead) : ''
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
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
  const end = last.settledAt ?? (last.status === 'dispatched' || last.status === 'awaiting_input' || last.status === 'answered' ? now : last.dispatchedAt)
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
 *  never in the resting card. The worktree stays out of it: it is the tab row's
 *  disambiguator (see `worktreeLabel`), so repeating the path here only spends
 *  three wrapped lines restating what the card already shows. */
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

/** Resume the other agent in a tab. Card and switchboard open it the same way:
 *  the index knows where it really lives, the ref's cwd is the fallback so a
 *  cross-project session still lands in the right directory.
 *
 *  `split` opens it beside this conversation and leaves focus where it is, so a
 *  live exchange stays watchable while the other side is read — which is why it
 *  resumes in the background first. */
export async function openAgentSession(
  ref: AgentConversationRef,
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
