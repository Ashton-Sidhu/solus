import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { SessionHistoryPage, SessionTurnDiffRef } from '@solus/contracts/session-history'
import type { SessionTurnDiff } from '@solus/contracts/session-repositories'
import type { RecordScope } from '../../admission/principal'
import { getDatabase } from '../../db/database'
import { scopeClause } from '../scope'
import { transcriptRowTimestamp } from './transcript-reads'
import { sessionTurnDiffs } from './transcript-schema'

/**
 * The reads of the mirrored turn diffs (`session_turn_diffs`): the code changes
 * of one ended turn, for a reader with no host online. The scope is the mirror
 * scope of the session, as for its rows (`transcript-reads.ts`).
 */

const diffRowSchema = z.object({ patch: z.string().nullable(), files_changed: z.coerce.number(), additions: z.coerce.number(), deletions: z.coerce.number() })
const refRowSchema = z.object({ turn_index: z.coerce.number(), ended_at: z.coerce.number() })

/** The diff of one turn: its patch, its counts when the patch was too large to mirror, or `not-available` when the mirror has none. */
export async function readTurnDiff(scope: RecordScope, sessionId: string, turnIndex: number): Promise<SessionTurnDiff> {
  const row = diffRowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT patch, files_changed, additions, deletions FROM ${sessionTurnDiffs}
    WHERE ${scopeClause(scope)} AND session_id = ${sessionId} AND turn_index = ${turnIndex}
  `))
  if (!row) return { status: 'not-available' }
  if (row.patch === null) return { status: 'too-large', filesChanged: row.files_changed, additions: row.additions, deletions: row.deletions }
  return { status: 'available', patch: row.patch }
}

/** The turns that ended at or after `from` and before `until`, oldest first: the diffs a history page of that time holds. */
export async function turnDiffsEndedIn(scope: RecordScope, sessionId: string, window: { from: number; until?: number }): Promise<SessionTurnDiffRef[]> {
  const before = window.until === undefined ? sql`` : sql`AND ended_at < ${window.until}`
  const rows = refRowSchema.array().parse(await getDatabase().all(sql`
    SELECT turn_index, ended_at FROM ${sessionTurnDiffs}
    WHERE ${scopeClause(scope)} AND session_id = ${sessionId} AND ended_at >= ${window.from} ${before}
    ORDER BY turn_index
  `))
  return rows.map((row) => ({ turnIndex: row.turn_index, endedAt: row.ended_at }))
}

/**
 * The turn diffs of one mirrored history page (`readTranscriptPage`): the turns
 * that ended from its first row up to the first row of the next newer page,
 * which the cursor `before` names. Each diff is thus on one page only.
 */
export async function turnDiffsOfPage(scope: RecordScope, sessionId: string, page: SessionHistoryPage, before?: string): Promise<SessionTurnDiffRef[]> {
  const from = page.messages[0]?.timestamp
  if (from === undefined) return []
  const until = before === undefined ? undefined : await transcriptRowTimestamp(scope, sessionId, before)
  return turnDiffsEndedIn(scope, sessionId, { from, until })
}
