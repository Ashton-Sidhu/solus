import type { SessionMeta } from '@solus/contracts/types'
import type { HostPhase } from '@solus/client-core/host-supervisor'
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
 * Whether the record page is waiting on its runner (docs/plans/instant-share-open.md):
 * `connecting` while this client is dialing the machine the record names, or has
 * reached it and is opening the live session; `away` when this client keeps no such
 * machine, does not dial it, or its dials failed or were refused. Only `away` is read
 * only: a page that says so while the runner is coming is a stale label.
 */
export type RecordRunnerState = 'connecting' | 'away'

export function recordRunnerState(savedRunnerId: string | null, phase: HostPhase | undefined): RecordRunnerState {
  return savedRunnerId && (phase === 'connecting' || phase === 'reconnecting' || phase === 'connected') ? 'connecting' : 'away'
}
