import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { EMPTY_SESSION_VIEW, UNSETTLED_SESSION_STATE, type SessionSettledBy, type SessionState, type SessionView } from '@solus/contracts/session-state'
import { storedExecutionPreferencesSchema, type ExecutionPreferences } from '@solus/contracts/settings'
import { getDatabase } from '../../db/database'
import { sessionPullRequests, sessionStates, sessionViews } from './schema'
import { organizationOfSession } from './session-records'
import { stopSessionPullRequestWatches } from './pull-request-watches'
import { stateFromColumns, viewFromColumns } from './session-state-columns'

/**
 * Where a session is in a person's list (docs/plans/session-pull-requests.md,
 * docs/plans/session-archive.md). Its home holds it: the organization's Solus
 * API for an organization session, the machine for a personal one.
 *
 * Two things are kept apart. Whether the session's work is finished is shared:
 * every person sees one settle (`SessionShelf`). A person's archive and snooze
 * are that person's own (`SessionViewer`): they change their list, and nobody
 * else's. A session with no row is unsettled, and a person with no row did
 * nothing to it.
 */

const rowSchema = z.object({
  session_id: z.string(),
  settled_at: z.number().nullable(),
  settled_by: z.enum(['person', 'pull-request', 'task', 'idle']).nullable(),
  unsettled_at: z.number().nullable(),
  last_prompt_at: z.number().nullable(),
})
type Row = z.infer<typeof rowSchema>

const viewRowSchema = z.object({
  archived_at: z.number().nullable(),
  snoozed_until: z.number().nullable(),
  snooze_note: z.string().nullable(),
})

type ChangeListener = (sessionId: string, state: SessionState) => void
const listeners = new Set<ChangeListener>()

