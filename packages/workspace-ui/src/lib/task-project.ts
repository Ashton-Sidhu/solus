// A task belongs to no project (docs/tasks.md). A session started from a task
// works in a project all the same, so the client makes a guess, and the
// person can change the project on the draft before Send.

import { repositoryKeyOf } from '@solus/contracts/repository-key'
import type { TaskProviderId } from '@solus/contracts/task-types'

/** `owner/repo#123`: the reference of a GitHub issue. */
const GITHUB_ISSUE_REFERENCE = /^([^/\s#]+)\/([^/\s#]+)#\d+$/

/** The repository of a GitHub issue, as a repository key
 *  (`github.com/owner/repo`). Null for a Jira issue and a draft item. */
export function taskRepositoryKey(task: { providerId: TaskProviderId; reference?: string }): string | null {
  if (task.providerId !== 'github' || !task.reference) return null
  const match = GITHUB_ISSUE_REFERENCE.exec(task.reference)
  return match ? repositoryKeyOf({ host: 'github.com', owner: match[1], repo: match[2] }) : null
}

/**
 * The project a session from a task starts in. For a GitHub issue, the
 * project of the issue's repository when a connected host has a checkout of
 * it: the agent works where the code is. Else the project of the input bar,
 * which is the project the person works in now. Null when neither names one.
 */
export function guessTaskProject(
  task: { providerId: TaskProviderId; reference?: string },
  hasConnectedCheckout: (projectKey: string) => boolean,
  inputBarProjectKey: string | null,
): string | null {
  const repositoryKey = taskRepositoryKey(task)
  if (repositoryKey && hasConnectedCheckout(repositoryKey)) return repositoryKey
  return inputBarProjectKey
}
