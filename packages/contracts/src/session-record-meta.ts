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
  const meta: SessionMeta = {
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
    organizationId: record.organizationId,
    publication: record.publication,
  }
  if (record.place) meta.place = record.place
  if (record.startedBy) meta.startedBy = record.startedBy
  if (record.isLead) meta.isLead = true
  if (record.view?.archivedAt != null) meta.archived = true
  // The host answers `owner` only to the session's owner (access.ts `standingOf`).
  if (record.role && record.role !== 'owner' && record.role !== 'none') meta.shared = true
  return meta
}
