import type { SessionMeta, SessionRecord } from './types'

/**
 * A session as its record describes it, in the shape every session surface
 * reads. The record is the one answer about a session in every home — a
 * machine's own and the organization's workspace service — so this is the only
 * place the two shapes meet. `serverId` names the runner as the record knows
 * it; a client stamps its own name for the host where the row enters.
 */
export function sessionMetaFromRecord(record: SessionRecord): SessionMeta {
  const { delegation, parentSessionId, rootSessionId } = record
  return {
    provider: record.provider,
    sessionId: record.sessionId,
    slug: record.slug,
    firstMessage: record.title,
    customTitle: record.customTitle ?? undefined,
    lastTimestamp: new Date(record.lastActivityAt).toISOString(),
    size: record.size,
    cwd: record.cwd ?? '',
    projectPath: record.projectPath,
    serverId: record.runnerHostId ?? undefined,
    isWorktree: record.isWorktree,
    status: record.status,
    model: record.model ?? undefined,
    reasoningEffort: record.reasoningEffort ?? undefined,
    projectRoot: record.projectRoot ?? undefined,
    branch: record.branch ?? undefined,
    delegation: delegation && parentSessionId && rootSessionId
      ? { ...delegation, parentSessionId, rootSessionId }
      : undefined,
  }
}
