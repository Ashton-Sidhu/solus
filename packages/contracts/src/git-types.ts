/** Raw combined `git diff` patch for the requested scope. */
export interface DiffResult {
  patch: string
}

export interface ReviewCheckpoint {
  prNumber: number
  /** PR head that was submitted to the provider for review. */
  headSha: string
  /** Exact merge-base used to render the reviewed PR diff. */
  base: string
  reviewedAt: string
}

export interface InterdiffHunk {
  id: string
  filePath: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  patch: string
}

export interface ReviewThreadHunkMatch {
  thread: import('./providers').ReviewThread
  hunk: InterdiffHunk | null
}

export interface PrInterdiffResult {
  checkpoint: ReviewCheckpoint | null
  state: 'none' | 'unchanged' | 'changed' | 'invalid'
  invalidReason?: 'base-changed' | 'old-head-unavailable'
  /** Unified patch rendered by the Diff tab. Invalid checkpoints return the full PR patch. */
  patch: string
  isFullDiff: boolean
  /** Convenience alias for the reviewed checkpoint head. */
  oldHead: string | null
  currentHead: string
  currentBase: string
  commentMatches: ReviewThreadHunkMatch[]
}

/** Per-file add/delete tally from `git diff --numstat`, for the changed-files
 *  list. Cheaper than shipping the whole patch just to count lines. */
export interface ChangedFileStat {
  path: string
  additions: number
  deletions: number
  /** Added / Modified / Deleted / Renamed, as the diff summary's status slot. */
  status: 'A' | 'M' | 'D' | 'R'
}

export type DiffScope =
  | { kind: 'session' }
  | { kind: 'turn'; index: number }
  | { kind: 'working-tree' }
  // PR review: merge-base(base, head)…live worktree. `baseSha` is the target
  // merge-base captured at checkout. An own-delta scope supplies the live
  // parent's head; main resolves its merge-base with the checked-out child.
  | { kind: 'pr'; baseSha: string; ownDeltaBaseSha?: string; parentPr?: number }

export type DiffRequest = {
  scope: DiffScope
  livePaths?: string[]
}

export interface DiffFileContentsRequest {
  scope: DiffScope
  /** Post-image path from the parsed patch. */
  path: string
  /** Pre-image path for renamed files; defaults to `path`. */
  previousPath?: string
  livePaths?: string[]
  /** Object ids from the patch, used to reject content loaded after the diff changed. */
  expectedOldObjectId?: string
  expectedNewObjectId?: string
}

export interface DiffFileContent {
  name: string
  contents: string
  /** Stable blob identity used by @pierre/diffs' highlight cache. */
  cacheKey: string
}

export interface DiffFileContentsResult {
  oldFile: DiffFileContent | null
  newFile: DiffFileContent | null
}

export interface GitStateOptions {
  /** Include worktree line totals and any existing pull-request URL. These
   *  require a full worktree scan and potentially a network-backed CLI call. */
  includeDetails?: boolean
  /** Ignore network-backed detail caches for explicit manual/post-action refresh. */
  bypassCache?: boolean
}

export interface TurnSnapshot {
  index: number
  /** Exact live worktree tree captured before provider execution. */
  fromTreeSha: string
  /** Exact tree after applying only this turn's reported file changes. */
  toTreeSha: string
  /** Cumulative session snapshot commit; not the turn diff boundary. */
  sha: string
  timestamp: number
  partial: boolean
  userMessagePreview: string
  filesChanged: number
  additions: number
  deletions: number
}

export type GitAction =
  | 'commit'
  | 'commit_push'
  | 'push'
  | 'create_pull_request'
  | 'commit_push_pull_request'

export type GitActionPhase =
  | 'branch'
  | 'commit'
  | 'push'
  | 'author_pull_request'
  | 'create_pull_request'

export interface GitActionRequest {
  actionId: string
  action: GitAction
  /** Move work off the default branch before committing. */
  createFeatureBranch?: boolean
  /** Manual commit subject. Blank or absent falls back to the generator. Only
   *  valid alongside a commit action. */
  commitMessage?: string
  /** Repository-relative paths to commit, file-level only. Absent commits every
   *  change (legacy `git add -A` behavior); an empty array is invalid. Only
   *  valid alongside a commit action. */
  filePaths?: string[]
}

