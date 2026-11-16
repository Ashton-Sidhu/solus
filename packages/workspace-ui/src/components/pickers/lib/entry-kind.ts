import type { DirectoryEntry } from '@solus/contracts/types'

/**
 * The Kind column of the folder list. The most useful fact wins: a folder
 * Solus already tracks is a project before it is a checkout.
 */
export function entryKindLabel(entry: DirectoryEntry): string {
  if (!entry.isDir) return 'File'
  if (entry.isProject) return 'Project'
  if (entry.isRepo) return 'Git repository'
  return 'Folder'
}

/** The count under the list: "1 folder", "12 folders", or items when files show too. */
export function entryCountLabel(count: number, includesFiles: boolean): string {
  const noun = includesFiles ? 'item' : 'folder'
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
