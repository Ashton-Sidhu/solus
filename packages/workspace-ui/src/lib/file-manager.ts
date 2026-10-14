import type { FileManagerKind } from '@solus/contracts/types'

/** The file manager a host opens a folder in, named the way its OS names it. */
export function fileManagerNameFor(kind: FileManagerKind): string {
  if (kind === 'finder') return 'Finder'
  if (kind === 'file-explorer') return 'File Explorer'
  return 'Files'
}
