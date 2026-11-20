import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { getDb } from '../../db'

const rowSchema = z.object({
  repository: z.string(), head: z.string().nullable(), turn_count: z.number(), push_refused_head: z.string().nullable(),
})

/**
 * What this host records of one session repository in `session_storage`
 * (docs/plans/portable-sessions.md §6.2). A read opens no Git repository.
 */
export interface SessionStorageRow {
  /** The name of the local copy. */
  repository: string
  /** The newest turn commit this host recorded; null before the first. */
  head: string | null
  /** The number of turn commits at `head`. */
  turnCount: number
  /** The cloud head that refused the push of this host; null when none did. */
  pushRefusedHead: string | null
}

/** Null for a session with no local copy. */
export function readSessionStorage(sessionId: string, database: DatabaseSync = getDb()): SessionStorageRow | null {
  const row = rowSchema.nullish().parse(database.prepare(
    'SELECT repository, head, turn_count, push_refused_head FROM session_storage WHERE session_id = ?').get(sessionId))
  return row ? { repository: row.repository, head: row.head, turnCount: row.turn_count, pushRefusedHead: row.push_refused_head } : null
}
