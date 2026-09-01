import type { AgentId, PinnedSession } from '../../shared/types'
import { getDb, withTx } from '../db'

interface PinnedSessionRow {
  session_id: string
  provider: AgentId
  title: string
  cwd: string
  pinned_at: number
}

/** Pinned sessions, most-recently-pinned first. */
export async function readManifest(): Promise<PinnedSession[]> {
  const rows = getDb().prepare(`
    SELECT session_id, provider, title, cwd, pinned_at
    FROM pinned_sessions
    ORDER BY pinned_at DESC
  `).all() as unknown as PinnedSessionRow[]
  return rows.map((row) => ({
    sessionId: row.session_id,
    provider: row.provider,
    title: row.title,
    cwd: row.cwd,
    pinnedAt: row.pinned_at,
  }))
}

export async function togglePinnedSession(session: PinnedSession): Promise<PinnedSession[]> {
  withTx(() => {
    const db = getDb()
    const deleted = db.prepare('DELETE FROM pinned_sessions WHERE session_id = ?').run(session.sessionId)
    if (deleted.changes === 0) {
      db.prepare(`
        INSERT INTO pinned_sessions (session_id, provider, title, cwd, pinned_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(session.sessionId, session.provider, session.title, session.cwd, session.pinnedAt)
    }
  })
  return readManifest()
}
