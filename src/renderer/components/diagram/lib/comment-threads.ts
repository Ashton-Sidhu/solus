import type { PlanComment } from '../../../../shared/types'
import { commentAuthor, isResolved, isUnread } from '../../comments/lib/thread'

/**
 * What a thread reads as. One rule, four surfaces — the canvas pin, the thread
 * card, the Comments tab row and the rail badge all take their tint from here,
 * so a thread can never look open in one place and resolved in another.
 */
export type ThreadTone = 'open' | 'resolved' | 'agent'

export function threadTone(comment: PlanComment): ThreadTone {
  if (isResolved(comment)) return 'resolved'
  return commentAuthor(comment) === 'solus' ? 'agent' : 'open'
}

/** The single pin a node carries, however many threads are attached to it. */
export interface PinSummary {
  tone: ThreadTone
  count: number
  unread: boolean
}

/**
 * Collapse every thread on one anchor into the one pin that rides its corner.
 * Resolved work should not add dots to the graph, so resolved threads only
 * count while `showResolved` is on — and a node whose threads are all resolved
 * then has no pin at all.
 */
export function pinSummary(threads: PlanComment[], showResolved: boolean): PinSummary | null {
  const visible = showResolved ? threads : threads.filter((t) => !isResolved(t))
  if (visible.length === 0) return null
  const tones = visible.map(threadTone)
  // An unresolved human thread is the loudest thing on the node, then an agent
  // note, then a settled conversation — the pin shows the one that still wants
  // something from the reader.
  const tone: ThreadTone = tones.includes('open')
    ? 'open'
    : tones.includes('agent')
      ? 'agent'
      : 'resolved'
  return { tone, count: visible.length, unread: visible.some(isUnread) }
}

/** The anchor a thread is attached to: a node, an edge, or the diagram itself. */
export function anchorId(comment: PlanComment): string | null {
  return comment.nodeId ?? comment.edgeId ?? null
}

/**
 * Threads keyed by the node or edge they ride. Whole-diagram threads have no
 * anchor and are deliberately absent — they belong to the diagram-wide list,
 * not to any card on the canvas.
 */
export function threadsByAnchor(comments: PlanComment[]): Map<string, PlanComment[]> {
  const byAnchor = new Map<string, PlanComment[]>()
  for (const comment of comments) {
    const id = anchorId(comment)
    if (id === null) continue
    const bucket = byAnchor.get(id)
    if (bucket) bucket.push(comment)
    else byAnchor.set(id, [comment])
  }
  return byAnchor
}

export interface ThreadCounts {
  /** Unresolved threads across the whole diagram — what the pill reports. */
  total: number
  unread: number
}

export function threadCounts(comments: PlanComment[]): ThreadCounts {
  const open = comments.filter((c) => !isResolved(c))
  return { total: open.length, unread: open.filter(isUnread).length }
}

/** The thread the threads pill scopes to. */
export function firstUnreadThread(comments: PlanComment[]): PlanComment | undefined {
  return comments.find((c) => !isResolved(c) && isUnread(c))
}
