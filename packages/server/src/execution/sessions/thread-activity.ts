import type { Activity, ActivityKind } from '@solus/contracts/activity'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import type { SessionLineageMember } from '@solus/contracts/types'
import { LINEAGE_SWITCH_ID_PREFIX } from '../../data/activity/activity'
import { getIndexedSession } from '../../db/session-indexer'

/**
 * What a session's history shows about its thread itself (plans/012 §5): where
 * a fork came from, and a provider handoff.
 */

/** A fork of `sourceThreadId`, named as the source reads now. */
export function forkedFrom(sourceThreadId: string, midRun: boolean | undefined): ActivityKind {
  const source = getIndexedSession(sourceThreadId)
  const title = source?.customTitle || source?.slug || source?.firstMessage?.slice(0, 80)
  const forked: Extract<ActivityKind, { kind: 'forked' }> = { kind: 'forked', sourceSessionId: sourceThreadId }
  if (title) forked.sourceTitle = title
  if (midRun) forked.midRun = true
  return forked
}

/**
 * A provider handoff as the session's lineage holds it, drawn as the
 * `agent_switched` activity a switch now records (plans/012 §5). It stays for
 * sessions switched before that record existed; the history read drops it
 * where the switch has its recorded activity, so a switch shows once.
 */
export function lineageSwitchDivider(sessionId: string, previous: SessionLineageMember, member: SessionLineageMember): SessionLoadMessage {
  const activity: Activity = {
    id: `${LINEAGE_SWITCH_ID_PREFIX}${sessionId}:${member.position}`,
    subject: { kind: 'session', id: sessionId },
    at: member.startedAt,
    // Who switched is not in the lineage.
    by: { kind: 'system' },
    kind: 'agent_switched',
    provider: member.provider,
    fromProvider: previous.provider,
  }
  const model = modelOf(member)
  const fromModel = modelOf(previous)
  if (model) activity.model = model
  if (fromModel) activity.fromModel = fromModel
  return { messageId: activity.id, role: 'system', content: '', activity, timestamp: member.startedAt }
}

function modelOf(member: SessionLineageMember): string | undefined {
  return member.providerSessionId ? getIndexedSession(member.providerSessionId)?.model : undefined
}
