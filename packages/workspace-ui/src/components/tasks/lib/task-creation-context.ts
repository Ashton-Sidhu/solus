import type { GitCheckout } from '@solus/contracts/types'
import { worktreeProjectRoot } from '@solus/contracts/types'

export interface TaskCreationContext {
  /** The host that files the task. A path names a folder on one host only, so
   *  the context carries its host rather than letting a store guess one. */
  serverId: string
  workingDirectory: string
  projectKey: string
}

/** Capture the host, project, and checkout a manually-created task belongs to. */
export function taskCreationContextFor(
  serverId: string,
  workingDirectory: string | null | undefined,
  gitContext: GitCheckout | null | undefined,
): TaskCreationContext | null {
  const effectiveDirectory = gitContext?.worktreePath ?? workingDirectory
  if (!effectiveDirectory || effectiveDirectory === '~') return null
  const projectKey = gitContext?.repoRoot ?? worktreeProjectRoot(effectiveDirectory)
  return {
    serverId,
    workingDirectory: effectiveDirectory,
    projectKey,
  }
}
