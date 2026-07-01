import type { GitProjectStatus, TabGitContext } from '../../shared/types'

export type RecommendedGitActionKey =
  | 'commit'
  | 'sync'
  | 'pr-view'
  | 'pr-create'
  | 'conflict'

interface GitRecommendationState {
  status: GitProjectStatus | null | undefined
  gitContext: TabGitContext | null | undefined
  prUrl: string | null | undefined
  commitPushing: boolean
  syncing: boolean
  creatingPR: boolean
}

export function getRecommendedGitActionKey(state: GitRecommendationState): RecommendedGitActionKey | null {
  const { status, gitContext, prUrl } = state
  if (!gitContext) return null
  if (status?.mergeInProgress || status?.files.some((file) => file.conflicted)) return 'conflict'
  if (state.commitPushing) return 'commit'
  if (state.syncing) return 'sync'
  if (state.creatingPR) return 'pr-create'
  if ((status?.files.length ?? 0) > 0) return 'commit'
  if (prUrl) return 'pr-view'
  if (gitContext.branch !== gitContext.targetBranch) return 'pr-create'
  return 'sync'
}
