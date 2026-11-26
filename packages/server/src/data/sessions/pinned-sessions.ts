import { sql } from 'drizzle-orm'
import type { PinnedSession } from '@solus/contracts/types'
import { getDatabase } from '../../db/database'
import { personalResourceState } from '../personal-state/schema'
import { session } from './schema'
import { organizationOfSession } from './session-records'
import { z } from 'zod'
import { agentIdSchema } from '@solus/contracts/types'

/**
 * A person's pins are `pinned_at` on their own `personal_resource_state` row
 * of a session, beside their settle and archive. Archive ends the pin.
 * The label, folder, and model are read from the session record, so a rename
 * reaches the pin with no write of its own. A session with no started record
 * has nothing to show, so its pin is not listed.
 */

const pinnedSessionRowsSchema = z.array(z.object({
  session_id: z.string(),
  provider: agentIdSchema,
  model: z.string().nullable(),
  title: z.string(),
  cwd: z.string(),
  pinned_at: z.number(),
}))

/** One person's pinned sessions, most-recently-pinned first. The client stamps the host that answered. */
export async function readPinnedSessions(personKey: string): Promise<PinnedSession[]> {
  const rows = pinnedSessionRowsSchema.parse(await getDatabase().all(sql`
    SELECT
      session_records.session_id,
      session_records.provider,
      session_records.model,
      COALESCE(session_records.custom_title, session_records.title, session_records.slug, '') AS title,
      COALESCE(session_records.cwd, session_records.project_path) AS cwd,
      personal_resource_state.pinned_at
    FROM ${personalResourceState}
    JOIN ${session} ON session_records.session_id = personal_resource_state.resource_id
    WHERE personal_resource_state.created_by = ${personKey} AND personal_resource_state.resource_kind = 'session'
      AND personal_resource_state.pinned_at IS NOT NULL AND personal_resource_state.archived_at IS NULL
      AND session_records.started_at IS NOT NULL
    ORDER BY personal_resource_state.pinned_at DESC
  `))
  return rows.map((row) => {
    const pin: PinnedSession = {
      sessionId: row.session_id,
      provider: row.provider,
      title: row.title,
      cwd: row.cwd,
      pinnedAt: row.pinned_at,
    }
    if (row.model !== null) pin.model = row.model
    return pin
  })
}

type PinListener = (change: { personKey: string; sessionId: string }) => void
const pinListeners = new Set<PinListener>()

/** Hear each pin and unpin. Only that person's list changes. */
export function onPinnedSessionChanged(listener: PinListener): () => void {
  pinListeners.add(listener)
  return () => pinListeners.delete(listener)
}

/** Pin the session for this person, or unpin it when it is pinned. An undo
 *  sends the pin's old time, so the row returns to its own place. */
export async function togglePinnedSession(personKey: string, pin: Pick<PinnedSession, 'sessionId' | 'pinnedAt'>): Promise<PinnedSession[]> {
  const database = getDatabase()
  const unpinned = (await database.run(sql`
    UPDATE ${personalResourceState} SET pinned_at = NULL
    WHERE resource_kind = 'session' AND resource_id = ${pin.sessionId} AND created_by = ${personKey}
      AND pinned_at IS NOT NULL AND archived_at IS NULL
  `)).changes > 0
  if (!unpinned) {
    const organizationId = await organizationOfSession(pin.sessionId)
    const pinned = (await database.run(sql`
      INSERT INTO ${personalResourceState} (organization_id, resource_kind, resource_id, created_by, pinned_at)
      VALUES (${organizationId}, 'session', ${pin.sessionId}, ${personKey}, ${pin.pinnedAt})
      ON CONFLICT (organization_id, resource_kind, resource_id, created_by) DO UPDATE SET pinned_at = excluded.pinned_at
      WHERE personal_resource_state.archived_at IS NULL
    `)).changes > 0
    if (!pinned) throw new Error('Return the session to the list before pinning it.')
  }
  for (const listener of pinListeners) listener({ personKey, sessionId: pin.sessionId })
  return readPinnedSessions(personKey)
}
