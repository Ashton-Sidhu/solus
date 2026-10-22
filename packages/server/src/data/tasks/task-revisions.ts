import { randomBytes } from 'node:crypto'

/**
 * The change log a client resumes the task list from after it connects again
 * (docs/plans/task-snapshot-resume.md). It is process memory: a new process
 * has a new boot id, so a revision from before a restart never resumes.
 */

/** The most changes kept. A client that was away for more reads the whole list. */
const KEPT_CHANGES = 2048
const bootId = randomBytes(8).toString('hex')
let changeNumber = 0
/** The task each kept change named, oldest first; null for a change that named
 *  no task. The last entry is change `changeNumber`. */
const changes: (string | null)[] = []

/** Count one committed task change. Call it after the commit, never before:
 *  a revision read before the commit must not cover the change. */
export function recordTaskChange(taskId?: string): void {
  changeNumber++
  changes.push(taskId ?? null)
  if (changes.length > KEPT_CHANGES) changes.shift()
}

/** The revision of the task list as `readerKey` sees it now. Read it before the
 *  rows, so a change that commits during the read is in the next resume. */
export function taskListRevision(readerKey: string): string {
  return `${bootId}.${changeNumber}.${readerKey}`
}

/** The tasks that changed after `revision`, or null when the log cannot say:
 *  another process or reader, a revision older than the kept changes, or a
 *  change that named no task. */
export function tasksChangedSince(revision: string, readerKey: string): string[] | null {
  const [revisionBootId, number, revisionReaderKey, extra] = revision.split('.')
  if (extra !== undefined || revisionBootId !== bootId || revisionReaderKey !== readerKey) return null
  const since = Number(number)
  const oldestKept = changeNumber - changes.length
  if (!Number.isInteger(since) || since < oldestKept || since > changeNumber) return null
  const changed = new Set<string>()
  for (const taskId of changes.slice(changes.length - (changeNumber - since))) {
    if (taskId === null) return null
    changed.add(taskId)
  }
  return [...changed]
}
