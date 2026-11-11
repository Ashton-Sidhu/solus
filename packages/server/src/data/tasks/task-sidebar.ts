import type { TaskSidebarSnapshot } from '@solus/contracts/task-types'
import { getDatabase } from '../../db/database'
import { readTaskPrLinks } from './task-links'
import { listTasks, type TaskReader } from './task-store'
import { taskSessions } from './task-sessions'

/**
 * One read boundary for boot and reconnect. No provider reads. The tasks are
 * the ones the reader sees (`listTasks`). The session links and the pull
 * request links are the ones of the reader's scope, also for a task key that
 * has no copy on this host: a host can hold the links of a task it never read.
 * `taskIds` narrows the read to the tasks a `tasks.invalidated` event named.
 */
export async function readTaskSidebarSnapshot(reader: TaskReader, taskIds?: readonly string[]): Promise<TaskSidebarSnapshot> {
  return {
    tasks: await listTasks(reader, taskIds),
    sessionsByTask: await taskSessions(reader.scope, taskIds),
    prLinkListsByTask: await readTaskPrLinks(getDatabase(), reader.scope, taskIds),
  }
}
