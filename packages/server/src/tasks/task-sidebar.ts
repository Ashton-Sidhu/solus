import type { TaskSidebarSnapshot, TaskSidebarPrLink } from '@solus/contracts/task-types'
import { getDb } from '../db'
import { readTaskPrLinks } from './task-links'
import { listTasks } from './task-store'
import { taskSessions } from './task-sessions'

/** One synchronous task-data and host-memory read boundary for boot and reconnect. No provider reads. */
export function readTaskSidebarSnapshot(): TaskSidebarSnapshot {
  const prLinkListsByTask = readTaskPrLinks(getDb())
  const prLinksByTask: Record<string, TaskSidebarPrLink> = {}
  for (const [taskId, links] of Object.entries(prLinkListsByTask)) {
    if (links[0]) prLinksByTask[taskId] = links[0]
  }
  return { tasks: listTasks().tasks, sessionsByTask: taskSessions(), prLinksByTask, prLinkListsByTask }
}
