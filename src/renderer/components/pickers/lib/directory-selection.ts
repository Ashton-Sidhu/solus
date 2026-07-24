import type { DirectoryEntry } from '../../../../shared/types'

export interface DirectorySelection {
  entry: DirectoryEntry | null
  path: string
  name: string
}

/**
 * A folder being browsed remains the destination until the user explicitly
 * selects one of its children. This prevents opening a picker and confirming an
 * arbitrary first child simply because it sorts first.
 */
export function resolveDirectorySelection(
  currentPath: string,
  currentName: string,
  entries: DirectoryEntry[],
  selectedIndex: number,
): DirectorySelection {
  const entry = selectedIndex >= 0 ? (entries[selectedIndex] ?? null) : null
  return {
    entry,
    path: entry?.path ?? currentPath,
    name: entry?.name ?? currentName,
  }
}
