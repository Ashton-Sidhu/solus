import type { FileDiffMetadata } from '@pierre/diffs'
import {
  diffFilePath,
  diffFileStats,
  diffFileStatus,
  toTreeDisplayPath,
} from '../../../lib/diffTreeAdapter'

export type HeatMapNode = {
  /** Display segment; a collapsed single-child chain reads as "src/renderer". */
  name: string
  /** Full display path from the repo root; '' for the root node. */
  path: string
  kind: 'folder' | 'file'
  additions: number
  deletions: number
  /** Files under this node the change touched (1 for a changed file itself). */
  changedFileCount: number
  /** All files under this node, including unchanged repo files when the repo
   *  listing was provided; equals changedFileCount otherwise. */
  totalFileCount: number
  /** Whether the change touched this node at all — explicit rather than derived
   *  from line counts so pure renames still read as changed. */
  changed: boolean
  /** Git status letter for changed files; null for folders and repo files. */
  status: 'A' | 'M' | 'D' | 'R' | null
  children: HeatMapNode[]
}

export function heatChanges(node: HeatMapNode): number {
  return node.additions + node.deletions
}

function makeNode(name: string, path: string, kind: 'folder' | 'file'): HeatMapNode {
  return {
    name,
    path,
    kind,
    additions: 0,
    deletions: 0,
    changedFileCount: 0,
    totalFileCount: 0,
    changed: false,
    status: null,
    children: [],
  }
}

/**
 * Merge folders that contain exactly one child folder and nothing else, so a
 * drill into `src` never lands on a level with a single `renderer` entry. The
 * merged node keeps the deepest path and joins the segment names for display.
 * When the repo listing was merged in, chains only collapse where the repo
 * genuinely has a single child at that level.
 */
function collapseChains(node: HeatMapNode): void {
  for (let i = 0; i < node.children.length; i++) {
    let child = node.children[i]
    while (
      child.kind === 'folder' &&
      child.children.length === 1 &&
      child.children[0].kind === 'folder'
    ) {
      const only = child.children[0]
      child = {
        ...only,
        name: `${child.name}/${only.name}`,
      }
      node.children[i] = child
    }
    collapseChains(child)
  }
}

/** Changed entries lead, hottest first; unchanged follow, largest first. */
function sortByHeat(node: HeatMapNode): void {
  node.children.sort(
    (a, b) =>
      Number(b.changed) - Number(a.changed) ||
      heatChanges(b) - heatChanges(a) ||
      b.totalFileCount - a.totalFileCount,
  )
  for (const child of node.children) sortByHeat(child)
}

type FileEntry = {
  changed: boolean
  additions: number
  deletions: number
  status: HeatMapNode['status']
}

/**
 * Aggregate changed files into a drillable folder tree. When `repoFilePaths`
 * (repo-relative, gitignore-filtered) is provided, unchanged repo files are
 * merged in with zero heat so the map reads as a whole-repository overview
 * rather than a changed-files-only view. Children are sorted hottest-first and
 * single-child folder chains are collapsed.
 */
export function buildHeatMapTree(
  files: FileDiffMetadata[],
  repoFilePaths?: readonly string[],
): HeatMapNode {
  const root = makeNode('', '', 'folder')
  // O(1) child lookup during construction: a hot directory would otherwise pay
  // a linear scan per inserted file (quadratic on 1k-file folders).
  const nodeByKey = new Map<string, HeatMapNode>()

  function insert(displayPath: string, entry: FileEntry): void {
    const segments = displayPath.split('/')
    root.additions += entry.additions
    root.deletions += entry.deletions
    root.totalFileCount += 1
    if (entry.changed) {
      root.changedFileCount += 1
      root.changed = true
    }
    let node = root
    for (let i = 0; i < segments.length; i++) {
      const isFile = i === segments.length - 1
      const path = segments.slice(0, i + 1).join('/')
      const key = `${isFile ? 'file' : 'folder'}:${path}`
      let child = nodeByKey.get(key)
      if (!child) {
        child = makeNode(segments[i], path, isFile ? 'file' : 'folder')
        if (isFile) child.status = entry.status
        node.children.push(child)
        nodeByKey.set(key, child)
      }
      child.additions += entry.additions
      child.deletions += entry.deletions
      child.totalFileCount += 1
      if (entry.changed) {
        child.changedFileCount += 1
        child.changed = true
      }
      node = child
    }
  }

  for (const file of files) {
    const stats = diffFileStats(file)
    insert(toTreeDisplayPath(diffFilePath(file)), {
      changed: true,
      additions: stats.additions,
      deletions: stats.deletions,
      status: diffFileStatus(file),
    })
  }

  if (repoFilePaths) {
    for (const rawPath of repoFilePaths) {
      const displayPath = toTreeDisplayPath(rawPath)
      if (!displayPath || nodeByKey.has(`file:${displayPath}`)) continue
      insert(displayPath, { changed: false, additions: 0, deletions: 0, status: null })
    }
  }

  collapseChains(root)
  sortByHeat(root)
  return root
}

