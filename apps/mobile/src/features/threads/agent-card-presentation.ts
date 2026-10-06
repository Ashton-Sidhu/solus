// Adapted from T3 Code apps/mobile/src/features/threads/threadAgentsPresentation.ts
// and subagent-card-presentation.ts (MIT, see UPSTREAM.md), on Solus's agents.
import type { AgentExchangeStatus, AgentId, SessionRecord } from '@solus/contracts/types'
import { agentCardStatus, type AgentItem } from '../conversation/lib/agent-cards'
import { modelLabel } from '../conversation/lib/run-settings'
import type { TranscriptItem } from '../conversation/lib/transcript-model'
import { parseToolInput } from './thread-work-log-presentation'

/**
 * One agent row, from either kind of agent a Solus conversation has:
 *
 * - another Solus session it started or messaged (`agent` items). It is a
 *   session of its own, so the row opens it once the host lists it.
 * - a provider-native subagent (a Task/Agent call, Codex's subagent tool). It
 *   runs inside this session and has no session to open, so its row is not a
 *   button.
 */

export type AgentTone = 'working' | 'waiting' | 'completed' | 'failed' | 'stopped'

export interface AgentRowPresentation {
  readonly id: string
  readonly title: string
  readonly statusLabel: string
  readonly tone: AgentTone
  /** Working or waiting: its clock runs and the Agents pill counts it. */
  readonly live: boolean
  /** Progress while live; the reply once settled. */
  readonly detail: string | null
  readonly provider: AgentId | null
  /** "Claude · Opus 4.5", "Codex", or null when nothing is known. */
  readonly meta: string | null
  /** Where it works, when that is not where this conversation works: its
   *  project, then its branch, worktree or folder (T3's `resolveSubagentMetadata`). */
  readonly workspace: readonly { readonly label: 'Project' | 'Branch' | 'Worktree' | 'Workspace'; readonly value: string }[]
  /** The session a tap opens; null when there is none to open (yet). */
  readonly sessionId: string | null
  /** Why a row has no session to open, for the accessibility hint. */
  readonly unopenableReason: string | null
  readonly startedAt: number | null
  /** Null while live, or when the end is unknown. */
  readonly endedAt: number | null
}

const DETAIL_LIMIT = 280

const PROVIDER_NAMES: { readonly [provider in AgentId]?: string } = { 'claude-code': 'Claude', codex: 'Codex', opencode: 'OpenCode' }

const EXCHANGE_LABEL: { readonly [status in AgentExchangeStatus]: string } = {
  dispatched: 'Starting',
  queued: 'Queued',
  running: 'Working',
  answered: 'Working',
  waiting_for_children: 'Waiting on agents',
  awaiting_input: 'Needs input',
  rate_limited: 'Rate limited',
  done: 'Completed',
  failed: 'Failed',
  interrupted: 'Stopped',
  // The host no longer carries it: a restart ended it, or its receipt expired.
  lost: 'Not tracked',
}

const EXCHANGE_TONE: { readonly [status in AgentExchangeStatus]: AgentTone } = {
  dispatched: 'working',
  queued: 'working',
  running: 'working',
  answered: 'working',
  waiting_for_children: 'working',
  awaiting_input: 'waiting',
  rate_limited: 'waiting',
  done: 'completed',
  failed: 'failed',
  interrupted: 'stopped',
  lost: 'stopped',
}

function compactDetail(text: string | null | undefined): string | null {
  const compact = text?.replace(/\s+/g, ' ').trim()
  if (!compact) return null
  return compact.length > DETAIL_LIMIT ? `${compact.slice(0, DETAIL_LIMIT).trimEnd()}…` : compact
}

function metaLine(provider: AgentId | null, model: string | null): string | null {
  const name = provider ? PROVIDER_NAMES[provider] ?? provider : null
  const modelName = provider && model ? modelLabel(provider, model) : model
  return [name, modelName].filter(Boolean).join(' · ') || null
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path
}

type WorkspaceRecord = Pick<SessionRecord, 'cwd' | 'projectRoot' | 'branch' | 'isWorktree'>

/** The child's place, read from the host's records of both sessions. Nothing
 *  shows when either is unknown or both work in the same folder. */
export function agentWorkspace(child: WorkspaceRecord | null, parent: WorkspaceRecord | null): AgentRowPresentation['workspace'] {
  if (!child || !parent) return []
  const workspace: Array<AgentRowPresentation['workspace'][number]> = []
  if (child.projectRoot && parent.projectRoot && child.projectRoot !== parent.projectRoot) {
    workspace.push({ label: 'Project', value: basename(child.projectRoot) })
  }
  if (child.cwd && parent.cwd && child.cwd !== parent.cwd) {
    workspace.push(child.branch
      ? { label: 'Branch', value: child.branch }
      : { label: child.isWorktree ? 'Worktree' : 'Workspace', value: basename(child.cwd) })
  }
  return workspace
}

