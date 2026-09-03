import type { GitState } from '@solus/contracts/types'

/** Build the draft only from the latest working-tree scan. A stale conflict
 * row must not open an agent composer after the conflict has been resolved. */
export function mergeConflictDraft(status: GitState | null | undefined): string | null {
  if (!status) return null

  const conflictedFiles = status.uncommittedChanges.files.filter((file) => file.conflicted)
  if (conflictedFiles.length === 0) return null

  return [
    `Resolve the merge conflicts on branch ${status.branch ?? 'detached HEAD'}.`,
    'Files to inspect:',
    ...conflictedFiles.map((file) => `- ${file.path}`),
    'Inspect the files, resolve the conflicts, and run the relevant checks.',
  ].join('\n')
}
