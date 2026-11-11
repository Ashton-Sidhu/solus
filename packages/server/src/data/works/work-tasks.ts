import type { Work } from '@solus/contracts/types'
import type { RecordScope } from '../../admission/principal'
import { linkSessionOutput } from '../tasks/task-attachments'
import { createLogger } from '../../logger'

const log = createLogger('main', 'work-tasks')

export async function linkWorkToSessionTasks(scope: RecordScope, work: Work): Promise<void> {
  const sessionIds = work.sessionIds ?? (work.sessionId ? [work.sessionId] : [])
  await Promise.all(sessionIds.map((sessionId) => linkSessionOutput(scope, sessionId, {
    kind: 'work',
    targetKey: work.id,
    title: work.title,
  }).catch((error) => {
    log.warn('task_work_link_failed', {
      sessionId,
      workId: work.id,
      error: error instanceof Error ? error.message : String(error),
    })
  })))
}

