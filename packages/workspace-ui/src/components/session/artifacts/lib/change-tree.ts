import type { ChangedFileStat } from '@solus/contracts/git-types'
import type { OverviewChange } from '@solus/client-core/session-overview'
import { buildDiffSummaryTree, type DiffFolderNode, type DiffTree } from '../../../conversation/lib/diff-summary-tree'

/**
 * The Changes card's rows (docs/plans/session-artifacts.md): the changed files
 * as the directory tree the conversation's changed-files card draws.
 */
export function changeTree(changes: readonly OverviewChange[]): DiffTree {
  const stats = changes.flatMap((change): ChangedFileStat[] =>
    change.additions === null || change.deletions === null || change.status === null
      ? []
      : [{ path: change.path, additions: change.additions, deletions: change.deletions, status: change.status }],
  )
  // By path, as a directory listing reads: the tree is for finding a file, not for ranking it.
  const paths = changes.map((change) => change.path).sort((a, b) => a.localeCompare(b))
  return buildDiffSummaryTree(paths, stats)
}

/** Every folder of a tree, so a small tree can start with all of them open. */
export function folderPaths(tree: DiffTree): string[] {
  const paths: string[] = []
  const walk = (folder: DiffFolderNode): void => {
    for (const child of folder.folders) {
      paths.push(child.path)
      walk(child)
    }
  }
  walk(tree.root)
  return paths
}

/** A change this small shows its files at once; a larger one opens on its folders. */
export const OPEN_TREE_FILE_LIMIT = 8
