import type { Work, WorkListingMeta, SessionRecord } from '../types'
import type { WorkspaceWork, WorkspaceWorkSummary, WorkspaceSession } from './schemas'

/** The established client records, read from the HTTP contract. */
export function workRecord(work: WorkspaceWork): Work {
  return { ...work, organizationId: work.organizationId ?? 'local', sessionId: work.sessionIds[0] }
}
export function workSummary(work: WorkspaceWorkSummary): WorkListingMeta {
  return { ...work, organizationId: work.organizationId ?? 'local', sessionId: work.sessionIds[0] }
}
export function sessionRecord(session: WorkspaceSession): SessionRecord {
  return { ...session, sessionId: session.id, organizationId: session.organizationId ?? 'local',
    createdAt: Date.parse(session.createdAt), lastActivityAt: Date.parse(session.updatedAt) }
}
