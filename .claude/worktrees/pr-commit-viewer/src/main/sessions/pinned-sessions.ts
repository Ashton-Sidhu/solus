import type { AgentId, PinnedSession } from '../../shared/types'
import { getDb, withTx } from '../db'

interface PinnedSessionRow {
  session_id: string
  server_id: string
  provider: AgentId
  title: string
  cwd: string
  pinned_at: number
}

/** Pinned sessions, most-recently-pinned first. */
export async function readManifest(): Promise<PinnedSession[]> {
  const rows = getDb().prepare(`
    SELECT session_id, server_id, provider, title, cwd, pinned_at
    FROM pinned_sessions
    ORDER BY pinned_at DESC
  `).all() as unknown as PinnedSessionRow[]
  return rows.map((row) => ({
    sessionId: row.session_id,
    serverId: row.server_id || undefined,
    provider: row.provider,
    title: row.title,
    cwd: row.cwd,
    pinnedAt: row.pinned_at,
  }))
}

/** Keep a pin's label in step with the session it points at. The pin stores its
 *  own title (it must render without the session index), so a rename has to
 *  reach in here too or the pinned row keeps the old name forever. */
export function renamePinnedSession(sessionId: string, title: string): void {
  getDb().prepare('UPDATE pinned_sessions SET title = ? WHERE session_id = ?').run(title, sessionId)
}

export async function togglePinnedSession(session: PinnedSession): Promise<PinnedSession[]> {
  withTx(() => {
    const db = getDb()
    const serverId = session.serverId ?? ''
    const deleted = db.prepare(
      'DELETE FROM pinned_sessions WHERE session_id = ? AND server_id = ?',
    ).run(session.sessionId, serverId)
    if (deleted.changes === 0) {
      db.prepare(`
        INSERT INTO pinned_sessions (session_id, server_id, provider, title, cwd, pinned_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        session.sessionId,
        serverId,
        session.provider,
        session.title,
        session.cwd,
        session.pinnedAt,
      )
    }
  })
  return readManifest()
}
