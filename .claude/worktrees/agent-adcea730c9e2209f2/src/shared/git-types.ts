/** Raw combined `git diff` patch for the requested scope. */
export interface DiffResult {
  patch: string
}

/** Per-file add/delete tally from `git diff --numstat`, for the changed-files
 *  list. Cheaper than shipping the whole patch just to count lines. */
export interface ChangedFileStat {
  path: string
  additions: number
  deletions: number
}

export type DiffScope =
  | { kind: 'session' }
  | { kind: 'turn'; index: number }
  | { kind: 'working-tree' }
  // PR review: merge-base(base, head)…live worktree. `baseSha` is the merge-base
  // captured when the PR worktree was checked out (PrReviewContext.baseSha).
  | { kind: 'pr'; baseSha: string }

export type DiffRequest = { scope: DiffScope; livePaths?: string[] }

export interface GitProjectStatusOptions {
  /** Include worktree line totals and any existing pull-request URL. These
   *  require a full worktree scan and potentially a network-backed CLI call. */
  includeDetails?: boolean
}

export interface TurnSnapshot {
  index: number
  sha: string
  timestamp: number
  partial: boolean
  userMessagePreview: string
  filesChanged: number
  additions: number
  deletions: number
}

export interface WorktreePRResult {
  success: boolean
  url?: string
  error?: string
}

export interface GitCommitPushResult {
  success: boolean
  error?: string
}

export interface GitSyncResult {
  success: boolean
  error?: string
}

export interface GitProjectStatusFile {
  path: string
  conflicted: boolean
}

export interface GitProjectStatus {
  repoRoot: string
  branch: string | null
  targetBranch: string
  files: GitProjectStatusFile[]
  /** Lines added across uncommitted changes. Zero in summary-only responses. */
  insertions: number
  /** Lines removed across uncommitted changes. Zero in summary-only responses. */
  deletions: number
  mergeInProgress: boolean
  prUrl?: string
}
