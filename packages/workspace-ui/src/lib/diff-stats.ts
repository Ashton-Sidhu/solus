import type { ChangedFileStat } from '@solus/contracts/git-types'

/** Added/removed line counts for a file or a set of them. */
export interface DiffStats {
  additions: number
  deletions: number
}

/**
 * Line totals across git's own per-file counts.
 *
 * The `FileDiffMetadata` twin of this lives in `diffTreeAdapter`, which has to
 * walk hunks to reach the same numbers. `ChangedFileStat` already carries them,
 * so this stays here — away from the `@pierre` imports that adapter needs —
 * and surfaces showing a stat line pay nothing to reuse it.
 */
export function changedFileTotals(files: readonly ChangedFileStat[]): DiffStats {
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += file.additions
    deletions += file.deletions
  }
  return { additions, deletions }
}
