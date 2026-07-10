import type { MergeQueueEntry, MergeQueueEntryStatus, StatusCardState } from '../../shared/types'

/** Prompt for the agent session that resolves a queue entry's merge conflicts.
 *  The queue polls the worktree and resumes on its own once the merge commit
 *  exists, so the agent must commit — and must not push. */
export function buildConflictResolutionPrompt(
  entry: Pick<MergeQueueEntry, 'number' | 'title'> & { baseRef?: string; conflictFiles?: string[] },
): string {
  const files = entry.conflictFiles ?? []
  const base = entry.baseRef ? `origin/${entry.baseRef}` : 'the base branch'
  return [
    `The merge queue is merging PR #${entry.number} ("${entry.title}"), but merging ${base} into the PR branch hit conflicts. That merge is currently in progress in this worktree.`,
    files.length > 0 ? 'Conflicted files:' : 'Run `git status` to find the conflicted files.',
    ...files.map((file) => `- ${file}`),
    'Resolve each conflict so the intent of both the PR and the base branch is preserved, run the relevant checks, then stage the files and conclude the merge with a commit (`git add -A && git commit --no-edit`).',
    'Do not push and do not abort the merge — the merge queue detects the merge commit, pushes it, and completes the PR merge automatically.',
  ].join('\n')
}

/** Stages of preparing a conflict-resolver session, mirroring the worktree-setup
 *  card the backend shows for new worktree sessions. Driven from the renderer
 *  here because the merge queue (not a single session start) owns the worktree +
 *  merge, and we open the session tab before that work finishes. */
export type ConflictResolverPhase = 'worktree' | 'merge' | 'session'

const CONFLICT_RESOLVER_STEPS: { id: ConflictResolverPhase; label: string }[] = [
  { id: 'worktree', label: 'Creating a worktree for this PR' },
  { id: 'merge', label: 'Merging in the base branch' },
  { id: 'session', label: 'Starting the resolver agent' },
]

export function buildConflictResolverCard(prNumber: number, phase: ConflictResolverPhase): StatusCardState {
  const activeIndex = CONFLICT_RESOLVER_STEPS.findIndex((s) => s.id === phase)
  return {
    id: `merge-conflict-resolver-${prNumber}`,
    title: `Preparing conflict resolution for PR #${prNumber}…`,
    icon: 'git-branch',
    status: 'active',
    steps: CONFLICT_RESOLVER_STEPS.map((s, i) => ({
      id: s.id,
      label: s.label,
      status: i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending',
    })),
  }
}

/** Terminal card when the worktree/merge prep can't produce conflicts to resolve
 *  (queue busy, merge failed, or it merged cleanly). Kept as 'error' so the
 *  reducer leaves it on screen instead of clearing it. */
export function buildConflictResolverErrorCard(prNumber: number, message: string): StatusCardState {
  return {
    id: `merge-conflict-resolver-${prNumber}`,
    title: `Couldn't prepare conflict resolution for PR #${prNumber}`,
    icon: 'git-branch',
    status: 'error',
    steps: [{ id: 'error', label: message, status: 'error' }],
  }
}

export const ENTRY_STATUS_LABELS: Record<MergeQueueEntryStatus, string> = {
  pending: 'Waiting',
  merging: 'Merging…',
  conflicts: 'Conflicts',
  merged: 'Merged',
  skipped: 'Skipped',
  failed: 'Failed',
}
