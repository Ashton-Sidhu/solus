import type { TaskProviderId } from '@solus/contracts/task-types'
import { getDatabase } from '../../db/database'
import { LOCAL_ORGANIZATION_ID } from '../../host/host-category'
import { githubCredentials } from '../../providers/github/credentials'
import { recordNotification } from '../notifications/store'

/** A task whose assignee changed on its provider, as one read saw it. */
export interface TaskAssignment {
  taskId: string
  title: string
  provider: TaskProviderId
  /** The new assignee, in the provider's words: a GitHub login. */
  assignee: string
  /** The provider's time of the change that the read saw. */
  updatedAt: number
}

/** The acting person's own GitHub login, or null when their connection keeps none. */
async function githubViewerLogin(): Promise<string | null> {
  return (await githubCredentials().status()).login ?? null
}

/**
 * Tell a person that a task became theirs (plans/015-notifications-hub.md §5):
 * a source read or a detail read with their connection showed that the
 * assignee of a task the host had a copy of became their own provider login.
 * Nothing here asks the provider for a task. The first read of a task is a
 * quiet baseline: a task that was theirs before Solus saw it is not news.
 *
 * GitHub only. The Atlassian connection keeps no account name, and a Jira
 * assignee is a display name, so "this is you" has no cheap and sure answer.
 *
 * The notification is the reader's own, so it is in Local, as a pull request
 * assignment is (`PrObserver`). `viewerLogin` is the acting person's login.
 */
export async function notifyTaskAssignments(
  assigned: readonly TaskAssignment[],
  personKey: string,
  viewerLogin: () => Promise<string | null> = githubViewerLogin,
): Promise<void> {
  const onGithub = assigned.filter((assignment) => assignment.provider === 'github')
  if (!onGithub.length) return
  const login = (await viewerLogin())?.toLowerCase()
  if (!login) return
  const mine = onGithub.filter((assignment) => assignment.assignee.toLowerCase() === login)
  if (!mine.length) return
  await getDatabase().transaction(async (tx) => {
    for (const assignment of mine) {
      await recordNotification(tx, {
        organizationId: LOCAL_ORGANIZATION_ID,
        // Named by the provider's change, so two reads of one change record one notification.
        eventId: `task.assigned:${assignment.taskId}:${login}:${assignment.updatedAt}`,
        recipients: [personKey],
        resource: { kind: 'task', taskId: assignment.taskId },
        by: { kind: 'upstream', provider: 'github' },
        facts: { kind: 'task.assigned' },
        summary: { title: assignment.title.slice(0, 300) },
      })
    }
  })
}
