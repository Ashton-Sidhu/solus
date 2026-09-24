import type { SessionDelegation } from '@solus/contracts/types'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { getDb } from '../db'

/** What a child records about the session that created it, known before it starts. */
export interface SessionDelegationStart {
  /** The parent's provider thread, the key the session index uses. */
  parentSessionId: string
  messageId: string
  intent: SessionDelegation['intent']
  createdAt: number
}

/** The delegation columns of a child's first `sessions` row. */
export interface SessionDelegationColumns {
  parentSessionId: string
  rootSessionId: string
  messageId: string
  depth: number
  intent: SessionDelegation['intent']
  createdAt: number
}

const parentRowSchema = z.object({
  root_session_id: z.string().nullable(),
  delegation_depth: z.number().nullable(),
})

/**
 * The child inherits its parent's root and sits one level below it. Written with
 * the child's first index row (`persistIndexedSessionStart`), so the child is
 * never indexed without its parent. Provider-index upserts later leave these
 * columns alone, so the relation survives history refreshes.
 */
export function delegationColumnsFor(start: SessionDelegationStart, db: DatabaseSync = getDb()): SessionDelegationColumns {
  const parent = parentRowSchema.nullish().parse(db.prepare(`
    SELECT root_session_id, delegation_depth
    FROM sessions
    WHERE session_id = ?
  `).get(start.parentSessionId))
  return {
    parentSessionId: start.parentSessionId,
    rootSessionId: parent?.root_session_id ?? start.parentSessionId,
    messageId: start.messageId,
    depth: (parent?.delegation_depth ?? 0) + 1,
    intent: start.intent,
    createdAt: start.createdAt,
  }
}
