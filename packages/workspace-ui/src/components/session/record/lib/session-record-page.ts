import type { SessionMeta } from '@solus/contracts/types'
import { conversationProjectLabel, conversationTitle } from '../../unified-picker/lib/picker-rows'
import { relativeTime } from '../../../../lib/relative-time'

/** The header of a read-only session record: what the record itself carries. */
export interface SessionRecordHeader {
  title: string
  /** "claude-code · solus · 2h ago", with what the record knows. */
  meta: string
}

export function sessionRecordHeader(meta: SessionMeta): SessionRecordHeader {
  const at = new Date(meta.lastTimestamp).getTime()
  return {
    title: conversationTitle(meta),
    meta: [meta.provider, conversationProjectLabel(meta), Number.isFinite(at) && at > 0 ? relativeTime(at) : null]
      .filter((part): part is string => !!part)
      .join(' · '),
  }
}
