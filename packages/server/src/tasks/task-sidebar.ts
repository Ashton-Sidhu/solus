import type { TaskSidebarSnapshot, TaskSidebarPrLink } from '@solus/contracts/task-types'
import { getDatabase } from '../db/database'
import { readTaskPrLinks } from './task-links'
import { listTasks } from './task-store'
import { taskSessions } from './task-sessions'

/** One task-data and host-memory read boundary for boot and reconnect. No provider reads. */
export async function readTaskSidebarSnapshot(): Promise<TaskSidebarSnapshot> {
  const prLinkListsByTask = await readTaskPrLinks(getDatabase())
  const prLinksByTask: Record<string, TaskSidebarPrLink> = {}
  for (const [taskId, links] of Object.entries(prLinkListsByTask)) {
    if (links[0]) prLinksByTask[taskId] = links[0]
  }
  return { tasks: (await listTasks()).tasks, sessionsByTask: await taskSessions(), prLinksByTask, prLinkListsByTask }
}
