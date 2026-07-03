import type { MergeQueueEntry, MergeQueueEntryStatus } from '../../../../shared/types'

/** Prompt for the agent session that resolves a queue entry's merge conflicts.
 *  The queue polls the worktree and resumes on its own once the merge commit
 *  exists, so the agent must commit — and must not push. */
export function buildConflictResolutionPrompt(entry: MergeQueueEntry): string {
  const files = entry.conflictFiles ?? []
  return [
    `The merge queue is merging PR #${entry.number} ("${entry.title}"), but merging origin/${entry.baseRef} into the PR branch hit conflicts. That merge is currently in progress in this worktree.`,
    files.length > 0 ? 'Conflicted files:' : 'Run `git status` to find the conflicted files.',
    ...files.map((file) => `- ${file}`),
    'Resolve each conflict so the intent of both the PR and the base branch is preserved, run the relevant checks, then stage the files and conclude the merge with a commit (`git add -A && git commit --no-edit`).',
    'Do not push and do not abort the merge — the merge queue detects the merge commit, pushes it, and completes the PR merge automatically.',
  ].join('\n')
}

export const ENTRY_STATUS_LABELS: Record<MergeQueueEntryStatus, string> = {
  pending: 'Waiting',
  merging: 'Merging…',
  conflicts: 'Conflicts',
  merged: 'Merged',
  skipped: 'Skipped',
  failed: 'Failed',
}
