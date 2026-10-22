import type { TaskSidebarSnapshot } from '@solus/contracts/task-types'
import { getDatabase } from '../../db/database'
import type { RecordScope } from '../../admission/principal'
import { readTaskPrLinks } from './task-links'
import { listTasks } from './task-store'
import { taskSessions } from './task-sessions'

/** One task-data and host-memory read boundary for boot and reconnect. No provider reads.
 *  `taskIds` narrows the read to the tasks a `tasks.invalidated` event named. */
export async function readTaskSidebarSnapshot(scope: RecordScope, taskIds?: readonly string[]): Promise<TaskSidebarSnapshot> {
  return {
    tasks: (await listTasks(scope, {}, taskIds)).tasks,
    sessionsByTask: await taskSessions(scope, taskIds),
    prLinkListsByTask: await readTaskPrLinks(getDatabase(), scope, taskIds),
  }
}
