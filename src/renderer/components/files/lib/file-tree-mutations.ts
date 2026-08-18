/**
 * Path arithmetic for the files pane tree.
 *
 * `@pierre/trees` identifies items by path and marks a folder with a trailing
 * slash, so every helper here keeps that convention: a folder path always ends
 * in `/`, a file path never does. The rename callback hands back bare paths, so
 * canonicalize before calling back into the tree.
 */

export type FileTreeEntryKind = 'file' | 'folder'

/** Same ordering the host uses for the indexed listing, so a locally inserted
 *  path lands where a refresh would have put it. */
function compareTreePaths(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}

export function canonicalTreePath(path: string, isFolder: boolean): string {
  if (!isFolder || path.endsWith('/')) return path
  return `${path}/`
}

export function isFolderPath(path: string): boolean {
  return path.endsWith('/')
}

/** The trailing name a user reads on the row: `src/lib/` -> `lib`. */
export function entryDisplayName(path: string): string {
  const bare = path.endsWith('/') ? path.slice(0, -1) : path
  const slash = bare.lastIndexOf('/')
  return slash === -1 ? bare : bare.slice(slash + 1)
}

/** The folder an entry sits in, keeping its trailing slash: `src/a.ts` -> `src/`.
 *  The project root is `''`. */
export function parentDirectoryOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash + 1)
}

/**
 * Where a new entry goes when the user acts on `path`. A folder takes the new
 * entry inside it; a file takes it alongside.
 */
export function creationDirectoryFor(path: string, isFolder: boolean): string {
  return isFolder ? canonicalTreePath(path, true) : parentDirectoryOf(path)
}

/**
 * A name the tree can hold while the user types the real one. It must not
 * collide with an existing row, or the tree would refuse to add it.
 */
export function placeholderEntryPath(
  directory: string,
  kind: FileTreeEntryKind,
  takenPaths: ReadonlySet<string>,
): string {
  const base = kind === 'folder' ? 'untitled folder' : 'untitled'
  const suffix = kind === 'folder' ? '/' : ''
  let candidate = `${directory}${base}${suffix}`
  let attempt = 2
  while (takenPaths.has(candidate)) {
    candidate = `${directory}${base} ${attempt}${suffix}`
    attempt += 1
  }
  return candidate
}

/** Insert in sort order, ignoring a path the list already holds. */
export function addTreePath(paths: string[], path: string): void {
  if (paths.includes(path)) return
  let index = 0
  while (index < paths.length && compareTreePaths(paths[index], path) < 0) index += 1
  paths.splice(index, 0, path)
}

/** Drop `path` and, when it names a folder, everything beneath it. */
export function removeTreePath(paths: string[], path: string): void {
  const folder = isFolderPath(path)
  for (let index = paths.length - 1; index >= 0; index -= 1) {
    const current = paths[index]
    if (current === path || (folder && current.startsWith(path))) paths.splice(index, 1)
  }
}

/**
 * Re-point `fromPath` and its descendants at `toPath`, keeping sort order, and
 * report what moved so a caller can follow a path it was holding — the open
 * file, say, when what moved was a folder above it.
 */
export function renameTreePath(
  paths: string[],
  fromPath: string,
  toPath: string,
): { from: string; to: string }[] {
  const folder = isFolderPath(fromPath)
  const moved: { from: string; to: string }[] = []
  for (const current of paths) {
    if (current === fromPath) moved.push({ from: current, to: toPath })
    else if (folder && current.startsWith(fromPath)) {
      moved.push({ from: current, to: `${toPath}${current.slice(fromPath.length)}` })
    }
  }
  removeTreePath(paths, fromPath)
  for (const entry of moved) addTreePath(paths, entry.to)
  return moved
}
