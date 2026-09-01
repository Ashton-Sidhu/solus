import type { GitProjectStatus, TabGitContext } from '../../shared/types'

function capitalizeFirst(value: string): string {
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function removeSolusWorktreeSuffix(value: string): string {
  return value
    .replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, '')
    .replace(/-[a-z0-9]{5}$/i, '')
}

function formatFriendlyBranchName(branch: string): string {
  const words = branch
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()

  return capitalizeFirst(words || branch)
}

export function formatBranchDisplayName(branch: string, targetBranch: string, isWorktree: boolean): string {
  if (!isWorktree && branch === targetBranch) {
    return capitalizeFirst(branch)
  }

  if (isWorktree) {
    const worktreeBranch = branch.startsWith('solus/')
      ? removeSolusWorktreeSuffix(branch.slice('solus/'.length))
      : branch
    return formatFriendlyBranchName(worktreeBranch)
  }

  return formatFriendlyBranchName(branch)
}

export type EnvironmentKind = 'workspace' | 'branch' | 'worktree'

/**
 * The single notion of "which environment is this session in." Every surface
 * (sidebar, Environment panel, pill, new-tab hero) is a projection of this one
 * model instead of re-deriving branch/worktree/kind state independently.
 *
 * `gitCtx` + `worktreeBaseBranch` come from the Session; `status` is the live
 * dirty/±lines snapshot from `GitStatusStore` (optional — surfaces that only
 * need identity pass nothing).
 */
export interface SessionEnvironment {
  /** workspace = non-git, branch = repo direct, worktree = isolated */
  kind: EnvironmentKind
  /** folder/branch identity: friendly worktree name | branch name | 'Workspace' */
  name: string
  branch: string | null
  targetBranch: string | null
  /** kind === 'worktree' */
  isolated: boolean
  /** worktreeBaseBranch set but the worktree path isn't created yet (AI names it on the first turn). */
  pending: boolean
  repoRoot: string | null
  worktreePath: string | null
  status: GitProjectStatus | null
}

const WORKSPACE_NAME = 'Workspace'
// Shown while the worktree is being created (the AI names the branch on the
// first turn). Keeps every surface off the base-branch name so the session
// never reads as "Main" and then teleports to the worktree once it resolves.
const PENDING_WORKTREE_NAME = 'New worktree'

export function sessionEnvironment(
  gitCtx: TabGitContext | null,
  worktreeBaseBranch: string | null,
  status?: GitProjectStatus | null,
): SessionEnvironment {
  const liveStatus = status ?? null
  const isolated = !!gitCtx?.worktreePath
  const pending = !!worktreeBaseBranch && !isolated

  if (!gitCtx) {
    return {
      kind: 'workspace',
      name: pending ? PENDING_WORKTREE_NAME : WORKSPACE_NAME,
      branch: null,
      targetBranch: worktreeBaseBranch ?? null,
      isolated: false,
      pending,
      repoRoot: liveStatus?.repoRoot ?? null,
      worktreePath: null,
      status: liveStatus,
    }
  }

  return {
    kind: isolated ? 'worktree' : 'branch',
    name: pending ? PENDING_WORKTREE_NAME : formatBranchDisplayName(gitCtx.branch, gitCtx.targetBranch, isolated),
    branch: gitCtx.branch,
    targetBranch: gitCtx.targetBranch,
    isolated,
    pending,
    repoRoot: gitCtx.repoRoot ?? liveStatus?.repoRoot ?? null,
    worktreePath: gitCtx.worktreePath ?? null,
    status: liveStatus,
  }
}
