import type { ChangedFileStat } from '../../../../../shared/git-types'

/** Selected files in the list's own order, dropping any selection the list no
 *  longer contains (a background refresh raced the user's clicks). */
export function orderedSelection(files: ChangedFileStat[], selected: ReadonlySet<string>): ChangedFileStat[] {
  return files.filter((file) => selected.has(file.path))
}

/** Tailwind classes tinting a file's status letter, matching the tree's
 *  added/modified/deleted convention (`DiffFileTreeColumn`). */
export const STATUS_TONE_CLASS = {
  A: 'text-(--solus-status-complete)',
  M: 'text-(--solus-accent)',
  D: 'text-(--solus-status-error)',
  R: 'text-(--solus-status-running)',
} satisfies Record<ChangedFileStat['status'], string>