/** Resolve a drill path to its (possibly chain-collapsed) folder node. */
export function heatNodeAtPath(root: HeatMapNode, path: string): HeatMapNode | null {
  if (!path) return root
  let node = root
  while (node.path !== path) {
    const next = node.children.find(
      (c) => c.kind === 'folder' && (c.path === path || path.startsWith(`${c.path}/`)),
    )
    if (!next) return null
    node = next
  }
  return node
}

/** Folder nodes from the root (exclusive) down to `path` (inclusive). */
export function heatBreadcrumb(root: HeatMapNode, path: string): HeatMapNode[] {
  if (!path) return []
  const trail: HeatMapNode[] = []
  let node = root
  while (node.path !== path) {
    const next = node.children.find(
      (c) => c.kind === 'folder' && (c.path === path || path.startsWith(`${c.path}/`)),
    )
    if (!next) return trail
    trail.push(next)
    node = next
  }
  return trail
}

/**
 * Relative heat of a node against the hottest sibling at the current level,
 * log-scaled so one huge lockfile change doesn't wash every other cell out.
 */
export function heatIntensity(node: HeatMapNode, siblingMaxChanges: number): number {
  const changes = heatChanges(node)
  if (siblingMaxChanges <= 0 || changes <= 0) return 0
  return Math.log1p(changes) / Math.log1p(siblingMaxChanges)
}

export type TreemapRect = {
  node: HeatMapNode
  left: number
  top: number
  width: number
  height: number
}

/**
 * Squarified treemap layout (Bruls et al.): lays hottest-first children into
 * rows along the shorter side, keeping cell aspect ratios near 1. Cell area
 * grows with the square root of (change volume + file count): change mass
 * dominates for touched entries without crushing siblings into slivers, while
 * untouched folders keep an area proportional to their size in the repo. Heat
 * itself is carried by the tint, not the area.
 */
export function layoutTreemap(
  children: HeatMapNode[],
  width: number,
  height: number,
): TreemapRect[] {
  if (children.length === 0 || width <= 0 || height <= 0) return []
  const areas = children.map((c) => Math.sqrt(Math.max(1, heatChanges(c) + c.totalFileCount)))
  const total = areas.reduce((sum, a) => sum + a, 0)
  const scale = (width * height) / total
  const scaled = areas.map((a) => a * scale)

  const rects: TreemapRect[] = []
  let left = 0
  let top = 0
  let freeWidth = width
  let freeHeight = height
  let row: number[] = []
  let rowStart = 0

  const worstRatio = (rowAreas: number[], side: number): number => {
    const sum = rowAreas.reduce((s, a) => s + a, 0)
    const thickness = sum / side
    let worst = 0
    for (const a of rowAreas) {
      const cellLength = a / thickness
      const ratio = Math.max(thickness / cellLength, cellLength / thickness)
      if (ratio > worst) worst = ratio
    }
    return worst
  }

  const flushRow = (rowAreas: number[], startIndex: number): void => {
    const sum = rowAreas.reduce((s, a) => s + a, 0)
    const horizontal = freeWidth >= freeHeight
    const side = horizontal ? freeHeight : freeWidth
    const thickness = side > 0 ? sum / side : 0
    let offset = 0
    for (let i = 0; i < rowAreas.length; i++) {
      const cellLength = thickness > 0 ? rowAreas[i] / thickness : 0
      rects.push({
        node: children[startIndex + i],
        left: horizontal ? left : left + offset,
        top: horizontal ? top + offset : top,
        width: horizontal ? thickness : cellLength,
        height: horizontal ? cellLength : thickness,
      })
      offset += cellLength
    }
    if (horizontal) {
      left += thickness
      freeWidth -= thickness
    } else {
      top += thickness
      freeHeight -= thickness
    }
  }

  for (let i = 0; i < scaled.length; i++) {
    const side = Math.min(freeWidth, freeHeight)
    const candidate = [...row, scaled[i]]
    if (row.length === 0 || worstRatio(candidate, side) <= worstRatio(row, side)) {
      row = candidate
    } else {
      flushRow(row, rowStart)
      rowStart = i
      row = [scaled[i]]
    }
  }
  if (row.length > 0) flushRow(row, rowStart)
  return rects
}