function subagentProvider(type: string): AgentId | null {
  if (type === 'claude') return 'claude-code'
  if (type === 'codex') return 'codex'
  return null
}

/** `child`: the host's record of the other session, when it lists it;
 *  `parent`: this conversation's own record. */
export function sessionAgentPresentation(item: AgentItem, child: SessionRecord | null, parent: SessionRecord | null = null): AgentRowPresentation {
  const status = agentCardStatus(item)
  const tone = EXCHANGE_TONE[status]
  const live = tone === 'working' || tone === 'waiting'
  const provider = child?.provider ?? item.provider
  return {
    id: item.id,
    // The host's name for the session wins: a generated or typed title.
    title: child?.customTitle || child?.title || item.title,
    statusLabel: EXCHANGE_LABEL[status],
    tone,
    live,
    detail: compactDetail(live ? item.prompt : item.reply ?? item.prompt),
    provider,
    meta: metaLine(provider, child?.model ?? item.model),
    workspace: agentWorkspace(child, parent),
    sessionId: child?.sessionId ?? null,
    unopenableReason: child ? null : 'The host has not listed this session yet.',
    startedAt: item.startedAt,
    endedAt: live ? null : item.durationMs !== null ? item.startedAt + item.durationMs : item.settledAt,
  }
}

export function subagentPresentation(tool: Extract<TranscriptItem, { kind: 'tool' }>): AgentRowPresentation {
  const parsed = parseToolInput(tool.input)
  const prompt = parsed?.prompt ?? null
  const live = tool.status === 'running'
  const provider = tool.subagent ? subagentProvider(tool.subagent) : null
  const steps = tool.childCount ? ` · ${tool.childCount} ${tool.childCount === 1 ? 'step' : 'steps'}` : ''
  return {
    id: tool.id,
    title: compactDetail(parsed?.description) ?? compactDetail(prompt)?.slice(0, 80) ?? 'Subagent',
    statusLabel: (live ? 'Working' : tool.status === 'error' ? 'Failed' : 'Completed') + steps,
    tone: live ? 'working' : tool.status === 'error' ? 'failed' : 'completed',
    live,
    detail: compactDetail(tool.report ?? tool.errorHead ?? (live ? prompt : null)),
    provider,
    meta: metaLine(provider, null),
    // It works in this session's own folder.
    workspace: [],
    sessionId: null,
    unopenableReason: 'Runs inside this session; its work is in this transcript.',
    startedAt: null,
    endedAt: null,
  }
}

export function agentPresentation(item: TranscriptItem, child: SessionRecord | null, parent: SessionRecord | null = null): AgentRowPresentation | null {
  if (item.kind === 'agent') return sessionAgentPresentation(item, child, parent)
  if (item.kind === 'tool' && item.subagent) return subagentPresentation(item)
  return null
}

/** "2 working · 1 done", in a fixed order. */
export function summarizeAgents(rows: readonly Pick<AgentRowPresentation, 'tone'>[]): string {
  const counts: { [tone in AgentTone]: number } = { working: 0, waiting: 0, completed: 0, failed: 0, stopped: 0 }
  for (const row of rows) counts[row.tone] += 1
  const words: { [tone in AgentTone]: string } = { working: 'working', waiting: 'waiting', completed: 'done', failed: 'failed', stopped: 'stopped' }
  return (Object.keys(counts) as AgentTone[])
    .filter((tone) => counts[tone] > 0)
    .map((tone) => `${counts[tone]} ${words[tone]}`)
    .join(' · ')
}

/** Wall time from the first start to the last end, or to now while any runs. */
export function agentsElapsedMs(rows: readonly Pick<AgentRowPresentation, 'live' | 'startedAt' | 'endedAt'>[], nowMs: number): number | null {
  const starts = rows.flatMap((row) => (row.startedAt === null ? [] : [row.startedAt]))
  if (starts.length === 0) return null
  const live = rows.some((row) => row.live)
  // A settled agent without an end must not keep counting its age.
  if (!live && rows.some((row) => row.startedAt !== null && row.endedAt === null)) return null
  const ends = rows.flatMap((row) => (row.endedAt === null ? [] : [row.endedAt]))
  const end = live ? nowMs : Math.max(...ends)
  const duration = end - Math.min(...starts)
  return duration > 0 ? duration : null
}

export function formatAgentElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The Agents pill: "2/3" while some run, "3 done" after; null without agents. */
export function agentsPillLabel(rows: readonly Pick<AgentRowPresentation, 'live'>[], turnActive: boolean): { label: string; accessibilityLabel: string } | null {
  if (rows.length === 0) return null
  const live = rows.filter((row) => row.live).length
  if (!turnActive && live === 0) return null
  if (live > 0) return { label: `${live}/${rows.length}`, accessibilityLabel: `${live} of ${rows.length} agents working` }
  return { label: `${rows.length} done`, accessibilityLabel: `${rows.length} ${rows.length === 1 ? 'agent' : 'agents'} done` }
}
