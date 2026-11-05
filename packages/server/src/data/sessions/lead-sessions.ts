import { sql } from 'drizzle-orm'
import { getDatabase } from '../../db/database'
import { session } from './schema'
import { machineSessionHome } from './session-identity'

/**
 * Which sessions are leads (docs/plans/lead-session.md). A person chooses it
 * in the composer before the first message, the first prompt carries it, and
 * the runner marks the session here, on its row (`lead_started_at`). The mark
 * is never removed: a lead's thread is built on the lead contract from its
 * first turn, and a session that stopped being a lead mid-way would hold
 * reports nobody reads.
 */

const leads = new Map<string, boolean>()

/** Mark a session as a lead. A session that is one already keeps its first
 *  mark, whatever organization a repeat names; a session with no row yet gets
 *  one, as this machine's own. */
export async function markSessionLead(sessionId: string, organizationId = 'local'): Promise<void> {
  const now = Date.now()
  await getDatabase().run(sql`
    INSERT INTO ${session} (session_id, organization_id, created_by, created_at, lead_started_at)
    VALUES (${sessionId}, ${organizationId}, ${machineSessionHome().ownerKey}, ${now}, ${now})
    ON CONFLICT(session_id) DO UPDATE SET lead_started_at = COALESCE(session_records.lead_started_at, excluded.lead_started_at)
  `)
  leads.set(sessionId, true)
}

/** Whether a session is a lead. Read on every run and on every report the
 *  orchestrator delivers, so a hit is remembered; a miss is asked again, since
 *  the mark can arrive after the first ask. */
export async function isLeadSession(sessionId: string): Promise<boolean> {
  if (leads.get(sessionId)) return true
  const row = await getDatabase().get<{ session_id: string }>(sql`
    SELECT session_id FROM ${session} WHERE session_id = ${sessionId} AND lead_started_at IS NOT NULL
  `)
  const isLead = !!row
  if (isLead) leads.set(sessionId, true)
  return isLead
}

/** The session's row is gone, and its mark with it. */
export function forgetLeadSession(sessionId: string): void {
  leads.delete(sessionId)
}

/** Tests: forget what was remembered. */
export function resetLeadSessionCache(): void {
  leads.clear()
}
