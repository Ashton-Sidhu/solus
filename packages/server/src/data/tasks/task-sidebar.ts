import type { TaskSidebarSnapshot, TaskSidebarPrLink } from '@solus/contracts/task-types'
import { getDatabase } from '../../db/database'
import type { RecordScope } from '../../admission/principal'
import { readTaskPrLinks } from './task-links'
import { listTasks } from './task-store'
import { taskSessions } from './task-sessions'

/** One task-data and host-memory read boundary for boot and reconnect. No provider reads.
 *  `taskIds` narrows the read to the tasks a `tasks.invalidated` event named. */
export async function readTaskSidebarSnapshot(scope: RecordScope, taskIds?: readonly string[]): Promise<TaskSidebarSnapshot> {
  const prLinkListsByTask = await readTaskPrLinks(getDatabase(), scope, taskIds)
  const prLinksByTask: Record<string, TaskSidebarPrLink> = {}
  for (const [taskId, links] of Object.entries(prLinkListsByTask)) {
    if (links[0]) prLinksByTask[taskId] = links[0]
  }
  return {
    tasks: (await listTasks(scope, {}, taskIds)).tasks,
    sessionsByTask: await taskSessions(scope, taskIds),
    prLinksByTask,
    prLinkListsByTask,
  }
}
