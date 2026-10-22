import { randomBytes } from 'node:crypto'

/**
 * The change log a client resumes the task list from after it connects again
 * (docs/plans/task-snapshot-resume.md). It is process memory: a new process
 * has a new boot id, so a revision from before a restart never resumes.
 *
 * It keeps the last change of each task, and of each indexed session, because
 * a task row shows the title, branch, and activity of its linked sessions. A
 * session that changes on every turn costs one map entry, not one per turn.
 */

/** The most ids kept per kind. When an older id is dropped, a revision before
 *  its change can no longer resume. */
const KEPT_IDS = 4096
const bootId = randomBytes(8).toString('hex')
let changeNumber = 0
/** A revision before this number cannot resume: a dropped id changed then. */
let oldestResumable = 0
/** The last change that named no task. */
let lastUnnamedChange = 0
/** The last change number of each id, oldest first. */
const taskChanges = new Map<string, number>()
const sessionChanges = new Map<string, number>()

function remember(changes: Map<string, number>, id: string): void {
  changes.delete(id)
  changes.set(id, ++changeNumber)
  if (changes.size <= KEPT_IDS) return
  const oldest = changes.entries().next()
  if (oldest.done) return
  const [droppedId, droppedAt] = oldest.value
  changes.delete(droppedId)
  oldestResumable = Math.max(oldestResumable, droppedAt)
}

/** Count one committed task change. Call it after the commit, never before:
 *  a revision read before the commit must not cover the change. */
export function recordTaskChange(taskId?: string): void {
  if (taskId) remember(taskChanges, taskId)
  else lastUnnamedChange = ++changeNumber
}

/** Count one write to a session's index row or lineage. `sessionId` is the
 *  stable id or a provider thread id; a resume resolves both to tasks. */
export function recordSessionChange(sessionId: string): void {
  remember(sessionChanges, sessionId)
}

/** The revision of the task list as `readerKey` sees it now. Read it before the
 *  rows, so a change that commits during the read is in the next resume. */
export function taskListRevision(readerKey: string): string {
  return `${bootId}.${changeNumber}.${readerKey}`
}

export interface TaskListChanges {
  taskIds: string[]
  /** Sessions whose display fields changed; the tasks linked to them changed too. */
  sessionIds: string[]
}

/** What changed after `revision`, or null when the log cannot say: another
 *  process or reader, a revision older than the kept changes, or a change that
 *  named no task. */
export function taskListChangesSince(revision: string, readerKey: string): TaskListChanges | null {
  const [revisionBootId, number, revisionReaderKey, extra] = revision.split('.')
  if (extra !== undefined || revisionBootId !== bootId || revisionReaderKey !== readerKey) return null
  const since = Number(number)
  if (!Number.isInteger(since) || since > changeNumber || since < oldestResumable || since < lastUnnamedChange) return null
  const after = (changes: Map<string, number>) => [...changes].filter(([, changedAt]) => changedAt > since).map(([id]) => id)
  return { taskIds: after(taskChanges), sessionIds: after(sessionChanges) }
}
