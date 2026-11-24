import { hostPathKey, isInsideHostPath, sameHostPath } from '@solus/contracts/host-path'
import type { GithubPublishRepositoryResult } from '@solus/contracts/types'

/** The stage that failed, in the order Publish runs them — for the retry label. */
export function publishFailureStage(result: GithubPublishRepositoryResult): 'repository' | 'remote' | 'push' | null {
  if (result.repository.status === 'failed') return 'repository'
  if (result.remote.status === 'failed') return 'remote'
  if (result.push.status === 'failed') return 'push'
  return null
}

/** The failed stage's own message, so the user sees git/GitHub's own words. */
export function publishFailureMessage(result: GithubPublishRepositoryResult): string | null {
  if (result.repository.status === 'failed') return result.repository.error
  if (result.remote.status === 'failed') return result.remote.error
  if (result.push.status === 'failed') return result.push.error
  return null
}

/** A GitHub URL to show once the repository exists, even if a later stage failed. */
export function publishRepositoryUrl(result: GithubPublishRepositoryResult): string | null {
  return result.repository.status === 'failed' ? null : result.repository.url
}

/** A folder as the count below reads it: a session folder, or a member of a codebase. */
interface FolderFact {
  path: string
  state: 'git' | 'plain' | 'missing'
}

/**
 * How many repositories a folder with no repository holds
 * (docs/plans/codebases.md §9): the session folders of a started session, and
 * the members that the host read in the project folder of a draft. With one
 * or more, the Git card lists them, and "set up Git" is not its message: the
 * folder is the place of several repositories, not a project that lacks one.
 * "Track with Git" for the folder itself is then in the menu of the project
 * row of the Environment card.
 */
export function repositoriesInFolder(cwd: string | null | undefined, sessionFolders: readonly FolderFact[], members: readonly FolderFact[]): number {
  if (!cwd || cwd === '~') return 0
  const inside = new Set<string>()
  for (const folder of [...sessionFolders, ...members]) {
    if (folder.state === 'git' && isInsideHostPath(cwd, folder.path) && !sameHostPath(cwd, folder.path)) inside.add(hostPathKey(folder.path))
  }
  return inside.size
}
