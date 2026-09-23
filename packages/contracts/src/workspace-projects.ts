/**
 * The organization's project directory in the workspace service
 * (docs/plans/project-model.md §2). A project is a repository; a member adds it
 * explicitly, and every host checkout with the same repository key belongs to
 * it. Paths never appear here: a checkout is a fact about a host.
 */
export interface WorkspaceProject {
  id: string
  /** The canonical repository key, e.g. `github.com/acme/web`. Unique in the organization. */
  repositoryKey: string
  displayName: string
  /** The branch new cloud worktrees start from; null until someone sets it. */
  defaultBranch: string | null
  createdBy: string | null
  createdAt: number
}

export interface WorkspaceProjectAddRequest {
  repositoryKey: string
  displayName?: string
}

/** The settings every member shares for one project. A field left out keeps
 *  its value; `defaultBranch: null` clears it. */
export interface WorkspaceProjectPatch {
  displayName?: string
  defaultBranch?: string | null
}
