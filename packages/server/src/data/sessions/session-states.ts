import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { SessionSettledBy, SessionShelfEntry, SessionState } from '@solus/contracts/session-state'
import { executionPreferencesSchema, type ExecutionPreferences } from '@solus/contracts/settings'
import { getDatabase } from '../../db/database'
import type { RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { sessionPullRequests, sessionStates } from './schema'
import { getSessionRecords, organizationOfSession } from './session-records'
import { stopSessionPullRequestWatches } from './pull-request-watches'

/**
 * Where a session is in a person's list: active, settled, or snoozed
 * (docs/plans/session-pull-requests.md).
 *
 * The host holds this because a client cannot: a session a person finished on
 * one device must leave the list on every device, and PR sync must know which
 * sessions are still live work. A session with no row is active.
 */

/** A settled session stays on a client's Completed shelf for this long. */
export const SETTLED_SHELF_MS = 90 * 24 * 60 * 60_000
/** The most sessions one shelf read answers with. */
const SHELF_LIMIT = 500

const rowSchema = z.object({
  session_id: z.string(),
  settled_at: z.number().nullable(),
  settled_by: z.enum(['person', 'pull-request', 'task', 'idle']).nullable(),
  unsettled_at: z.number().nullable(),
  snoozed_until: z.number().nullable(),
  snooze_note: z.string().nullable(),
  last_prompt_at: z.number().nullable(),
})
type Row = z.infer<typeof rowSchema>

type ChangeListener = (sessionId: string) => void
const listeners = new Set<ChangeListener>()

/** Hear each session whose state changed. */
export function onSessionStateChanged(listener: ChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitChanged(sessionId: string): void {
  for (const listener of listeners) listener(sessionId)
}

function stateFromRow(row: Row): SessionState {
  return {
    sessionId: row.session_id,
    settledAt: row.settled_at,
    settledBy: row.settled_by,
    snoozedUntil: row.snoozed_until,
    snoozeNote: row.snooze_note,
  }
}

const COLUMNS = sql`session_id, settled_at, settled_by, unsettled_at, snoozed_until, snooze_note, last_prompt_at`

async function readRow(sessionId: string): Promise<Row | null> {
  return rowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT ${COLUMNS} FROM ${sessionStates} WHERE session_id = ${sessionId}
  `)) ?? null
}

/** Make sure the session has a row, so each write below is one UPDATE. */
async function ensureRow(sessionId: string): Promise<void> {
  await getDatabase().run(sql`
    INSERT INTO ${sessionStates}(session_id, organization_id)
    VALUES (${sessionId}, ${await organizationOfSession(sessionId)})
    ON CONFLICT(session_id) DO NOTHING
  `)
}

/**
 * Settle a session: its work is finished. Returns false when it was settled
 * already. A settled session is not snoozed.
 */
export async function settleSession(sessionId: string, by: SessionSettledBy, at = Date.now()): Promise<boolean> {
  await ensureRow(sessionId)
  const changed = (await getDatabase().run(sql`
    UPDATE ${sessionStates} SET settled_at = ${at}, settled_by = ${by}, snoozed_until = NULL, snooze_note = NULL
    WHERE session_id = ${sessionId} AND settled_at IS NULL
  `)).changes > 0
  if (!changed) return false
  // A settled session's work is finished: nothing is left to wake it for.
  await stopSessionPullRequestWatches(sessionId)
  emitChanged(sessionId)
  return true
}

/**
 * Make a settled session active again, as a person asks. Its pull requests
 * settle it again only if one of them ends after this.
 */
export async function unsettleSession(sessionId: string, at = Date.now()): Promise<boolean> {
  const changed = (await getDatabase().run(sql`
    UPDATE ${sessionStates} SET settled_at = NULL, settled_by = NULL, unsettled_at = ${at}
    WHERE session_id = ${sessionId} AND settled_at IS NOT NULL
  `)).changes > 0
  if (changed) emitChanged(sessionId)
  return changed
}

/** Snooze a session until a wake time, or wake it now with `until` null. */
export async function snoozeSession(sessionId: string, until: number | null, note = ''): Promise<void> {
  await ensureRow(sessionId)
  await getDatabase().run(sql`
    UPDATE ${sessionStates} SET snoozed_until = ${until}, snooze_note = ${until === null ? null : note.trim() || null}
    WHERE session_id = ${sessionId}
  `)
  emitChanged(sessionId)
}

/**
 * A prompt reached the session: work goes on, so the session is active and
 * awake. The time is what its pull requests must end after to settle it.
 */
export async function recordSessionPrompt(sessionId: string, at = Date.now()): Promise<void> {
  const before = await readRow(sessionId)
  await ensureRow(sessionId)
  await getDatabase().run(sql`
    UPDATE ${sessionStates} SET
      last_prompt_at = ${at}, settled_at = NULL, settled_by = NULL, snoozed_until = NULL, snooze_note = NULL
    WHERE session_id = ${sessionId}
  `)
  if (before && (before.settled_at !== null || before.snoozed_until !== null)) emitChanged(sessionId)
}

/**
 * Keeps the execution preferences a session's run carried (plans/018 §6), so a
 * follow-up nobody typed — after the run ends, or after a host restart — runs
 * with the preferences of the person the session works for. A run that carried
 * none clears them.
 */
export async function recordSessionExecutionPreferences(sessionId: string, preferences: ExecutionPreferences | undefined): Promise<void> {
  if (preferences) await ensureRow(sessionId)
  await getDatabase().run(sql`
    UPDATE ${sessionStates} SET execution_preferences = ${preferences ? JSON.stringify(preferences) : null}
    WHERE session_id = ${sessionId}
  `)
}

/** The execution preferences the session's last run carried; undefined when it carried none. */
export async function sessionExecutionPreferences(sessionId: string): Promise<ExecutionPreferences | undefined> {
  const row = z.object({ execution_preferences: z.string().nullable() }).nullish().parse(await getDatabase().get(sql`
    SELECT execution_preferences FROM ${sessionStates} WHERE session_id = ${sessionId}
  `))
  if (!row?.execution_preferences) return undefined
  // Written by this host after the same strict parse; a value that no longer
  // parses is no person's choice, so the run falls back to the defaults.
  const parsed = executionPreferencesSchema.safeParse(JSON.parse(row.execution_preferences))
  return parsed.success ? parsed.data : undefined
}

/** When a session was last read, or null when it never has been. */
async function readViewedAt(sessionId: string): Promise<number | null> {
  const row = z.object({ viewed_at: z.number().nullable() }).nullish().parse(await getDatabase().get(sql`
    SELECT viewed_at FROM ${sessionStates} WHERE session_id = ${sessionId}
  `))
  return row?.viewed_at ?? null
}

/**
 * Record that a session has been read, and answer with the boundary now in
 * force. The host owns this because a client cannot: read state kept in one
 * client leaves the same session unread on every other device.
 *
 * Two rules make this safe to call from several clients at once. The boundary
 * is capped at server time, so a client with a fast clock cannot mark future
 * completions read. And it never moves backward, so a view that was in flight
 * while another device marked the session unread cannot undo that choice.
 */
export async function markSessionViewed(sessionId: string, at: number): Promise<number> {
  const bounded = Math.min(at, Date.now())
  const current = await readViewedAt(sessionId)
  if (current !== null && current >= bounded) return current
  await ensureRow(sessionId)
  await getDatabase().run(sql`UPDATE ${sessionStates} SET viewed_at = ${bounded} WHERE session_id = ${sessionId}`)
  return bounded
}

/** Return a session to unread: the one path that moves the boundary backward,
 *  because the person says so. */
export async function markSessionUnread(sessionId: string): Promise<void> {
  await getDatabase().run(sql`UPDATE ${sessionStates} SET viewed_at = NULL WHERE session_id = ${sessionId}`)
}

/** The sessions that are settled now, of the ones named. */
export async function settledSessionIds(sessionIds: readonly string[]): Promise<Set<string>> {
  if (!sessionIds.length) return new Set()
  const rows = z.object({ session_id: z.string() }).array().parse(await getDatabase().all(sql`
    SELECT session_id FROM ${sessionStates}
    WHERE settled_at IS NOT NULL
      AND session_id IN (${sql.join(sessionIds.map((sessionId) => sql`${sessionId}`), sql`, `)})
  `))
  return new Set(rows.map((row) => row.session_id))
}

/**
 * The settled and snoozed sessions a client lists: the named ones, or every
 * session settled recently and every session with a snooze. A snooze that
 * ended stays until a person opens the session or writes to it, so a client
 * can show that the session woke. Each entry carries what its record says, so
 * a client can name and reopen a session it has no conversation of.
 */
export async function readSessionShelf(scope: RecordScope, sessionIds?: readonly string[], now = Date.now()): Promise<SessionShelfEntry[]> {
  if (sessionIds && !sessionIds.length) return []
  const which = sessionIds
    ? sql`session_id IN (${sql.join(sessionIds.map((sessionId) => sql`${sessionId}`), sql`, `)})
        AND (settled_at IS NOT NULL OR snoozed_until IS NOT NULL)`
    : sql`(settled_at >= ${now - SETTLED_SHELF_MS} OR snoozed_until IS NOT NULL)`
  const rows = rowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${COLUMNS} FROM ${sessionStates}
    WHERE ${scopeClause(scope)} AND ${which}
    ORDER BY settled_at DESC, session_id
    LIMIT ${SHELF_LIMIT}
  `))
  const records = await getSessionRecords(scope, rows.map((row) => row.session_id))
  return rows.map((row) => {
    const record = records.get(row.session_id)
    return {
      ...stateFromRow(row),
      title: record?.customTitle ?? record?.title ?? record?.slug ?? null,
      projectPath: record?.projectRoot ?? record?.projectPath ?? null,
    }
  })
}

