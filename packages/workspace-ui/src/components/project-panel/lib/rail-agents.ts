// Shaping for the rail's Agents card (T3 Code's Lineage panel): every agent the
// session has dispatched, as one list — the sub-agents that run inside this
// session and the Solus sessions it started. While any run, settled ones fold
// under "Previous agents"; once none run, the settled ones are the list. Per the renderer rules the .svelte holds markup and
// thin handlers; the reading of each row lives here.
import type { AgentConversationRef, AgentId, Message, SessionMeta, SessionRecordStatus } from '@solus/contracts/types'
import type { DigestSubagent, DigestTurn, DigestWorkflow, SessionTree } from '@solus/contracts/session-digest'
import { nodeTitle } from '@solus/client-core/session-tree'
import {
  subagentRow,
  type SubagentModelFallback,
} from '../../conversation/lib/subagent-group'
import { subagentLinkStatus, type AgentLinkTone } from '../../conversation/lib/agent-link'
import {
  agentConversationCardState,
  agentConversationElapsedMs,
  agentConversationLink,
  agentConversationTitle,
  isPendingAgent,
  provenanceLine,
} from '../../conversation/agent-conversation/lib/agent-conversation'

/** The messages that carry an agent: a tool call with a nested transcript (a
 *  sub-agent — the same rule the conversation uses to draw one), or a card for
 *  a session this one started or messaged. */
export function sessionAgentMessages(messages: Message[]): Message[] {
  return messages.filter(
    (message) => (message.role === 'tool' && !!message.subMessages) || !!message.agentConversationRef,
  )
}

export interface RailAgentRow {
  /** Unique across both kinds, for keyed rendering. */
  key: string
  kind: 'subagent' | 'session'
  /** The sub-agent's message id, or the started session's id. */
  id: string
  title: string
  /** Null for a session whose host keeps no record of it. */
  provider: AgentId | null
  tone: AgentLinkTone
  /** One or two words: `Running`, `Completed`, `Failed`. */
  status: string
  elapsedMs: number
  /** What the agent is on or came back with, in one line. Empty when nothing is known yet. */
  detail: string
  /** The hover: the title, then what the agent is on or came back with. */
  tooltip: string
  /** The session card behind a `session` row: what Open and Stop act on. */
  ref: AgentConversationRef | null
  /** Nothing to open or stop yet: the session's provider has not started. */
  pending: boolean
  /** When the session dispatched it: a sub-agent's call, or the first card of a started session. */
  startedAt: number
}

export interface RailAgentList {
  /** Every in-flight agent, newest first. */
  active: RailAgentRow[]
  /** Settled agents, newest first: the report just landed is nearest the top. */
  previous: RailAgentRow[]
  /** The header's reading: `2 running` while any run, else `3 done · 1 failed`. */
  detail: string
}

export interface RailAgentContext {
  fallback: SubagentModelFallback
  /** The index's record of a started session: its slug title and provider. */
  metaFor: (sessionId: string) => SessionMeta | undefined
  /** The host the sessions live on, when it is not this device. */
  hostLabel: string | null
}

export function railAgentTooltip(title: string, status: string, detail: string): string {
  return detail ? `${title}\n${status} · ${detail}` : `${title}\n${status}`
}

export type TreeAgentRow = {
  key: string
  id: string
  title: string
  provider: AgentId
  tone: AgentLinkTone
  status: string
  detail: string
  startedAt: number
  endedAt: number | null
} & (
  | { kind: 'subagent'; canStop: boolean; workflow?: DigestWorkflow }
  | { kind: 'session'; serverId: string; cwd: string; isRemote: boolean }
)

const SUBAGENT_STATUS = {
  running: { tone: 'live', status: 'Running' },
  completed: { tone: 'done', status: 'Completed' },
  failed: { tone: 'failed', status: 'Failed' },
  stopped: { tone: 'idle', status: 'Stopped' },
} as const satisfies Record<DigestSubagent['status'], { tone: AgentLinkTone; status: string }>

function childSessionStatus(status: SessionRecordStatus, lastTurn: DigestTurn | undefined): Pick<TreeAgentRow, 'tone' | 'status'> {
  if (status === 'interrupted') return { tone: 'idle', status: 'Interrupted' }
  if (status === 'running' || lastTurn?.settled === false) return SUBAGENT_STATUS.running
  switch (lastTurn?.outcome) {
    case 'completed': return SUBAGENT_STATUS.completed
    case 'failed':
    case 'dead': return SUBAGENT_STATUS.failed
    case 'interrupted': return { tone: 'idle', status: 'Interrupted' }
    default: return { tone: 'idle', status: 'Idle' }
  }
}

