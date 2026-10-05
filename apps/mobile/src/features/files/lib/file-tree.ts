/**
 * A project's folders built once from the host's flat file index
 * (`listProjectFiles`): root-relative file paths, plus folders that hold no
 * indexed file as root-relative paths with a trailing slash. A folder screen
 * then reads its children without walking the whole list again.
 */

export interface FolderListing {
  /** Child folder names, alphabetical. */
  folders: string[]
  /** Child file names, alphabetical. */
  files: string[]
}

export type FileTree = ReadonlyMap<string, FolderListing>

const EMPTY: FolderListing = { folders: [], files: [] }

/** The tree, keyed by root-relative folder path; the root is `''`. */
export function buildFileTree(files: readonly string[], emptyDirectories: readonly string[] = []): FileTree {
  const folders = new Map<string, Set<string>>()
  const names = new Map<string, Set<string>>()
  const folder = (path: string) => {
    let entry = folders.get(path)
    if (!entry) {
      entry = new Set()
      folders.set(path, entry)
      names.set(path, new Set())
    }
    return entry
  }
  // Registers every ancestor of `path`, each as a child of its parent.
  const addFolders = (segments: readonly string[]) => {
    folder('')
    for (let i = 0; i < segments.length; i++) {
      const parent = segments.slice(0, i).join('/')
      folder(parent).add(segments[i]!)
      folder(segments.slice(0, i + 1).join('/'))
    }
  }
  for (const path of files) {
    const segments = path.split('/').filter(Boolean)
    const name = segments.pop()
    if (!name) continue
    addFolders(segments)
    names.get(segments.join('/'))!.add(name)
  }
  for (const path of emptyDirectories) addFolders(path.split('/').filter(Boolean))
  folder('')

  const tree = new Map<string, FolderListing>()
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
  for (const [path, children] of folders) {
    tree.set(path, { folders: Array.from(children).sort(byName), files: Array.from(names.get(path) ?? []).sort(byName) })
  }
  return tree
}

export function folderListing(tree: FileTree, folderPath: string): FolderListing {
  return tree.get(folderPath) ?? EMPTY
}

/** `a/b` + `c` → `a/b/c`; the root joins without a slash. */
export function childPath(folderPath: string, name: string): string {
  return folderPath ? `${folderPath}/${name}` : name
}

/** The name a screen title shows for a folder; the root shows the project's. */
export function folderTitle(folderPath: string, projectName: string): string {
  return folderPath ? folderPath.slice(folderPath.lastIndexOf('/') + 1) : projectName
}

/** "1.2 KB" — the size a binary file shows in place of its contents. */
export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