/** Hear each session whose shared state changed, with its state now. */
export function onSessionStateChanged(listener: ChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** One person's view of one session, as it is after a change. */
export interface SessionViewChange {
  sessionId: string
  personKey: string
  organizationId: string
  view: SessionView
}

type ViewListener = (change: SessionViewChange) => void
const viewListeners = new Set<ViewListener>()

/** Hear each change to one person's view of a session. Only that person's
 *  connections may hear it. */
export function onSessionViewChanged(listener: ViewListener): () => void {
  viewListeners.add(listener)
  return () => viewListeners.delete(listener)
}

type ReadStateListener = (sessionId: string, viewedAt: number | null) => void
const readStateListeners = new Set<ReadStateListener>()

/** Hear each session whose read boundary moved: a read, or a return to unread. */
export function onSessionReadStateChanged(listener: ReadStateListener): () => void {
  readStateListeners.add(listener)
  return () => readStateListeners.delete(listener)
}

function emitReadStateChanged(sessionId: string, viewedAt: number | null): void {
  for (const listener of readStateListeners) listener(sessionId, viewedAt)
}

/** Make sure the session has a row, so each write is one UPDATE. */
async function ensureRow(sessionId: string): Promise<void> {
  await getDatabase().run(sql`
    INSERT INTO ${sessionStates}(session_id, organization_id)
    VALUES (${sessionId}, ${await organizationOfSession(sessionId)})
    ON CONFLICT(session_id) DO NOTHING
  `)
}

const COLUMNS = sql`session_id, settled_at, settled_by, unsettled_at, last_prompt_at`

/**
 * What every person sees of one session: settle and its reverse, the task
 * that reopens it, and the prompt that makes it active again. Each change is
 * announced with the state it leaves.
 */
export class SessionShelf {
  constructor(readonly sessionId: string) {}

  /** The session's state now; unsettled when it has no row. */
  async state(): Promise<SessionState> {
    const row = await this.row()
    return (row && stateFromColumns(row)) ?? UNSETTLED_SESSION_STATE
  }

  /** Settle the session: its work is finished. Returns the state it leaves, or null when it was settled already. */
  async settle(by: SessionSettledBy, at = Date.now()): Promise<SessionState | null> {
    // One statement makes the row when it is missing, settles it only when it is not, and returns it.
    const row = rowSchema.nullish().parse(await getDatabase().get(sql`
      INSERT INTO ${sessionStates}(session_id, organization_id, settled_at, settled_by)
      VALUES (${this.sessionId}, ${await organizationOfSession(this.sessionId)}, ${at}, ${by})
      ON CONFLICT(session_id) DO UPDATE SET settled_at = excluded.settled_at, settled_by = excluded.settled_by
      WHERE ${sessionStates}.settled_at IS NULL
      RETURNING ${COLUMNS}
    `))
    const state = row && stateFromColumns(row)
    if (!state) return null
    // A settled session's work is finished: nothing is left to wake it for.
    await stopSessionPullRequestWatches(this.sessionId)
    for (const listener of listeners) listener(this.sessionId, state)
    return state
  }

  /**
   * Make a settled session active again, as a person asks. Its pull requests
   * settle it again only if one of them ends after this.
   */
  async unsettle(at = Date.now()): Promise<boolean> {
    const changed = await this.update(sql`settled_at = NULL, settled_by = NULL, unsettled_at = ${at}`, sql`settled_at IS NOT NULL`)
    if (changed) await this.announce()
    return changed
  }

  /** A task was reopened: make the session active again if the task's finish
   *  settled it. A settle by a person or a pull request stays. */
  async reopenFromTask(at = Date.now()): Promise<boolean> {
    const changed = await this.update(sql`settled_at = NULL, settled_by = NULL, unsettled_at = ${at}`, sql`settled_by = 'task'`)
    if (changed) await this.announce()
    return changed
  }

  /**
   * A prompt reached the session: work goes on, so the session is active, and
   * back in the list of the person the turn is for (`personKey`; none for a
   * turn nobody asked for). The time is what its pull requests must end after
   * to settle it.
   */
  async recordPrompt(personKey: string | null, at = Date.now()): Promise<void> {
    const before = await this.row()
    await ensureRow(this.sessionId)
    await this.update(sql`last_prompt_at = ${at}, settled_at = NULL, settled_by = NULL`)
    if (before?.settled_at != null) await this.announce()
    if (personKey) await new SessionViewer(this.sessionId, personKey).returnToList()
  }

  private async row(): Promise<Row | null> {
    return rowSchema.nullish().parse(await getDatabase().get(sql`
      SELECT ${COLUMNS} FROM ${sessionStates} WHERE session_id = ${this.sessionId}
    `)) ?? null
  }

  private async update(set: SQL, when?: SQL): Promise<boolean> {
    return (await getDatabase().run(sql`
      UPDATE ${sessionStates} SET ${set}
      WHERE session_id = ${this.sessionId}${when ? sql` AND ${when}` : sql``}
    `)).changes > 0
  }

  private async announce(): Promise<void> {
    const state = await this.state()
    for (const listener of listeners) listener(this.sessionId, state)
  }
}

/**
 * One person's own view of one session: their archive and snooze. It changes
 * that person's list, and nobody else's. Each change is announced to that
 * person with the view it leaves.
 */
export class SessionViewer {
  constructor(readonly sessionId: string, readonly personKey: string) {}

  /** This person's view now; empty when they did nothing to the session. */
  async view(): Promise<SessionView> {
    const row = viewRowSchema.nullish().parse(await getDatabase().get(sql`
      SELECT archived_at, snoozed_until, snooze_note FROM ${sessionViews}
      WHERE session_id = ${this.sessionId} AND person_key = ${this.personKey}
    `))
    return row ? viewFromColumns(row) ?? EMPTY_SESSION_VIEW : EMPTY_SESSION_VIEW
  }

  /** Take the session out of this person's list. Returns false when it was out already. */
  async archive(at = Date.now()): Promise<boolean> {
    return this.write(sql`archived_at = ${at}`, sql`archived_at IS NULL`, { archived_at: at })
  }

  /** Return the session to this person's list, on the shelf it left. Returns false when it was in the list. */
  async unarchive(): Promise<boolean> {
    return this.write(sql`archived_at = NULL`, sql`archived_at IS NOT NULL`)
  }

  /** Snooze the session until a wake time, or wake it now with `until` null. */
  async snooze(until: number | null, note = ''): Promise<void> {
    const snoozeNote = until === null ? null : note.trim() || null
    await this.write(sql`snoozed_until = ${until}, snooze_note = ${snoozeNote}`, undefined, { snoozed_until: until, snooze_note: snoozeNote })
  }

  /** A prompt for this person: the session is awake and in their list again.
   *  Their first prompt leaves an empty view, which puts a session they do
   *  not own in their list. */
  async returnToList(): Promise<void> {
    await this.write(sql`archived_at = NULL, snoozed_until = NULL, snooze_note = NULL`, sql`(archived_at IS NOT NULL OR snoozed_until IS NOT NULL)`, {})
  }

  /** One write: an insert for a person with no row yet, else an update when
   *  `when` holds. Announces the view when it changed. */
  private async write(set: SQL, when: SQL | undefined, insert?: { archived_at?: number | null; snoozed_until?: number | null; snooze_note?: string | null }): Promise<boolean> {
    const organizationId = await organizationOfSession(this.sessionId)
    const database = getDatabase()
    let changed = false
    if (insert) {
      changed = (await database.run(sql`
        INSERT INTO ${sessionViews}(session_id, person_key, organization_id, archived_at, snoozed_until, snooze_note)
        VALUES (${this.sessionId}, ${this.personKey}, ${organizationId}, ${insert.archived_at ?? null}, ${insert.snoozed_until ?? null}, ${insert.snooze_note ?? null})
        ON CONFLICT(session_id, person_key) DO NOTHING
      `)).changes > 0
    }
    if (!changed) {
      changed = (await database.run(sql`
        UPDATE ${sessionViews} SET ${set}
        WHERE session_id = ${this.sessionId} AND person_key = ${this.personKey}${when ? sql` AND ${when}` : sql``}
      `)).changes > 0
    }
    if (changed) {
      const change: SessionViewChange = { sessionId: this.sessionId, personKey: this.personKey, organizationId, view: await this.view() }
      for (const listener of viewListeners) listener(change)
    }
    return changed
  }
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
  // Written by this host after the strict parse; a removed key is dropped, and a
  // value that no longer parses is no person's choice, so the run falls back to the defaults.
  const parsed = storedExecutionPreferencesSchema.safeParse(JSON.parse(row.execution_preferences))
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
  emitReadStateChanged(sessionId, bounded)
  return bounded
}

/** Return a session to unread: the one path that moves the boundary backward,
 *  because the person says so. */
export async function markSessionUnread(sessionId: string): Promise<void> {
  await getDatabase().run(sql`UPDATE ${sessionStates} SET viewed_at = NULL WHERE session_id = ${sessionId}`)
  emitReadStateChanged(sessionId, null)
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
    if (await new SessionShelf(row.session_id).settle('pull-request')) settled.push(row.session_id)
  }
  return settled
}
