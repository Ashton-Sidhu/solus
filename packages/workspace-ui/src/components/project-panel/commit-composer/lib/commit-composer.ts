import type { ChangedFileStat } from '@solus/contracts/git-types'

/** Selected files in the list's own order, dropping any selection the list no
 *  longer contains (a background refresh raced the user's clicks). */
export function orderedSelection(files: ChangedFileStat[], selected: ReadonlySet<string>): ChangedFileStat[] {
  return files.filter((file) => selected.has(file.path))
}

/** Files matching every whitespace-separated term of `query`, case-insensitively.
 *  Terms are ANDed so "src test" narrows rather than widens; an empty query
 *  matches the whole list. */
export function filterFiles(files: ChangedFileStat[], query: string): ChangedFileStat[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return files
  return files.filter((file) => {
    const path = file.path.toLowerCase()
    return terms.every((term) => path.includes(term))
  })
}

/** A path split into its folders and its file name, so the list can quiet the
 *  folders and keep the name legible at a glance. */
export function splitPath(path: string): { folders: string; name: string } {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? { folders: '', name: path } : { folders: path.slice(0, cut + 1), name: path.slice(cut + 1) }
}

/** Tailwind classes tinting a file's status letter, matching the tree's
 *  added/modified/deleted convention (`DiffFileTreeColumn`). */
export const STATUS_TONE_CLASS = {
  A: 'text-(--solus-status-complete)',
  M: 'text-(--solus-accent)',
  D: 'text-(--solus-status-error)',
  R: 'text-(--solus-status-running)',
} satisfies Record<ChangedFileStat['status'], string>
