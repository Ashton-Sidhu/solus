import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase } from '../../db/database'
import { sessionPullRequestWatches } from './schema'
import { organizationOfSession } from './session-records'

/**
 * The pull requests sessions watch (docs/plans/pr-watch.md). The watcher keeps
 * them in memory and reads this table only at start and when a change names a
 * session, so every write here goes through a function that emits one.
 */

/** What a watch told the agent, so the next read reports only what is new
 *  (`prs/pr-watch-rules.ts`). */
export const pullRequestWatchStateSchema = z.object({
  headSha: z.string().nullable(),
  failedChecks: z.array(z.string()),
  passReported: z.boolean(),
  passedChecks: z.array(z.string()),
  remarksThrough: z.string(),
  remarkIdsAtWatermark: z.array(z.string()),
  conflicting: z.boolean(),
  remarkOnlyWakes: z.number(),
})
export type PullRequestWatchState = z.infer<typeof pullRequestWatchStateSchema>

export interface PullRequestWatch {
  sessionId: string
  /** `host/owner/repo`, lower case. */
  repository: string
  number: number
  /** New at each start: a write for an older watch does nothing. */
  watchId: string
  startedAt: number
  state: PullRequestWatchState
}

const rowSchema = z.object({
  session_id: z.string(),
  repository: z.string(),
  number: z.number(),
  watch_id: z.string(),
  started_at: z.coerce.number(),
  state: z.string(),
})

type ChangeListener = (sessionId: string) => void
const listeners = new Set<ChangeListener>()

/** Hear each session whose watches started or stopped. */
export function onPullRequestWatchesChanged(listener: ChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitChanged(sessionId: string): void {
  for (const listener of listeners) listener(sessionId)
}

/** Start watching, or start over: a watch that exists gets a new id and a
 *  new state, so a read in flight for the old one writes nothing. */
export async function startPullRequestWatch(
  sessionId: string,
  repository: string,
  number: number,
  state: PullRequestWatchState,
  startedAt = Date.now(),
): Promise<PullRequestWatch> {
  const watch: PullRequestWatch = {
    sessionId, repository: repository.toLowerCase(), number, watchId: randomUUID(), startedAt, state,
  }
  const organizationId = await organizationOfSession(sessionId)
  await getDatabase().run(sql`
    INSERT INTO ${sessionPullRequestWatches}(session_id, repository, number, watch_id, started_at, state, organization_id)
    VALUES (${sessionId}, ${watch.repository}, ${number}, ${watch.watchId}, ${startedAt}, ${JSON.stringify(state)}, ${organizationId})
    ON CONFLICT(session_id, repository, number) DO UPDATE SET
      watch_id = excluded.watch_id, started_at = excluded.started_at, state = excluded.state
  `)
  emitChanged(sessionId)
  return watch
}

/** Stop one watch. False when the session did not watch the pull request. */
export async function stopPullRequestWatch(sessionId: string, repository: string, number: number): Promise<boolean> {
  const stopped = (await getDatabase().run(sql`
    DELETE FROM ${sessionPullRequestWatches}
    WHERE session_id = ${sessionId} AND repository = ${repository.toLowerCase()} AND number = ${number}
  `)).changes > 0
  if (stopped) emitChanged(sessionId)
  return stopped
}

/** Stop every watch of a session: it settled or was stopped. */
export async function stopSessionPullRequestWatches(sessionId: string): Promise<boolean> {
  const stopped = (await getDatabase().run(sql`
    DELETE FROM ${sessionPullRequestWatches} WHERE session_id = ${sessionId}
  `)).changes > 0
  if (stopped) emitChanged(sessionId)
  return stopped
}

/** End the watch the watcher read, unless it was stopped or started over
 *  while the read ran. */
export async function endPullRequestWatch(watch: PullRequestWatch): Promise<boolean> {
  const ended = (await getDatabase().run(sql`
    DELETE FROM ${sessionPullRequestWatches} WHERE watch_id = ${watch.watchId}
  `)).changes > 0
  if (ended) emitChanged(watch.sessionId)
  return ended
}

/** Store what a read told the agent. Does nothing when the watch was stopped
 *  or started over while the read ran, and answers whether it wrote. The
 *  watcher already holds the new state, so this emits no change. */
export async function recordPullRequestWatchState(watch: PullRequestWatch, state: PullRequestWatchState): Promise<boolean> {
  return (await getDatabase().run(sql`
    UPDATE ${sessionPullRequestWatches} SET state = ${JSON.stringify(state)} WHERE watch_id = ${watch.watchId}
  `)).changes > 0
}

/** The watches of the named sessions, or of every session. */
export async function readPullRequestWatches(sessionIds?: readonly string[]): Promise<PullRequestWatch[]> {
  if (sessionIds && !sessionIds.length) return []
  const onlySessions = sessionIds
    ? sql` WHERE session_id IN (${sql.join(sessionIds.map((sessionId) => sql`${sessionId}`), sql`, `)})`
    : sql``
  const rows = rowSchema.array().parse(await getDatabase().all(sql`
    SELECT session_id, repository, number, watch_id, started_at, state FROM ${sessionPullRequestWatches}${onlySessions}
  `))
  return rows.map((row) => ({
    sessionId: row.session_id,
    repository: row.repository,
    number: row.number,
    watchId: row.watch_id,
    startedAt: row.started_at,
    state: pullRequestWatchStateSchema.parse(JSON.parse(row.state)),
  }))
}
