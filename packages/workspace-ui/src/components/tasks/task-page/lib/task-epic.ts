// The epic row of the task page's properties.
import type { Task, TaskProviderId } from '@solus/contracts/task-types'
import { PROVIDER_NAMES } from '../../lib/tasks-api'

/** The epic as the properties rail names it. Null hides the row: a task with
 *  no epic has nothing to say there, not an empty value. */
export interface TaskEpicRow {
  providerId: TaskProviderId
  title: string
  ref: string
  url: string
  /** The row's tooltip: the provider, the reference, and the full title. */
  hint: string
}

export function taskEpicRow(task: Pick<Task, 'epic'>): TaskEpicRow | null {
  const epic = task.epic
  if (!epic) return null
  const ref = epicRef(epic.provider, epic.externalId)
  return {
    providerId: epic.provider,
    title: epic.title,
    ref,
    url: epic.url,
    hint: `Open ${PROVIDER_NAMES[epic.provider]} ${ref} — ${epic.title}`,
  }
}

/** How each provider writes a reference: GitHub numbers its issues and
 *  prefixes them with `#`; a Jira key (`ACME-12`) already reads as one. */
function epicRef(provider: TaskProviderId, externalId: string): string {
  if (provider !== 'github') return externalId
  return /^\d+$/.test(externalId) ? `#${externalId}` : externalId
}
