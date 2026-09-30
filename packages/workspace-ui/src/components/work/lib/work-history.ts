import { parseDiagram, type DiagramDoc } from '@solus/contracts/diagram-types'
import type { WorkRevisionReason, WorkRevisionSummary } from '@solus/contracts/types'

/** What a history row says a checkpoint is. */
export function revisionReasonLabel(reason: WorkRevisionReason): string {
  switch (reason) {
    case 'baseline': return 'Created'
    case 'checkpoint': return 'Saved'
    case 'agent': return 'Agent edit'
    case 'upstream': return 'Pulled from upstream'
    case 'review': return 'Sent for review'
    case 'restore': return 'Restored'
  }
}

/**
 * The history a reader sees: newest first, and one row per distinct body. A
 * `checkpoint` holds the body a later write displaced, so it repeats the
 * body of the row before it when nothing changed between them; that repeat
 * is not a version anybody made.
 */
export function historyRows(revisions: readonly WorkRevisionSummary[]): WorkRevisionSummary[] {
  const rows: WorkRevisionSummary[] = []
  for (const revision of revisions) {
    const previous = rows.at(-1)
    if (previous && revision.reason === 'checkpoint' && previous.contentHash === revision.contentHash) continue
    rows.push(revision)
  }
  return rows.reverse()
}

export type BlockChange = 'same' | 'added' | 'removed'

export interface MarkdownBlockDiff {
  change: BlockChange
  markdown: string
}

/**
 * The top-level blocks of a markdown body: runs separated by blank lines. A
 * fenced block is one block, whatever blank lines it holds.
 */
export function markdownBlocks(markdown: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let fence: string | null = null
  const flush = () => {
    if (current.length > 0) blocks.push(current.join('\n'))
    current = []
  }
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      current.push(line)
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (marker) fence = marker
    if (!fence && line.trim() === '') {
      flush()
      continue
    }
    current.push(line)
  }
  flush()
  return blocks
}

/**
 * A rendered comparison of two markdown bodies, block by block: every block of
 * both, in reading order, marked as kept, added, or removed. Blocks match by
 * their exact text (longest common subsequence), so an edited paragraph shows
 * as its old form removed and its new form added.
 */
export function markdownBlockDiff(before: string, after: string): MarkdownBlockDiff[] {
  const a = markdownBlocks(before)
  const b = markdownBlocks(after)
  // lengths[i][j]: the common subsequence of a[i..] and b[j..].
  const lengths = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }
  const out: MarkdownBlockDiff[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ change: 'same', markdown: a[i]! })
      i++
      j++
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      out.push({ change: 'removed', markdown: a[i++]! })
    } else {
      out.push({ change: 'added', markdown: b[j++]! })
    }
  }
  while (i < a.length) out.push({ change: 'removed', markdown: a[i++]! })
  while (j < b.length) out.push({ change: 'added', markdown: b[j++]! })
  return out
}

export interface DiagramItemChange {
  change: Exclude<BlockChange, 'same'> | 'changed'
  kind: 'node' | 'edge'
  id: string
  label: string
}

export interface DiagramRevisionDiff {
  changes: DiagramItemChange[]
  /** Node and edge ids per change, for marking them on the canvas. */
  added: Set<string>
  removed: Set<string>
  changed: Set<string>
}

/**
 * What changed between two diagram bodies, by node and edge id. A node whose
 * fields differ (label, position, detail, …) is `changed`. A body that does
 * not parse compares as empty.
 */
export function diagramRevisionDiff(before: string, after: string): DiagramRevisionDiff {
  const a = safeDiagram(before)
  const b = safeDiagram(after)
  const result: DiagramRevisionDiff = { changes: [], added: new Set(), removed: new Set(), changed: new Set() }
  const compare = <T extends { id: string }>(kind: 'node' | 'edge', from: T[], to: T[], label: (item: T) => string) => {
    const old = new Map(from.map((item) => [item.id, item]))
    const next = new Map(to.map((item) => [item.id, item]))
    for (const item of to) {
      const prior = old.get(item.id)
      if (!prior) {
        result.changes.push({ change: 'added', kind, id: item.id, label: label(item) })
        result.added.add(item.id)
      } else if (JSON.stringify(prior) !== JSON.stringify(item)) {
        result.changes.push({ change: 'changed', kind, id: item.id, label: label(item) })
        result.changed.add(item.id)
      }
    }
    for (const item of from) {
      if (next.has(item.id)) continue
      result.changes.push({ change: 'removed', kind, id: item.id, label: label(item) })
      result.removed.add(item.id)
    }
  }
  const nodeLabels = new Map([...a.nodes, ...b.nodes].map((node) => [node.id, node.label || node.id]))
  compare('node', a.nodes, b.nodes, (node) => node.label || node.id)
  compare('edge', a.edges, b.edges, (edge) => edge.label || `${nodeLabels.get(edge.source) ?? edge.source} → ${nodeLabels.get(edge.target) ?? edge.target}`)
  return result
}

function safeDiagram(content: string): DiagramDoc {
  try {
    return parseDiagram(content)
  } catch {
    return { nodes: [], edges: [] }
  }
}

/** A point in history a reader can pick: a checkpoint, or the current body. */
export type HistoryPoint = number | 'current'

/**
 * The points the History list shows, newest first. The current body leads
 * the list when no checkpoint holds it yet (a person's edits since the last
 * checkpoint); otherwise the newest checkpoint stands for it.
 */
export function historyPoints(rows: readonly WorkRevisionSummary[], currentHash: string): HistoryPoint[] {
  const points: HistoryPoint[] = rows.map((row) => row.revisionId)
  if (rows[0]?.contentHash !== currentHash) points.unshift('current')
  return points
}

/** What a picked point is compared against by default: the point before it,
 *  so a row shows the change it made. The oldest point has none. */
export function pointBefore(points: readonly HistoryPoint[], picked: HistoryPoint): HistoryPoint | null {
  const index = points.indexOf(picked)
  return index < 0 ? null : points[index + 1] ?? null
}
