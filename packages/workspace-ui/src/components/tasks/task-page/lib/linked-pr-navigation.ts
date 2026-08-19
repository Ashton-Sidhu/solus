export interface LinkedPrNavigationInput {
  /** The host that owns the task and its project path. */
  taskServerId: string | null
  /** Current task project root. This supersedes an older link-time scope. */
  taskProjectDirectory?: string | null
  /** Legacy fallback for links created before the task project was available. */
  linkProjectDirectory: string
}

export interface LinkedPrNavigationTarget {
  serverId?: string
  projectDirectory?: string
}

/** Keep a project path on the host that owns it, even when the active attempt
 * runs elsewhere. A link-time scope can name a deleted worktree, so the task's
 * current project is authoritative when it is available. */
export function linkedPrNavigationTarget(
  input: LinkedPrNavigationInput,
): LinkedPrNavigationTarget {
  const projectDirectory = input.taskProjectDirectory?.trim()
    || input.linkProjectDirectory.trim()
    || undefined
  const target: LinkedPrNavigationTarget = {}
  if (input.taskServerId) target.serverId = input.taskServerId
  if (projectDirectory) target.projectDirectory = projectDirectory
  return target
}
