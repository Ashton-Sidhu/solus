import { sql } from 'drizzle-orm'
import { getDatabase } from '../../db/database'
import { sessionLeads } from './schema'

/**
 * Which sessions are leads (docs/plans/lead-session.md). A person chooses it
 * in the composer before the first message, the first prompt carries it, and
 * the runner marks the session here. The mark is never removed: a lead's
 * thread is built on the lead contract from its first turn, and a session
 * that stopped being a lead mid-way would hold reports nobody reads.
 */

const leads = new Map<string, boolean>()

/** Mark a session as a lead. A session that is one already stays one. */
export async function markSessionLead(sessionId: string, organizationId = 'local'): Promise<void> {
  await getDatabase().run(sql`
    INSERT INTO ${sessionLeads}(session_id, created_at, organization_id)
    VALUES (${sessionId}, ${Date.now()}, ${organizationId})
    ON CONFLICT(session_id) DO NOTHING
  `)
  leads.set(sessionId, true)
}

/** Whether a session is a lead. Read on every run and on every report the
 *  orchestrator delivers, so a hit is remembered; a miss is asked again, since
 *  the mark can arrive after the first ask. */
export async function isLeadSession(sessionId: string): Promise<boolean> {
  if (leads.get(sessionId)) return true
  const row = await getDatabase().get<{ session_id: string }>(sql`SELECT session_id FROM ${sessionLeads} WHERE session_id = ${sessionId}`)
  const isLead = !!row
  if (isLead) leads.set(sessionId, true)
  return isLead
}

/** Tests: forget what was remembered. */
export function resetLeadSessionCache(): void {
  leads.clear()
}
