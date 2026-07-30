import type { AgentId, RelayExchange, RelayRef, SessionMeta, SessionStatus } from '../../../../../shared/types'
import { loadServers, LOCAL_SERVER_ID } from '../../../../../client-core/server-registry'

/** The card's single headline state — one dot, one verb, no layout shift. */
export type RelayCardState = 'dispatching' | 'replying' | 'waiting' | 'done' | 'failed' | 'closed'

const BUSY_STATUSES = new Set<SessionStatus>(['connecting', 'running', 'rate_limited'])

export function relayCardState(ref: RelayRef, peerStatus: SessionStatus | null, now: number): RelayCardState {
  if (ref.closedByPeer) return 'closed'
  const last = ref.exchanges[ref.exchanges.length - 1]
  if (!last) return 'dispatching'
  if (last.status === 'awaiting_input') return 'waiting'
  if (last.status === 'failed') return 'failed'
  if (last.status === 'dispatched') {
    if (peerStatus === 'awaiting_input' || peerStatus === 'awaiting_plan') return 'waiting'
    if (peerStatus && BUSY_STATUSES.has(peerStatus)) return 'replying'
    // A pending exchange on a quiet peer is either a just-sent prompt the peer
    // hasn't picked up yet, or a settle that was never recorded (app restart —
    // watchers are in-memory). Recency separates the two; a stale one settles
    // the card so it can't shimmer forever.
    return now - last.dispatchedAt < 15_000 ? 'dispatching' : 'done'
  }
  return 'done'
}

export function relayStateLabel(state: RelayCardState): string {
  switch (state) {
    case 'dispatching': return 'dispatching'
    case 'replying': return 'Replying'
    case 'waiting': return 'Waiting on you'
    case 'done': return ''
    case 'failed': return 'Failed'
    case 'closed': return 'closed by the other side'
  }
}

/** Live states keep their chrome; settled states drop it (design §3b). */
export function isLiveRelayState(state: RelayCardState): boolean {
  return state === 'dispatching' || state === 'replying' || state === 'waiting'
}

export interface RelayFold {
  folded: RelayExchange[]
  open: RelayExchange[]
}

/** Last two exchanges stay open while live, only the last at rest — a long
 *  negotiation reads at constant height (design §3a). */
export function foldExchanges(exchanges: RelayExchange[], atRest: boolean): RelayFold {
  const openCount = atRest ? 1 : 2
  if (exchanges.length <= openCount) return { folded: [], open: exchanges }
  return {
    folded: exchanges.slice(0, exchanges.length - openCount),
    open: exchanges.slice(exchanges.length - openCount),
  }
}

/** Topic trail for the fold row: the first words of the folded prompts. */
export function foldTopics(folded: RelayExchange[]): string {
  return folded
    .map((exchange) => exchange.prompt)
    .filter(Boolean)
    .slice(0, 2)
    .map((prompt) => truncate(prompt, 36))
    .join(' · ')
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 1))}…` : oneLine
}

/** '8s' under a minute, '1m 04s' beyond — matches the design's tabular column. */
export function formatRelayDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}

/** Wall time the relay covers: settled sum where known, live tail included. */
export function relayElapsedMs(ref: RelayRef, now: number): number {
  const first = ref.exchanges[0]
  if (!first) return 0
  const last = ref.exchanges[ref.exchanges.length - 1]
  const end = last.settledAt ?? (last.status === 'dispatched' || last.status === 'awaiting_input' ? now : last.dispatchedAt)
  return Math.max(0, end - first.dispatchedAt)
}

export function exchangeDurationMs(exchange: RelayExchange, now: number): number | null {
  if (exchange.durationMs != null) return exchange.durationMs
  if (exchange.settledAt != null) return exchange.settledAt - exchange.dispatchedAt
  if (exchange.status === 'dispatched' || exchange.status === 'awaiting_input') return now - exchange.dispatchedAt
  return null
}

export function agentMonogram(provider: AgentId): string {
  if (provider === 'codex') return 'CX'
  if (provider === 'opencode') return 'OC'
  return 'CL'
}

/** Paths in the provenance line read as places, not filesystems: keep the last
 *  two segments (`.solus-worktrees/eviction-perf-4ktpq`). */
export function shortPath(cwd: string): string {
  const segments = cwd.replace(/\/+$/, '').split('/').filter(Boolean)
  return segments.slice(-2).join('/') || cwd
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

/** `host · worktree · model effort` — stated once, in the body (design §3a). */
export function provenanceLine(ref: RelayRef, meta: SessionMeta | undefined, hostLabel: string | null): string {
  const model = meta?.model ?? ref.model
  const effort = meta?.reasoningEffort ?? ref.reasoningEffort
  return [
    hostLabel,
    shortPath(meta?.cwd || ref.cwd),
    model ? `${model}${effort ? ` ${effort}` : ''}` : null,
  ].filter(Boolean).join(' · ')
}

/** Display title: the CLI slug wins once the indexer has it. */
export function relayTitle(ref: RelayRef, meta: SessionMeta | undefined): string {
  return meta?.slug || ref.title
}