const linkedSessionRowSchema = z.object({
  session_id: z.string(),
  open_links: z.coerce.number(),
  ended_at: z.string().nullable(),
  unsettled_at: z.number().nullable(),
  last_prompt_at: z.number().nullable(),
})

/**
 * Settle each active session whose pull requests have all ended: every link
 * is merged or closed (one the code host no longer has does not count), and the last one ended after the session's last prompt
 * and after a person last made it active. A session that is mid-turn waits.
 * Returns the sessions it settled.
 */
export async function settleSessionsWithEndedPullRequests(isSessionBusy: (sessionId: string) => boolean): Promise<string[]> {
  const rows = linkedSessionRowSchema.array().parse(await getDatabase().all(sql`
    SELECT session_pull_requests.session_id,
      SUM(CASE WHEN session_pull_requests.pr_state IN ('merged', 'closed', 'missing') THEN 0 ELSE 1 END) AS open_links,
      MAX(session_pull_requests.pr_updated_at) AS ended_at,
      MAX(session_states.unsettled_at) AS unsettled_at,
      MAX(session_states.last_prompt_at) AS last_prompt_at
    FROM ${sessionPullRequests}
    LEFT JOIN ${sessionStates} ON session_states.session_id = session_pull_requests.session_id
    WHERE session_pull_requests.source <> 'dismissed' AND session_states.settled_at IS NULL
    GROUP BY session_pull_requests.session_id
  `))
  const settled: string[] = []
  for (const row of rows) {
    if (row.open_links > 0 || !row.ended_at || isSessionBusy(row.session_id)) continue
    const endedAt = Date.parse(row.ended_at)
    const activeSince = Math.max(row.unsettled_at ?? 0, row.last_prompt_at ?? 0)
    if (!Number.isFinite(endedAt) || endedAt < activeSince) continue
    if (await settleSession(row.session_id, 'pull-request')) settled.push(row.session_id)
  }
  return settled
}

