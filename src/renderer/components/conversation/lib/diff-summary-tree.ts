import type { ChangedFileStat } from '../../../../shared/git-types'

/**
 * §9 — the diff summary folds by directory rather than growing, so a sweep
 * across 300 files is still a handful of rows. The fold is a real directory
 * tree: chains of single-child folders collapse into one row, so a change
 * buried under `src/renderer/components` costs one row rather than three.
 */

/** Files shown inside one folder before it offers its own "show more". */
export const NESTED_ROWS = 8

export interface DiffFileNode {
  kind: 'file'
  path: string
  name: string
  additions: number
  deletions: number
  status: ChangedFileStat['status']
}

export interface DiffFolderNode {
  kind: 'folder'
  /** Full directory path — the identity the expanded set is keyed on. */
  path: string
  /** What the row shows: several segments once a single-child chain compresses. */
  label: string
  folders: DiffFolderNode[]
  files: DiffFileNode[]
  fileCount: number
  additions: number
  deletions: number
}

export interface DiffTree {
  root: DiffFolderNode
  total: number
  folderCount: number
  additions: number
  deletions: number
}

export type DiffRow =
  | { kind: 'folder'; depth: number; node: DiffFolderNode }
  | { kind: 'file'; depth: number; node: DiffFileNode }
  | { kind: 'more'; depth: number; folderPath: string; hidden: number }

function emptyFolder(path: string, label: string): DiffFolderNode {
  return { kind: 'folder', path, label, folders: [], files: [], fileCount: 0, additions: 0, deletions: 0 }
}

/**
 * Join known changed paths against git's counts. Turn summaries have no
 * transcript-owned path list, so their paths come directly from the stats.
 */
export function buildDiffSummaryTree(changedFiles: string[] | undefined, stats: ChangedFileStat[]): DiffTree {
  const byPath = new Map(stats.map((stat) => [stat.path, stat]))
  const paths = changedFiles ?? stats.map((stat) => stat.path)

  const root = emptyFolder('', '')
  for (const path of paths) {
    const stat = byPath.get(path)
    const segments = path.split('/')
    const name = segments.pop() ?? path
    let folder = root
    let prefix = ''
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      let child = folder.folders.find((candidate) => candidate.path === prefix)
      if (!child) {
        child = emptyFolder(prefix, segment)
        folder.folders.push(child)
      }
      folder = child
    }
    folder.files.push({
      kind: 'file',
      path,
      name,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      status: stat?.status ?? 'M',
    })
  }

  compress(root)
  lift(root)
  tally(root)

  return {
    root,
    total: paths.length,
    folderCount: countFolders(root),
    additions: root.additions,
    deletions: root.deletions,
  }
}

/** A folder that only ever contains one folder tells the reader nothing on its
 *  own line, so it merges into its child: `src` + `renderer` → `src/renderer`. */
function compress(folder: DiffFolderNode): void {
  for (const child of folder.folders) compress(child)
  if (folder.path === '' || folder.files.length > 0 || folder.folders.length !== 1) return
  const only = folder.folders[0]
  folder.path = only.path
  folder.label = `${folder.label}/${only.label}`
  folder.folders = only.folders
  folder.files = only.files
}

/** The root can't merge into a child the way an inner folder does, so a change
 *  entirely under one branch would open on a row everything is under. Lift that
 *  branch's fork up instead: `src` holding only `main/git` and `renderer/lib`
 *  becomes those two rows, prefixed. A branch with files of its own is a real
 *  row and stays. */
function lift(root: DiffFolderNode): void {
  while (root.folders.length === 1 && root.files.length === 0) {
    const only = root.folders[0]
    if (only.files.length > 0 || only.folders.length === 0) return
    for (const child of only.folders) child.label = `${only.label}/${child.label}`
    root.folders = only.folders
  }
}

function tally(folder: DiffFolderNode): void {
  folder.fileCount = folder.files.length
  folder.additions = folder.files.reduce((n, file) => n + file.additions, 0)
  folder.deletions = folder.files.reduce((n, file) => n + file.deletions, 0)
  for (const child of folder.folders) {
    tally(child)
    folder.fileCount += child.fileCount
    folder.additions += child.additions
    folder.deletions += child.deletions
  }
}

function countFolders(folder: DiffFolderNode): number {
  return folder.folders.reduce((n, child) => n + 1 + countFolders(child), 0)
}

/**
 * The tree as the flat row list the card renders. Folders outside `expanded`
 * contribute one row; a folder holding more than `NESTED_ROWS` files keeps the
 * tail behind its own "more" row unless the user asked for all of it.
 */
export function flattenDiffTree(
  tree: DiffTree,
  expanded: ReadonlySet<string>,
  unfolded: ReadonlySet<string>,
): DiffRow[] {
  const rows: DiffRow[] = []
  const walk = (folder: DiffFolderNode, depth: number): void => {
    for (const child of folder.folders) {
      rows.push({ kind: 'folder', depth, node: child })
      if (expanded.has(child.path)) walk(child, depth + 1)
    }
    const shown = unfolded.has(folder.path) ? folder.files : folder.files.slice(0, NESTED_ROWS)
    for (const file of shown) rows.push({ kind: 'file', depth, node: file })
    const hidden = folder.files.length - shown.length
    if (hidden > 0) rows.push({ kind: 'more', depth, folderPath: folder.path, hidden })
  }
  walk(tree.root, 0)
  return rows
}

/** Added/removed split of a folder's row bar, as percentages. */
export interface ChangeRatio {
  added: number
  removed: number
}

export function changeRatio(folder: { additions: number; deletions: number }): ChangeRatio {
  const total = folder.additions + folder.deletions
  if (total === 0) return { added: 0, removed: 0 }
  const added = Math.round((folder.additions / total) * 100)
  return { added, removed: 100 - added }
}
