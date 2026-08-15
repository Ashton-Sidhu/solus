import type { ChangedFileStat } from '../../../../../shared/git-types'

/** Selected paths in the file list's own order, dropping any selection the
 *  list no longer contains (a background refresh raced the user's clicks). */
export function orderedSelection(files: ChangedFileStat[], selected: ReadonlySet<string>): string[] {
  return files.filter((file) => selected.has(file.path)).map((file) => file.path)
}

export function diffTotals(files: ChangedFileStat[]) {
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += file.additions
    deletions += file.deletions
  }
  return { additions, deletions }
}

/** Tailwind classes tinting a file's status letter, matching the tree's
 *  added/modified/deleted convention (`DiffFileTreeColumn`). */
export const STATUS_TONE_CLASS = {
  A: 'text-(--solus-status-complete)',
  M: 'text-(--solus-accent)',
  D: 'text-(--solus-status-error)',
  R: 'text-(--solus-status-running)',
} satisfies Record<ChangedFileStat['status'], string>
