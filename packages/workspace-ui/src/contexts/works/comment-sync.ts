import type { PlanComment } from '@solus/contracts/types'

/**
 * Bring the store's thread list to what the host answered, touching as little as
 * possible. The list is inside a `$state` proxy and every card in a rail reads
 * its own thread, so a thread the host did not change must stay the same object
 * with the same fields; rebuilding the array would invalidate every card for
 * one person's reply.
 */
export function reconcileComments(target: PlanComment[], next: readonly PlanComment[]): void {
  const wanted = new Set(next.map((comment) => comment.id))
  for (let index = target.length - 1; index >= 0; index--) {
    if (!wanted.has(target[index]!.id)) target.splice(index, 1)
  }
  next.forEach((incoming, index) => {
    const at = target.findIndex((comment) => comment.id === incoming.id)
    if (at === -1) {
      target.splice(index, 0, { ...incoming })
      return
    }
    if (at !== index) {
      const [moved] = target.splice(at, 1)
      target.splice(index, 0, moved!)
    }
    assignChanged(target[index]!, incoming)
  })
}

/** Every field a thread can carry. Listed, not read off an object, so the
 *  reconcile touches exactly the contract and nothing a stale host added. */
const COMMENT_FIELDS: readonly (keyof PlanComment)[] = [
  'externalThreadId', 'googleThreadId', 'id', 'selectedText', 'comment', 'textOffset', 'nodeId', 'edgeId', 'pin',
  'author', 'authorAgent', 'person', 'createdAt', 'resolvedAt', 'resolvedBy', 'resolvedByPerson', 'replies', 'readAt', 'readBy',
]

function assignChanged(current: PlanComment, incoming: PlanComment): void {
  for (const field of COMMENT_FIELDS) {
    if (incoming[field] === undefined) {
      if (current[field] !== undefined) delete current[field]
      continue
    }
    // Replies, read marks, and people are small; a value compare keeps an
    // unchanged one from re-rendering the thread's reply column.
    if (JSON.stringify(current[field]) !== JSON.stringify(incoming[field])) assignField(current, incoming, field)
  }
}

function assignField<K extends keyof PlanComment>(target: PlanComment, source: PlanComment, field: K): void {
  target[field] = source[field]
}
