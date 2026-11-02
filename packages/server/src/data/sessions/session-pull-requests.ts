import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { parseGitHubPullRequestUrl, type PullRequest } from '@solus/contracts/providers'
import { pullRequestIdentityOf } from '@solus/contracts/session-pull-requests'
import type {
  SessionPullRequestLink,
  SessionPullRequestSource,
  SessionPullRequestsBySession,
} from '@solus/contracts/session-pull-requests'
import type { TaskPrSnapshot } from '@solus/contracts/task-types'
import type { Attribution } from '@solus/contracts/user'
import { attributionJson, parseStoredAttribution } from '../stored-attribution'
import { getDatabase } from '../../db/database'
import type { RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { resourceLinks } from '../links/schema'
import { creatorOf, pullRequestStateSchema, sessionOwner } from '../links/resource-links'
import {
  keepsSession,
  latestObservation,
  OBSERVATION_COLUMNS,
  OBSERVATION_JOIN,
  OBSERVATION_ROW_COLUMNS,
  recordObservation,
} from '../links/pull-request-observations'
import { ensureSessionRow } from './session-identity'
import { organizationOfSession } from './session-records'
import { emitPullRequestWatchesChanged } from './pull-request-watches'

/**
 * The pull requests a session works on (docs/plans/session-pull-requests.md):
 * the session→pr edges of `resource_links`, read with what PR sync last saw
 * of each (`pull_request_observations`).
 *
 * A session owns its links. A task has no copy: it reads the links of its
 * sessions (`readTaskPrLinks`), so a session that joins a task brings its pull
 * requests, and one that leaves takes them with it.
 */

const SOURCES = ['branch', 'created', 'agent', 'manual'] as const
/** A stored source, or `dismissed`: the tombstone of a link a person removed.
 *  PR sync finds the pull request on the session's branch again at every
 *  tick, and the row is what stops it from linking it again. */
type StoredSource = (typeof SOURCES)[number] | 'dismissed'

/** The session→pull-request edges. */
const SESSION_PR = sql`resource_links.source_kind = 'session' AND resource_links.target_kind = 'pr' AND resource_links.relation = 'pull-request'`

const rowSchema = z.object({
  session_id: z.string(),
  repository: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.string(),
  source: z.enum(SOURCES),
  author: z.string().nullable(),
  created_at: z.number(),
  watch_started_at: z.number().nullable(),
  ...OBSERVATION_ROW_COLUMNS,
})
type Row = z.infer<typeof rowSchema>

const ROW_COLUMNS = sql`resource_links.source_id AS session_id, resource_links.repository, resource_links.number, resource_links.url,
  resource_links.title, resource_links.source, resource_links.author, resource_links.created_at, resource_links.watch_started_at, ${OBSERVATION_COLUMNS}`

const sessionIdRowSchema = z.object({ session_id: z.string() })

type ChangeListener = (sessionId: string) => void
const listeners = new Set<ChangeListener>()

/** Hear each session whose links, or whose links' observations, changed. */
export function onSessionPullRequestsChanged(listener: ChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitSessionPullRequestsChanged(sessionId: string): void {
  for (const listener of listeners) listener(sessionId)
}

/**
 * Whether a new link replaces the stored source.
 *
 * - A branch discovery never writes over a row: an explicit link keeps its
 *   source, and a dismissed one stays dismissed.
 * - An explicit link (created, agent, manual) revives a dismissed row and
 *   claims a branch row, because it says more about the link than "found".
 * - An explicit link does not write over another explicit link.
 */
export function nextSessionPullRequestSource(
  stored: StoredSource | null,
  incoming: SessionPullRequestSource,
): SessionPullRequestSource | null {
  if (stored === null) return incoming
  if (incoming === 'branch') return null
  return stored === 'dismissed' || stored === 'branch' ? incoming : null
}

export interface SessionPullRequestInput {
  /** The pull request's page. Its repository and number are read from it. */
  url: string
  title?: string
  source: SessionPullRequestSource
  /** Who linked it. PR sync links as Solus itself. */
  by: Attribution
}

const storedRowSchema = z.object({ source: z.enum(SOURCES), status: z.string() })
const endedRowSchema = z.object({ repository: z.string(), number: z.number(), watch_id: z.string().nullable() })

/**
 * Link a pull request to a session. Idempotent: linking a linked pull request
 * changes nothing and returns false.
 *
 * A session holds one `branch` row, and it follows the branch: a new branch
 * discovery replaces the session's branch rows whose pull request has ended
 * (merged, closed, or gone), as a thread's detected pull request does in T3
 * Code. A branch row that is still open stays; so does every explicit row and
 * every tombstone. A replaced row's watch goes with it, in the same transaction.
 */
export async function linkSessionPullRequest(sessionId: string, input: SessionPullRequestInput): Promise<boolean> {
  const identity = pullRequestIdentityOf(input.url)
  if (!identity) throw new Error('A session pull request link needs the full URL of the pull request.')
  const organizationId = await organizationOfSession(sessionId)
  const title = input.title?.trim() ?? ''
  const now = Date.now()
  let watchCleared = false
  const named = sql`${SESSION_PR} AND resource_links.source_id = ${sessionId}
    AND resource_links.repository = ${identity.repository} AND resource_links.number = ${identity.number}`
  const changed = await getDatabase().transaction(async (db) => {
    const stored = storedRowSchema.nullish().parse(await db.get(sql`
      SELECT source, status FROM ${resourceLinks} WHERE ${named}
    `))
    const source = nextSessionPullRequestSource(stored ? (stored.status === 'dismissed' ? 'dismissed' : stored.source) : null, input.source)
    if (!source) return false
    // The link reads the observation the organization already holds, if any.
    const observation = await latestObservation(db, organizationId, identity.repository, identity.number)
    const bit = keepsSession(observation?.state ?? null)
    if (stored) {
      await db.run(sql`
        UPDATE ${resourceLinks} SET
          source = ${source}, status = 'active', author = ${attributionJson(input.by)}, url = ${identity.url},
          created_at = ${now}, title = CASE WHEN ${title} = '' THEN resource_links.title ELSE ${title} END,
          authority_key = ${observation?.authorityKey ?? null}, keeps_session = ${bit}
        WHERE ${named}
      `)
      return true
    }
    if (source === 'branch') {
      const ended = endedRowSchema.array().parse(await db.all(sql`
        SELECT resource_links.repository, resource_links.number, resource_links.watch_id FROM ${resourceLinks} ${OBSERVATION_JOIN}
        WHERE ${SESSION_PR} AND resource_links.source_id = ${sessionId} AND resource_links.source = 'branch' AND resource_links.status = 'active'
          AND o.state IN ('merged', 'closed', 'missing')
      `))
      for (const row of ended) {
        await db.run(sql`DELETE FROM ${resourceLinks} WHERE ${SESSION_PR} AND resource_links.source_id = ${sessionId}
          AND resource_links.repository = ${row.repository} AND resource_links.number = ${row.number}`)
        if (row.watch_id !== null) watchCleared = true
      }
    }
    // The edge is the session's; a session nobody recorded yet gets its row, as this machine's own.
    await ensureSessionRow(sessionId, db)
    const createdBy = await creatorOf(input.by, () => sessionOwner(db, sessionId))
    await db.run(sql`
      INSERT INTO ${resourceLinks}(
        organization_id, source_kind, source_id, target_kind, target_scope, target_key, relation, title, url, source, status,
        repository, number, authority_key, keeps_session, author, created_by, created_at
      ) VALUES (
        ${organizationId}, 'session', ${sessionId}, 'pr', ${identity.repository}, ${String(identity.number)}, 'pull-request', ${title}, ${identity.url}, ${source}, 'active',
        ${identity.repository}, ${identity.number}, ${observation?.authorityKey ?? null}, ${bit}, ${attributionJson(input.by)}, ${createdBy}, ${now}
      )
    `)
    return true
  })
  if (watchCleared) emitPullRequestWatchesChanged(sessionId)
  if (changed) emitSessionPullRequestsChanged(sessionId)
  return changed
}

/**
 * Remove a pull request from a session. The row stays as a tombstone, so PR
 * sync does not link the pull request of the session's branch again; a
 * dismissed link keeps no session listed and is not watched. Returns false
 * when the session did not show the pull request.
 */
export async function unlinkSessionPullRequest(sessionId: string, repository: string, number: number): Promise<boolean> {
  const named = sql`${SESSION_PR} AND resource_links.source_id = ${sessionId}
    AND resource_links.repository = ${repository.toLowerCase()} AND resource_links.number = ${number}`
  const removed = await getDatabase().transaction(async (db) => {
    const live = z.object({ watch_id: z.string().nullable() }).nullish().parse(await db.get(sql`
      SELECT watch_id FROM ${resourceLinks} WHERE ${named} AND resource_links.status <> 'dismissed'
    `))
    if (!live) return null
    await db.run(sql`
      UPDATE ${resourceLinks} SET status = 'dismissed', keeps_session = 0,
        watch_id = NULL, watch_started_at = NULL, watch_user_id = NULL, watch_state = NULL
      WHERE ${named}
    `)
    return { hadWatch: live.watch_id !== null }
  })
  if (!removed) return false
  if (removed.hadWatch) emitPullRequestWatchesChanged(sessionId)
  emitSessionPullRequestsChanged(sessionId)
  return true
}

/** The title a row shows: the observation's once PR sync answered, else the link's. */
function titleOf(row: Pick<Row, 'title' | 'pr_title'>): string {
  return row.pr_title || row.title
}

/** The part of a pull request a row draws, as PR sync last saw it: display
 *  state, never a permission. */
function snapshotOf(row: Row): TaskPrSnapshot | null {
  if (!row.pr_state || row.pr_state === 'missing' || row.pr_updated_at === null) return null
  const parsed = parseGitHubPullRequestUrl(row.url)
  if (!parsed) return null
  return {
    number: row.number, url: parsed.url, title: titleOf(row),
    state: row.pr_state, draft: row.pr_draft === 1, updatedAt: row.pr_updated_at,
    baseRepo: parsed.baseRepo,
  }
}

function linkFromRow(row: Row): SessionPullRequestLink {
  const link: SessionPullRequestLink = {
    sessionId: row.session_id,
    repository: row.repository,
    number: row.number,
    url: row.url,
    title: titleOf(row),
    source: row.source,
    linkedAt: row.created_at,
  }
  const createdBy = parseStoredAttribution(row.author)
  if (createdBy) link.createdBy = createdBy
  const snapshot = snapshotOf(row)
  if (snapshot) link.snapshot = snapshot
  if (row.pr_state === 'missing') link.missing = true
  if (row.watch_started_at !== null) link.watch = { startedAt: row.watch_started_at }
  return link
}

/** The links of the named sessions, or of every session in scope, newest
 *  first. Dismissed links are not links. Ids are stable session ids. */
export async function readSessionPullRequests(
  scope: RecordScope,
  sessionIds?: readonly string[],
): Promise<SessionPullRequestsBySession> {
  if (sessionIds && !sessionIds.length) return {}
  const onlySessions = sessionIds
    ? sql` AND resource_links.source_id IN (${sql.join(sessionIds.map((sessionId) => sql`${sessionId}`), sql`, `)})`
    : sql``
  const rows = rowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${ROW_COLUMNS} FROM ${resourceLinks} ${OBSERVATION_JOIN}
    WHERE ${scopeClause(scope, sql`resource_links.organization_id`)} AND ${SESSION_PR} AND resource_links.status = 'active'${onlySessions}
    ORDER BY resource_links.created_at DESC, resource_links.repository, resource_links.number DESC
  `))
  const bySession: SessionPullRequestsBySession = {}
  for (const row of rows) {
    const link = linkFromRow(row)
    const links = bySession[row.session_id]
    if (links) links.push(link)
    else bySession[row.session_id] = [link]
  }
  return bySession
}

/** Whether the session has a row for this pull request, a dismissed one
 *  included: what PR sync asks before it links a branch's pull request. */
export async function sessionKnowsPullRequest(sessionId: string, repository: string, number: number): Promise<boolean> {
  const row = await getDatabase().get(sql`
    SELECT 1 AS present FROM ${resourceLinks}
    WHERE ${SESSION_PR} AND resource_links.source_id = ${sessionId}
      AND resource_links.repository = ${repository.toLowerCase()} AND resource_links.number = ${number}
  `)
  return !!row
}

/**
 * Write what PR sync saw for one pull request to its observation, bind every
 * edge that names it, and return the sessions whose links changed. Null means
 * the code host says that the pull request does not exist. The pull request
 * watcher reads with the person the watch acts for; that scope is the
 * observation's authority.
 */
export async function recordSessionPullRequestObservation(
  repository: string,
  number: number,
  pullRequest: PullRequest | null,
): Promise<string[]> {
  const { sessionIds } = await recordObservation(getDatabase(), { repository, number, scopes: [], pullRequest })
  for (const sessionId of sessionIds) emitSessionPullRequestsChanged(sessionId)
  return sessionIds
}

/** One session link, as PR sync's interest reads it. */
export interface SessionPullRequestInterest {
  sessionId: string
  repository: string
  number: number
  state: 'open' | 'closed' | 'merged' | 'missing' | null
  updatedAt: string | null
}

const interestRowSchema = z.object({
  session_id: z.string(),
  repository: z.string(),
  number: z.number(),
  pr_state: pullRequestStateSchema.nullable(),
  pr_updated_at: z.string().nullable(),
})

/** Every live session link with what PR sync last saw. */
export async function readSessionPullRequestInterests(scope: RecordScope): Promise<SessionPullRequestInterest[]> {
  const rows = interestRowSchema.array().parse(await getDatabase().all(sql`
    SELECT resource_links.source_id AS session_id, resource_links.repository, resource_links.number, o.state AS pr_state, o.updated_at AS pr_updated_at
    FROM ${resourceLinks} ${OBSERVATION_JOIN}
    WHERE ${scopeClause(scope, sql`resource_links.organization_id`)} AND ${SESSION_PR} AND resource_links.status = 'active'
  `))
  return rows.map((row) => ({
    sessionId: row.session_id,
    repository: row.repository,
    number: row.number,
    state: row.pr_state,
    updatedAt: row.pr_updated_at,
  }))
}

/**
 * The sessions a pull request is part of: those that link it. A dismissed link
 * is a person's removal, so that session no longer holds it.
 */
export async function sessionsOfPullRequest(repository: string, number: number): Promise<string[]> {
  return sessionIdRowSchema.array().parse(await getDatabase().all(sql`
    SELECT DISTINCT resource_links.source_id AS session_id FROM ${resourceLinks}
    WHERE ${SESSION_PR} AND resource_links.repository = ${repository.toLowerCase()} AND resource_links.number = ${number}
      AND resource_links.status = 'active'
  `)).map((row) => row.session_id)
}
