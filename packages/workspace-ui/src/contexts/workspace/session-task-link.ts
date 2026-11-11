import type { Task } from '@solus/contracts/task-types'
import { existingTaskId } from './session-draft.svelte'
import type { WorkspaceContext } from './workspace.context.svelte'
import { projectHome, projectRoot, runHost } from './run-location'

/** The workspace members these commands read or call, and no others. */
type SessionTaskLinkWorkspace = Pick<WorkspaceContext, 'sessionFor' | 'tasksStore'>

/**
 * The task a mounted session belongs to: the task that links it, or, before
 * its first prompt, the task it will join. Null for a session with no task.
 */
export function taskOfTab(workspace: SessionTaskLinkWorkspace, tabId: string): Task | null {
  const session = workspace.sessionFor(tabId)
  if (!session) return null
  return workspace.tasksStore.taskForSession(session.id) ?? workspace.tasksStore.peek(existingTaskId(session.task))
}

/**
 * Link a mounted session to a task, now. A session link is an attachment: it
 * needs only the task key. A session that has not started is only aimed at
 * the task: its first prompt makes the link.
 */
export async function linkTabToTask(workspace: SessionTaskLinkWorkspace, tabId: string, task: Task): Promise<void> {
  const session = workspace.sessionFor(tabId)
  if (!session) return
  const model = workspace.tasksStore.get(task.id)
  const sessionId = session.id
  if (session.agentSessionId) {
    const taskServerId = model.serverId ?? projectHome(session.run).serverId
    // Where the agent ran, when that is not the task's own host.
    const execution = runHost(session.run) === taskServerId
      ? null
      : {
          serverId: runHost(session.run),
          provider: session.run.provider ?? undefined,
          projectRoot: projectRoot(session.run),
        }
    await model.linkSession(sessionId, execution, taskServerId)
  }
  session.task = { kind: 'existing', taskId: task.id }
}

/** Take a mounted session out of its task. The session keeps its pull
 *  requests; the task stops reading them. */
export async function unlinkTabFromTask(workspace: SessionTaskLinkWorkspace, tabId: string): Promise<void> {
  const session = workspace.sessionFor(tabId)
  const task = taskOfTab(workspace, tabId)
  if (!session || !task) return
  const model = workspace.tasksStore.get(task.id)
  if (model.sessions.some((link) => link.sessionId === session.id)) await model.unlinkSession(session.id)
  session.task = { kind: 'none' }
}
