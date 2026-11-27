import type { SessionDelegation } from '@solus/contracts/types'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { getDb } from '../../db'
import { activeThreadOf } from './session-lineage'

/** What a child records about the session that created it, known before it starts. */
export interface SessionDelegationStart {
  /** The parent session (docs/plans/session-identity.md). */
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

/** Where a child sits in its parent's tree: under the parent, in its root, one level below it. */
export type SessionChildColumns = Pick<SessionDelegationColumns, 'parentSessionId' | 'rootSessionId' | 'depth'>

/**
 * The child inherits its parent's root and sits one level below it. Written with
 * the child's first index row (`persistIndexedSessionStart`), so the child is
 * never indexed without its parent. Provider-index upserts later leave these
 * columns alone, so the relation survives history refreshes.
 */
export function childColumnsFor(parentSessionId: string, db: DatabaseSync = getDb()): SessionChildColumns {
  const parent = parentRowSchema.nullish().parse(db.prepare(`
    SELECT root_session_id, delegation_depth
    FROM transcript_index
    WHERE session_id = ?
  `).get(activeThreadOf(parentSessionId, db) ?? parentSessionId))
  return {
    parentSessionId,
    rootSessionId: parent?.root_session_id ?? parentSessionId,
    depth: (parent?.delegation_depth ?? 0) + 1,
  }
}

/** A delegated child's columns: its place in the tree and the message that created it. */
export function delegationColumnsFor(start: SessionDelegationStart, db: DatabaseSync = getDb()): SessionDelegationColumns {
  return { ...childColumnsFor(start.parentSessionId, db), messageId: start.messageId, intent: start.intent, createdAt: start.createdAt }
}
