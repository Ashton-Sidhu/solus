import { getDb } from '../db'
import { z } from 'zod'

const viewedAtRowSchema = z.object({ viewed_at: z.number().nullable() })

/**
 * When a session was last read, or null when it never has been.
 *
 * The server owns this because a client cannot: read state that lives in one
 * renderer leaves the same session unread on every other device. Clients render
 * this value rather than a local guess, so two mounted surfaces cannot disagree.
 */
export function readViewedAt(sessionId: string): number | null {
  const row = getDb()
    .prepare('SELECT viewed_at FROM sessions WHERE session_id = ?')
    .get(sessionId)
  if (!row) return null
  const parsed = viewedAtRowSchema.safeParse(row)
  return parsed.success ? parsed.data.viewed_at : null
}

/**
 * Record that a session has been read, and answer with the boundary now in
 * force.
 *
 * Two rules make this safe to call from several clients at once. The boundary
 * is capped at server time, so a client with a fast clock cannot mark future
 * completions read. And it never moves backward, so a view that was in flight
 * while another device marked the session unread cannot undo that choice.
 *
 * Deliberately does not touch `last_timestamp`: reading a session must never
 * reorder the list the user is reading it from.
 */
export function markViewed(sessionId: string, at: number): number {
  const now = Date.now()
  const bounded = Math.min(at, now)
  const current = readViewedAt(sessionId)
  if (current !== null && current >= bounded) return current
  getDb()
    .prepare('UPDATE sessions SET viewed_at = ? WHERE session_id = ?')
    .run(bounded, sessionId)
  return bounded
}

/**
 * Return a session to unread. This is the one path allowed to move the boundary
 * backward, because it is the user saying so explicitly.
 */
export function markUnread(sessionId: string): void {
  getDb()
    .prepare('UPDATE sessions SET viewed_at = NULL WHERE session_id = ?')
    .run(sessionId)
}
