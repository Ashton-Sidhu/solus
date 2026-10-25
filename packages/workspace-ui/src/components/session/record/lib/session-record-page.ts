import type { SessionMeta } from '@solus/contracts/types'
import { hostReadinessCopy, isWaitingForHost, type HostReadinessState } from '@solus/client-core/host-readiness'
import { conversationProjectLabel, conversationTitle } from '../../unified-picker/lib/picker-rows'
import { relativeTime } from '../../../../lib/relative-time'
import { agentLabel } from '../../../../lib/agentAvailability'

/** The header of a read-only session record: what the record itself carries,
 *  one fact per field so the page can draw each beside its icon. */
export interface SessionRecordHeader {
  title: string
  agent: string
  /** The agent's mark, where Solus has one to draw. */
  agentMark: 'claude' | 'codex' | null
  project: string
  /** "5d ago"; null when the record has no usable time. */
  activeAgo: string | null
}

export function sessionRecordHeader(meta: SessionMeta): SessionRecordHeader {
  const at = new Date(meta.lastTimestamp).getTime()
  return {
    title: conversationTitle(meta),
    agent: agentLabel(meta.provider),
    agentMark: meta.provider === 'claude-code' ? 'claude' : meta.provider === 'codex' ? 'codex' : null,
    project: conversationProjectLabel(meta),
    activeAgo: Number.isFinite(at) && at > 0 ? relativeTime(at) : null,
  }
}

/**
 * Whether the record page waits on its runner, and what it says in place of a
 * prompt (docs/plans/instant-share-open.md, docs/plans/host-readiness.md). It
 * waits while this client keeps the machine the record names and that machine
 * is ready or inside its grace: a ready one is opening the live session. Any
 * other state is read only, and the note says the runner's state.
 */
export interface RecordRunner {
  waits: boolean
  note: string
}

export function recordRunner(runner: { label: string; state: HostReadinessState } | null): RecordRunner {
  if (!runner) return { waits: false, note: 'Read only: the machine that ran this session is not on this device.' }
  const { readiness } = runner.state
  if (readiness === 'ready' || isWaitingForHost(readiness)) {
    return { waits: true, note: `Opening this session on ${runner.label}…` }
  }
  return { waits: false, note: `Read only: ${hostReadinessCopy(runner.state, runner.label).headline}.` }
}