export type GitBranchStep =
  | { status: 'created'; name: string }
  | { status: 'skipped' }

export type GitCommitStep =
  | { status: 'created'; sha: string; subject: string }
  | { status: 'skipped_no_changes' }
  | { status: 'skipped' }

export type GitPushStep =
  | { status: 'pushed'; branch: string }
  | { status: 'skipped' }

export type GitPullRequestStep =
  | { status: 'created' | 'existing'; url: string; number: number | null; title: string }
  | { status: 'skipped' }

export interface GitActionResult {
  action: GitAction
  branch: GitBranchStep
  commit: GitCommitStep
  push: GitPushStep
  pullRequest: GitPullRequestStep
}

export type GitActionProgressEvent =
  | { actionId: string; cwd: string; action: GitAction; kind: 'started'; phases: GitActionPhase[] }
  | { actionId: string; cwd: string; action: GitAction; kind: 'phase_started'; phase: GitActionPhase; label: string }
  | { actionId: string; cwd: string; action: GitAction; kind: 'finished'; result: GitActionResult }
  | { actionId: string; cwd: string; action: GitAction; kind: 'failed'; phase: GitActionPhase | null; message: string }

export interface GitSyncResult {
  success: boolean
  outcome: 'synced' | 'conflicted' | 'failed'
  error?: string
}

/** Throwing away uncommitted work. `discarded` counts the files that were
 *  reset or removed, so the caller can report what it cost. */
export interface GitDiscardResult {
  success: boolean
  discarded: number
  error?: string
}

export interface UncommittedFile {
  path: string
  conflicted: boolean
}

/** Files and operation state currently reported by Git. This becomes empty
 * after a successful commit and is distinct from cumulative session changes. */
export interface UncommittedChanges {
  files: UncommittedFile[]
  hasMoreFiles: boolean
  insertions: number
  deletions: number
  mergeInProgress: boolean
}

/** Which repo and branch a working tree is on — all O(1) to obtain, unlike the
 * working-tree scan `GitState` adds on top. */
export interface GitIdentity {
  repoRoot: string
  headSha: string
  branch: string | null
  targetBranch: string
}

export interface GitState extends GitIdentity {
  uncommittedChanges: UncommittedChanges
  upstreamRef: string | null
  aheadCount: number
  behindCount: number
  /** Commits on HEAD that are not on the target branch. Loaded with details. */
  targetAheadCount?: number
  prUrl?: string
}

/**
 * Whether a folder is a Git repository at all — distinct from `GitState`,
 * which reports null for both "no repository" and "repository with no
 * commits yet" (an unborn HEAD has no resolvable identity). This is what the
 * Initialize Git / Publish to GitHub empty states key off.
 */
export interface GitRepositoryStatus {
  isRepository: boolean
  hasCommits: boolean
  /** The current (possibly unborn) branch name; null only when detached. */
  branch: string | null
  primaryRemoteName: string | null
  primaryRemoteUrl: string | null
}

export interface GitInitRepositoryResult {
  defaultBranch: string
}

export interface GithubPublishRepositoryRequest {
  /** An organization, or omitted to publish under the account the checkout's
   *  credential authenticates as — which for a dispatched session is the
   *  device that dispatched it, not the host. */
  owner?: string
  name: string
  private: boolean
  /** Defaults to "origin" on the host. */
  remoteName?: string
  protocol: 'https' | 'ssh'
}

export type GithubPublishRepositoryStep =
  | { status: 'created'; url: string; fullName: string }
  | { status: 'found'; url: string; fullName: string }
  | { status: 'failed'; error: string }

export type GithubPublishRemoteStep =
  | { status: 'added'; name: string; url: string }
  | { status: 'existing'; name: string; url: string }
  | { status: 'failed'; error: string }
  | { status: 'skipped' }

export type GithubPublishPushStep =
  | { status: 'pushed'; branch: string }
  | { status: 'skipped_no_commits' }
  | { status: 'failed'; error: string }
  | { status: 'skipped' }

/**
 * Every stage's outcome, even after an earlier stage fails — so a client that
 * created the GitHub repository but failed to push can show the repository
 * URL and retry, instead of losing it behind a thrown error.
 */
export interface GithubPublishRepositoryResult {
  success: boolean
  repository: GithubPublishRepositoryStep
  remote: GithubPublishRemoteStep
  push: GithubPublishPushStep
}
