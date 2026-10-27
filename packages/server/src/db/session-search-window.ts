import { z } from 'zod'
import type { SessionMessageWindow } from '@solus/contracts/session-history'
import type { SessionSearchTarget } from '@solus/contracts/session-search'
import { sessionIdOfThread } from '../data/sessions/session-lineage'
import { getDb } from '.'
const countRowSchema = z.object({ count: z.number() })
const indexedMessageRowSchema = z.object({
  id: z.number(),
  role: z.enum(['user', 'assistant']),
  ts: z.number().nullable(),
  text: z.string(),
})

const MAX_WINDOW_RADIUS = 5

/**
 * The messages around one message of a session, for a preview that opens on
 * a search hit instead of on the transcript's ends.
 *
 * Rows are written in transcript order — a re-index replaces every row of the
 * session in one pass and a tail read appends — so the row id is the position
 * and the neighbours are the ids either side. Empty when the id is gone: the
 * session was re-indexed after the search that named it.
 */
export function getSessionMessageWindow(
  sessionId: string,
  messageId: number,
  radius = 1,
  target?: SessionSearchTarget,
): SessionMessageWindow {
  const db = getDb()
  if (target) {
    if (sessionIdOfThread(target.sourceSessionId) !== sessionIdOfThread(sessionId)) return { messages: [], hiddenBefore: 0, hiddenAfter: 0 }
    sessionId = target.sourceSessionId
    const found = target.messageId
      ? db.prepare('SELECT id FROM session_messages WHERE session_id = ? AND uuid = ? LIMIT 1').get(sessionId, target.messageId)
      : db.prepare('SELECT id FROM session_messages WHERE session_id = ? AND role = ? AND ts = ? AND substr(text, 1, length(?)) = ? LIMIT 1').get(sessionId, target.role, target.timestamp, target.text, target.text)
    if (!found) return { messages: [], hiddenBefore: 0, hiddenAfter: 0 }
    messageId = Number(found.id)
  }
  const span = Math.min(MAX_WINDOW_RADIUS, Math.max(0, Math.trunc(radius)))
  const hit = indexedMessageRowSchema.nullish().parse(db.prepare(`
    SELECT id, role, ts, text FROM session_messages WHERE session_id = ? AND id = ?
  `).get(sessionId, messageId))
  if (!hit) return { messages: [], hiddenBefore: 0, hiddenAfter: 0 }
  const before = indexedMessageRowSchema.array().parse(db.prepare(`
    SELECT id, role, ts, text FROM session_messages
    WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?
  `).all(sessionId, messageId, span)).reverse()
  const after = indexedMessageRowSchema.array().parse(db.prepare(`
    SELECT id, role, ts, text FROM session_messages
    WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?
  `).all(sessionId, messageId, span))
  const countBefore = countRowSchema.parse(db.prepare(`
    SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND id < ?
  `).get(sessionId, messageId)).count
  const countAfter = countRowSchema.parse(db.prepare(`
    SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND id > ?
  `).get(sessionId, messageId)).count
  return {
    hitMessageId: messageId,
    messages: [...before, hit, ...after].map((row) => ({
      messageId: row.id,
      role: row.role,
      ts: row.ts,
      text: row.text,
    })),
    hiddenBefore: countBefore - before.length,
    hiddenAfter: countAfter - after.length,
  }
}