/** Direct delegates and the session's own provider sub-agents. A child lists its own agents when opened. */
export function treeAgentRows(tree: SessionTree | null, sessionId: string, serverId: string): TreeAgentRow[] {
  const rows: TreeAgentRow[] = []
  for (const { record, digest } of tree?.nodes ?? []) {
    if (record.sessionId === sessionId) {
      for (const subagent of digest?.subagents ?? []) {
        rows.push({
          key: `subagent:${subagent.id}`,
          kind: 'subagent',
          id: subagent.id,
          title: subagent.title,
          provider: record.provider,
          detail: subagent.detail,
          startedAt: subagent.startedAt,
          endedAt: subagent.endedAt,
          canStop: subagent.canStop === true,
          workflow: subagent.workflow,
          ...SUBAGENT_STATUS[subagent.status],
        })
      }
    } else if (record.parentSessionId === sessionId) {
      const lastTurn = digest?.turns.at(-1)
      const state = childSessionStatus(record.status, lastTurn)
      rows.push({
        key: `session:${record.sessionId}`,
        kind: 'session',
        id: record.sessionId,
        title: nodeTitle(record),
        provider: record.provider,
        serverId: record.runnerHostId ?? serverId,
        isRemote: record.runnerHostId !== null,
        cwd: record.cwd ?? '',
        detail: digest?.lastReply ?? '',
        startedAt: record.createdAt,
        endedAt: state.tone === 'live' ? null : (lastTurn?.endedAt ?? record.lastActivityAt),
        ...state,
      })
    }
  }
  return rows.sort((a, b) => b.startedAt - a.startedAt)
}

export function workflowPhases(workflow: DigestWorkflow) {
  const phases = new Map<number, { title: string; agents: DigestWorkflow['agents'] }>()
  const other: DigestWorkflow['agents'] = []
  for (const phase of workflow.phases) phases.set(phase.index, { title: phase.title, agents: [] })
  for (const agent of workflow.agents) {
    if (agent.phaseIndex === undefined) {
      other.push(agent)
      continue
    }
    let phase = phases.get(agent.phaseIndex)
    if (!phase) {
      phase = { title: agent.phaseTitle || `Phase ${agent.phaseIndex + 1}`, agents: [] }
      phases.set(agent.phaseIndex, phase)
    }
    phase.agents.push(agent)
  }
  const groups = [...phases].sort(([a], [b]) => a - b).map(([index, phase]) => ({ index, ...phase }))
  if (other.length) groups.push({ index: -1, title: 'Agents', agents: other })
  return groups
}

function subagentAgentRow(message: Message, now: number, context: RailAgentContext): RailAgentRow {
  const row = subagentRow(message, now, context.fallback)
  const link = subagentLinkStatus(row.state)
  const detail = [row.activity, row.target].filter(Boolean).join(' ')
  return {
    key: `subagent:${row.id}`,
    kind: 'subagent',
    id: row.id,
    title: row.name,
    provider: row.provider,
    tone: link.tone,
    status: link.label,
    elapsedMs: row.elapsedMs,
    detail,
    tooltip: railAgentTooltip(row.name, link.label, detail),
    ref: null,
    pending: false,
    startedAt: message.timestamp,
  }
}

function sessionAgentRow(ref: AgentConversationRef, startedAt: number, now: number, context: RailAgentContext): RailAgentRow {
  const meta = context.metaFor(ref.sessionId)
  const pending = isPendingAgent(ref)
  const link = agentConversationLink(ref, agentConversationCardState(ref), pending)
  const title = agentConversationTitle(ref, meta)
  const provenance = provenanceLine(ref, meta, context.hostLabel)
  return {
    key: `session:${ref.sessionId}`,
    kind: 'session',
    id: ref.sessionId,
    title,
    provider: meta?.provider ?? ref.provider,
    tone: link.tone,
    status: link.label,
    elapsedMs: agentConversationElapsedMs(ref, now),
    detail: link.detail,
    tooltip: railAgentTooltip(title, link.label, [link.detail, provenance].filter(Boolean).join(' · ')),
    ref,
    pending,
    startedAt,
  }
}

export function railAgentList(messages: Message[], now: number, context: RailAgentContext): RailAgentList {
  // A session the conversation talks to across turns has one card per turn;
  // the last one says where it stands now, the first one when it started.
  const sessions = new Map<string, { ref: AgentConversationRef; startedAt: number }>()
  const rows: RailAgentRow[] = []
  for (const message of messages) {
    const ref = message.agentConversationRef
    if (ref) {
      const startedAt = sessions.get(ref.sessionId)?.startedAt ?? message.timestamp
      sessions.set(ref.sessionId, { ref, startedAt })
    } else {
      rows.push(subagentAgentRow(message, now, context))
    }
  }
  for (const { ref, startedAt } of sessions.values()) {
    rows.push(sessionAgentRow(ref, startedAt, now, context))
  }
  const ordered = rows.sort((a, b) => b.startedAt - a.startedAt)
  const active = ordered.filter((row) => row.tone === 'live')
  const previous = ordered.filter((row) => row.tone !== 'live')
  const failed = previous.filter((row) => row.tone === 'failed').length
  const done = previous.length - failed
  return {
    active,
    previous,
    detail:
      active.length > 0
        ? `${active.length} running`
        : [done > 0 ? `${done} done` : '', failed > 0 ? `${failed} failed` : ''].filter(Boolean).join(' · '),
  }
}

/** Short form for a narrow row: `45s`, `12m`, `1.5h`, `14h`. Rounds down. */
export function formatCompactElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  if (minutes >= 600) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 6) / 10}h`
}

/** A long lineage shows a workable window; the rest waits behind Show more. */
export const RAIL_AGENTS_INITIAL_COUNT = 6
export const RAIL_AGENTS_PAGE_COUNT = 12
