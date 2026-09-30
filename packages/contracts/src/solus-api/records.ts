import type { Task } from '../task-types'
import type { Work, WorkMeta, SessionRecord } from '../types'
import type { WorkspaceTask, WorkspaceWork, WorkspaceWorkSummary, WorkspaceSession } from './schemas'

/** The established client records, read from the HTTP contract. */
export function taskRecord(task: WorkspaceTask): Task {
  return { ...task, providerId: 'local', organizationId: task.organizationId ?? 'local', url: null,
    shortId: task.shortId ?? undefined, assignee: task.assignee ?? undefined, priority: task.priority ?? undefined,
    dueDate: task.dueDate ?? undefined, originSessionId: task.originSessionId ?? undefined,
    createdAt: Date.parse(task.createdAt), updatedAt: Date.parse(task.updatedAt), canEditPlanningFields: true }
}
export function workRecord(work: WorkspaceWork): Work {
  return { ...work, organizationId: work.organizationId ?? 'local', sessionId: work.sessionIds[0] }
}
export function workSummary(work: WorkspaceWorkSummary): WorkMeta & { id: string } {
  return { ...work, organizationId: work.organizationId ?? 'local', sessionId: work.sessionIds[0] }
}
export function sessionRecord(session: WorkspaceSession): SessionRecord {
  return { ...session, sessionId: session.id, organizationId: session.organizationId ?? 'local',
    createdAt: Date.parse(session.createdAt), lastActivityAt: Date.parse(session.updatedAt) }
}
