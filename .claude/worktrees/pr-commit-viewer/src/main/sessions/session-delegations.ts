import type { SessionDelegation } from '../../shared/types'
import { getDb } from '../db'

export interface RecordSessionDelegationInput {
  childSessionId: string
  parentSessionId: string
  exchangeId: string
  intent: SessionDelegation['intent']
  createdAt: number
}

interface DelegationRow {
  root_session_id: string | null
  delegation_depth: number | null
}

/** Persist lineage after the child provider has issued its real session id.
 * Existing provider-index upserts do not touch these columns, so the relation
 * survives history refreshes without changing provider-owned transcripts. */
export function recordSessionDelegation(input: RecordSessionDelegationInput): boolean {
  const db = getDb()
  const parent = db.prepare(`
    SELECT root_session_id, delegation_depth
    FROM sessions
    WHERE session_id = ?
  `).get(input.parentSessionId) as DelegationRow | undefined
  const rootSessionId = parent?.root_session_id ?? input.parentSessionId
  const depth = (parent?.delegation_depth ?? 0) + 1
  const result = db.prepare(`
    UPDATE sessions
    SET parent_session_id = ?,
        root_session_id = ?,
        delegation_exchange_id = ?,
        delegation_depth = ?,
        delegation_intent = ?,
        delegation_created_at = ?
    WHERE session_id = ?
  `).run(
    input.parentSessionId,
    rootSessionId,
    input.exchangeId,
    depth,
    input.intent,
    input.createdAt,
    input.childSessionId,
  )
  return result.changes > 0
}
