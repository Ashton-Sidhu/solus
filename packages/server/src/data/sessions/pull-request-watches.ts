import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase } from '../../db/database'
import { resourceLinks } from '../links/schema'

/**
 * The pull requests sessions watch (docs/plans/pr-watch.md): the watch fields
 * of a session's pull request edge in `resource_links` (plans/029 §3.5). The
 * four fields are set together and cleared together; a dismissed edge holds
 * none. The watcher keeps the watches in memory and reads them only at start
 * and when a change names a session, so every write here goes through a
 * function that emits one.
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
  /** Optional checks still running when the required ones passed: owed one
   *  wake when every check has passed. With a failed gate, the checks still
   *  running: owed one wake when the last finishes. */
  owedChecks: z.array(z.string()),
  /** When the head was first read with no check at all, until a check shows
   *  up or the agent is told none did; null after either. */
  checksAwaitedSince: z.string().nullable(),
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
  /** Whose account the watcher reads with; null for the host. */
  actingUserKey: string | null
}

const rowSchema = z.object({
  session_id: z.string(),
  repository: z.string(),
  number: z.number(),
  watch_id: z.string(),
  watch_started_at: z.coerce.number(),
  watch_state: z.string(),
  watch_user_id: z.string().nullable(),
})

/** An active session→pull-request edge: the only row a watch can be on. */
const WATCHABLE = sql`resource_links.source_kind = 'session' AND resource_links.target_kind = 'pr'
  AND resource_links.relation = 'pull-request' AND resource_links.status = 'active'`

const CLEARED = sql`watch_id = NULL, watch_started_at = NULL, watch_user_id = NULL, watch_state = NULL`

type ChangeListener = (sessionId: string) => void
const listeners = new Set<ChangeListener>()

/** Hear each session whose watches started or stopped. */
export function onPullRequestWatchesChanged(listener: ChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitPullRequestWatchesChanged(sessionId: string): void {
  for (const listener of listeners) listener(sessionId)
}

/** Start watching, or start over: a watch that exists gets a new id and a
 *  new state, so a read in flight for the old one writes nothing. The link
 *  must be live: a session watches only a pull request it links.
 *  `actingUserKey` is the person whose account reads the pull request. */
export async function startPullRequestWatch(
  sessionId: string,
  repository: string,
  number: number,
  state: PullRequestWatchState,
  actingUserKey: string | null,
  startedAt = Date.now(),
): Promise<PullRequestWatch> {
  const watch: PullRequestWatch = {
    sessionId, repository: repository.toLowerCase(), number, watchId: randomUUID(), startedAt, state, actingUserKey,
  }
  const started = (await getDatabase().run(sql`
    UPDATE ${resourceLinks} SET watch_id = ${watch.watchId}, watch_started_at = ${startedAt},
      watch_user_id = ${actingUserKey}, watch_state = ${JSON.stringify(state)}
    WHERE ${WATCHABLE} AND resource_links.source_id = ${sessionId}
      AND resource_links.repository = ${watch.repository} AND resource_links.number = ${number}
  `)).changes > 0
  if (!started) throw new Error('A session watches only a pull request it links.')
  emitPullRequestWatchesChanged(sessionId)
  return watch
}

/** Stop one watch. False when the session did not watch the pull request. */
export async function stopPullRequestWatch(sessionId: string, repository: string, number: number): Promise<boolean> {
  const stopped = (await getDatabase().run(sql`
    UPDATE ${resourceLinks} SET ${CLEARED}
    WHERE resource_links.source_kind = 'session' AND resource_links.source_id = ${sessionId} AND resource_links.target_kind = 'pr'
      AND resource_links.repository = ${repository.toLowerCase()} AND resource_links.number = ${number} AND resource_links.watch_id IS NOT NULL
  `)).changes > 0
  if (stopped) emitPullRequestWatchesChanged(sessionId)
  return stopped
}

/** Stop every watch of a session: it settled or was stopped. */
export async function stopSessionPullRequestWatches(sessionId: string): Promise<boolean> {
  const stopped = (await getDatabase().run(sql`
    UPDATE ${resourceLinks} SET ${CLEARED}
    WHERE resource_links.source_kind = 'session' AND resource_links.source_id = ${sessionId} AND resource_links.watch_id IS NOT NULL
  `)).changes > 0
  if (stopped) emitPullRequestWatchesChanged(sessionId)
  return stopped
}

/** End the watch the watcher read, unless it was stopped or started over
 *  while the read ran: the generation guard is the watch id. */
export async function endPullRequestWatch(watch: PullRequestWatch): Promise<boolean> {
  const ended = (await getDatabase().run(sql`
    UPDATE ${resourceLinks} SET ${CLEARED} WHERE resource_links.watch_id = ${watch.watchId}
  `)).changes > 0
  if (ended) emitPullRequestWatchesChanged(watch.sessionId)
  return ended
}

/** Store what a read told the agent. Does nothing when the watch was stopped
 *  or started over while the read ran, and answers whether it wrote. The
 *  watcher already holds the new state, so this emits no change. */
export async function recordPullRequestWatchState(watch: PullRequestWatch, state: PullRequestWatchState): Promise<boolean> {
  return (await getDatabase().run(sql`
    UPDATE ${resourceLinks} SET watch_state = ${JSON.stringify(state)} WHERE resource_links.watch_id = ${watch.watchId}
  `)).changes > 0
}

/** The watches of the named sessions, or of every session. */
export async function readPullRequestWatches(sessionIds?: readonly string[]): Promise<PullRequestWatch[]> {
  if (sessionIds && !sessionIds.length) return []
  const onlySessions = sessionIds
    ? sql` AND resource_links.source_id IN (${sql.join(sessionIds.map((sessionId) => sql`${sessionId}`), sql`, `)})`
    : sql``
  const rows = rowSchema.array().parse(await getDatabase().all(sql`
    SELECT resource_links.source_id AS session_id, resource_links.repository, resource_links.number, resource_links.watch_id,
      resource_links.watch_started_at, resource_links.watch_state, resource_links.watch_user_id
    FROM ${resourceLinks} WHERE resource_links.watch_id IS NOT NULL${onlySessions}
  `))
  return rows.map((row) => ({
    sessionId: row.session_id,
    repository: row.repository,
    number: row.number,
    watchId: row.watch_id,
    startedAt: row.watch_started_at,
    state: pullRequestWatchStateSchema.parse(JSON.parse(row.watch_state)),
    actingUserKey: row.watch_user_id,
  }))
}
