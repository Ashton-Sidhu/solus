import type { SessionMeta } from '@solus/contracts/types'
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
