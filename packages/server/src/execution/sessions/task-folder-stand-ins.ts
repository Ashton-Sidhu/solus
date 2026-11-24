import type { CodebaseMember, TaskFolder } from '@solus/contracts/codebases'
import { isInsideRoot } from '../../paths'
import { realPathOf } from './attach-target'

/**
 * What stands in for a member of a codebase in a task folder session
 * (docs/plans/codebases.md §7). `SessionFolders` asks here where a session
 * works for each member.
 */

/** The answer of `taskFolderStandIns` for a member that is not a folder of a task folder session. */
export const NOT_A_FOLDER = Symbol('not a session folder')

/**
 * Where a session works for each member of its codebase: the worktree that
 * the task folder has for a repository, `null` for the member itself, or
 * `NOT_A_FOLDER`. A session with no task folder works in each member itself.
 *
 * In a task folder, the working directory stands in for the working member,
 * so that member is no folder besides it. The session is isolated: it does
 * not reach the shared checkout of a repository that has no worktree here,
 * and a plain folder that holds a repository would give that checkout. A
 * plain folder with no repository has no worktree, so the session works in
 * the original.
 */
export async function taskFolderStandIns(taskFolder: TaskFolder | null, members: readonly CodebaseMember[]): Promise<(member: CodebaseMember) => Promise<string | null | typeof NOT_A_FOLDER>> {
  if (!taskFolder) return async () => null
  const workingMember = await realPathOf(taskFolder.primaryRepositoryPath)
  const repositories = await Promise.all(members.filter((member) => member.state === 'git').map((member) => realPathOf(member.path)))
  return async (member) => {
    const memberPath = await realPathOf(member.path)
    if (memberPath === workingMember) return NOT_A_FOLDER
    if (member.state === 'git') return await worktreeOfMember(taskFolder, memberPath) ?? NOT_A_FOLDER
    return repositories.some((repository) => isInsideRoot(memberPath, repository)) ? NOT_A_FOLDER : null
  }
}

/** The worktree that a task folder has for the repository at the real path `repositoryPath`, or null. */
export async function worktreeOfMember(taskFolder: TaskFolder, repositoryPath: string): Promise<string | null> {
  const checkouts = [
    ...(taskFolder.primaryIsWorktree ? [{ repositoryPath: taskFolder.primaryRepositoryPath, worktreePath: taskFolder.primaryPath }] : []),
    ...taskFolder.repositories,
  ]
  for (const checkout of checkouts) {
    if (await realPathOf(checkout.repositoryPath) === repositoryPath) return checkout.worktreePath
  }
  return null
}
