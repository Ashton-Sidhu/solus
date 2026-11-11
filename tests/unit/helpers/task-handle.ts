import type { TaskLinkInput, TaskLinkKind, TaskSessionRole } from '@solus/contracts/task-types'
import type { Attribution } from '@solus/contracts/user'
import type { TaskPullRequestInput } from '@solus/server/data/tasks/task-attachments'
import type { SessionLinkDetails } from '@solus/server/data/tasks/task-sessions'

let nextTask = 0

/** A new task key for a test. GitHub owns the task; the host needs no copy to attach things to it. */
export function newTaskKey(): string {
  return `github:I_test${++nextTask}`
}

/**
 * The attachments of one task key in one organization, as one object: a test
 * that links several things to one task names the task one time. Imported
 * lazily, because a database test sets its data directory before it loads the
 * server modules.
 */
export async function attachedTask(id: string = newTaskKey(), organizationId = 'local') {
  const attachments = await import('@solus/server/data/tasks/task-attachments')
  type LinkOptions = Pick<TaskLinkInput, 'title' | 'url' | 'originSessionId' | 'automatic' | 'pinned'>
  return {
    id,
    linkSession: (sessionId: string, role: TaskSessionRole = 'working', details: SessionLinkDetails = {}) =>
      attachments.linkTaskSession(organizationId, id, sessionId, role, details),
    unlinkSession: (sessionId: string, by: Attribution) => attachments.unlinkTaskSession(organizationId, id, sessionId, by),
    link: (input: TaskLinkInput, by: Attribution) => attachments.linkTask(organizationId, id, input, by),
    linkWork: (workId: string, by: Attribution, options: LinkOptions = {}) =>
      attachments.linkTask(organizationId, id, { kind: 'work', targetKey: workId, ...options }, by),
    linkPlan: (sessionId: string, planToolUseId: string, by: Attribution, options: LinkOptions = {}) =>
      attachments.linkTask(organizationId, id, { kind: 'plan', targetScope: sessionId, targetKey: planToolUseId, ...options }, by),
    linkAutomation: (automationId: string, by: Attribution, options: LinkOptions = {}) =>
      attachments.linkTask(organizationId, id, { kind: 'automation', targetKey: automationId, ...options }, by),
    linkPullRequest: (input: TaskPullRequestInput, by: Attribution) => attachments.linkTaskPullRequest(organizationId, id, input, by),
    linkWorkingSessionPullRequest: (sessionId: string, input: { url: string; title?: string }, by: Attribution) =>
      attachments.linkWorkingSessionPullRequest(organizationId, id, sessionId, input, by),
    unlink: (kind: TaskLinkKind, targetKey: string, targetScope: string, by: Attribution) =>
      attachments.unlinkTask(organizationId, id, kind, targetKey, targetScope, by),
    links: async () => (await attachments.taskAttachments(organizationId, id)).links,
    /** The links and the activity of the task. */
    details: () => attachments.taskAttachments(organizationId, id),
  }
}
