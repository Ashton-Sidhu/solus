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

/** A point in history a reader can pick: a checkpoint, or the current body. */
export type HistoryPoint = number | 'current'

/**
 * The points the History list shows, newest first. The current body leads
 * the list when no checkpoint holds it yet (a person's edits since the last
 * checkpoint); otherwise the newest checkpoint stands for it.
 */
export function historyPoints(rows: readonly WorkRevisionSummary[], currentHash: string, hasDraftChanges = false): HistoryPoint[] {
  const points: HistoryPoint[] = rows.map((row) => row.revisionId)
  if (hasDraftChanges || rows[0]?.contentHash !== currentHash) points.unshift('current')
  return points
}

/** Undefined follows the selected version; null explicitly selects an empty body. */
export function comparisonBase(points: readonly HistoryPoint[], picked: HistoryPoint | null, chosen: HistoryPoint | null | undefined): HistoryPoint | null {
  if (chosen === null) return null
  if (chosen !== undefined && points.includes(chosen) && chosen !== picked) return chosen
  return picked === null ? null : pointBefore(points, picked)
}

/** What a picked point is compared against by default: the point before it,
 *  so a row shows the change it made. The oldest point has none. */
export function pointBefore(points: readonly HistoryPoint[], picked: HistoryPoint): HistoryPoint | null {
  const index = points.indexOf(picked)
  return index < 0 ? null : points[index + 1] ?? null
}
