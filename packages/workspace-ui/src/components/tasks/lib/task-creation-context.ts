import type { GitCheckout } from '@solus/contracts/types'
import { worktreeProjectRoot } from '@solus/contracts/types'
import { taskWorktreeKey } from '@solus/contracts/task-types'

export interface TaskCreationContext {
  workingDirectory: string
  projectKey: string
  branch: string | null
  worktreeKey: string
}

/** Capture the project and checkout a manually-created task belongs to. */
export function taskCreationContextFor(
  workingDirectory: string | null | undefined,
  gitContext: GitCheckout | null | undefined,
): TaskCreationContext | null {
  const effectiveDirectory = gitContext?.worktreePath ?? workingDirectory
  if (!effectiveDirectory || effectiveDirectory === '~') return null
  const projectKey = gitContext?.repoRoot ?? worktreeProjectRoot(effectiveDirectory)
  return {
    workingDirectory: effectiveDirectory,
    projectKey,
    branch: gitContext?.branch ?? null,
    worktreeKey: taskWorktreeKey(projectKey, gitContext),
  }
}