/** A session is idle work after this long with no prompt. */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60_000

/**
 * Settle each active session that had no prompt for a long time and waits on
 * no pull request. A session with an open pull request stays active until the
 * pull request ends.
 */
export async function settleIdleSessions(isSessionBusy: (sessionId: string) => boolean, now = Date.now()): Promise<string[]> {
  const idleBefore = now - SESSION_IDLE_MS
  const rows = z.object({ session_id: z.string() }).array().parse(await getDatabase().all(sql`
    SELECT session_id FROM ${sessionStates}
    WHERE settled_at IS NULL
      AND COALESCE(last_prompt_at, 0) < ${idleBefore} AND COALESCE(unsettled_at, 0) < ${idleBefore}
      AND (last_prompt_at IS NOT NULL OR unsettled_at IS NOT NULL)
      AND (snoozed_until IS NULL OR snoozed_until <= ${now})
      AND NOT EXISTS (
        SELECT 1 FROM ${sessionPullRequests}
        WHERE session_pull_requests.session_id = session_states.session_id
          AND session_pull_requests.source <> 'dismissed'
          AND (session_pull_requests.pr_state IS NULL OR session_pull_requests.pr_state NOT IN ('merged', 'closed', 'missing'))
      )
  `))
  const settled: string[] = []
  for (const { session_id: sessionId } of rows) {
    if (isSessionBusy(sessionId)) continue
    if (await settleSession(sessionId, 'idle', now)) settled.push(sessionId)
  }
  return settled
}

/**
 * A task was reopened: the sessions that its finish settled are active again.
 * A session a person or a pull request settled stays settled.
 */
export async function reopenSessionsSettledByTask(sessionIds: readonly string[], at = Date.now()): Promise<void> {
  for (const sessionId of sessionIds) {
    const changed = (await getDatabase().run(sql`
      UPDATE ${sessionStates} SET settled_at = NULL, settled_by = NULL, unsettled_at = ${at}
      WHERE session_id = ${sessionId} AND settled_by = 'task'
    `)).changes > 0
    if (changed) emitChanged(sessionId)
  }
}
