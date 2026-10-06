import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { parseGitHubPullRequestUrl, type PullRequest } from '@solus/contracts/providers'
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
import { sessionPullRequests } from './schema'
import { organizationOfSession } from './session-records'

/**
 * The pull requests a session works on (docs/plans/session-pull-requests.md).
 *
 * A session owns its links. A task has no copy: it reads the links of its
 * sessions (`readTaskPrLinks`), so a session that joins a task brings its pull
 * requests, and one that leaves takes them with it.
 */

const SOURCES = ['branch', 'created', 'agent', 'manual', 'dismissed'] as const
/** A stored source. `dismissed` is the tombstone of a link a person removed:
 *  PR sync finds the pull request on the session's branch again at every
 *  tick, and the row is what stops it from linking it again. */
type StoredSource = (typeof SOURCES)[number]

const rowSchema = z.object({
  session_id: z.string(),
  repository: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.string(),
  source: z.enum(SOURCES),
  created_by: z.string(),
  linked_at: z.number(),
  pr_state: z.enum(['open', 'closed', 'merged', 'missing']).nullable(),
  pr_draft: z.number().nullable(),
  pr_updated_at: z.string().nullable(),
})
type Row = z.infer<typeof rowSchema>

const sessionIdRowSchema = z.object({ session_id: z.string() })

type ChangeListener = (sessionId: string) => void
const listeners = new Set<ChangeListener>()

/** Hear each session whose links, or whose links' observations, changed. */
export function onSessionPullRequestsChanged(listener: ChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitChanged(sessionId: string): void {
  for (const listener of listeners) listener(sessionId)
}

/** The pull request a URL names, as a link stores it. Null for a URL that is
 *  not a pull request. */
export function pullRequestIdentityOf(url: string): { repository: string; number: number; url: string } | null {
  const parsed = parseGitHubPullRequestUrl(url)
  if (!parsed) return null
  const { host, owner, repo } = parsed.baseRepo
  return { repository: `${host}/${owner}/${repo}`.toLowerCase(), number: parsed.number, url: parsed.url }
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

/**
 * Link a pull request to a session. Idempotent: linking a linked pull request
 * changes nothing and returns false.
 */
export async function linkSessionPullRequest(sessionId: string, input: SessionPullRequestInput): Promise<boolean> {
  const identity = pullRequestIdentityOf(input.url)
  if (!identity) throw new Error('A session pull request link needs the full URL of the pull request.')
  const organizationId = await organizationOfSession(sessionId)
  const title = input.title?.trim() ?? ''
  const changed = await getDatabase().transaction(async (db) => {
    const stored = z.object({ source: z.enum(SOURCES) }).nullish().parse(await db.get(sql`
      SELECT source FROM ${sessionPullRequests}
      WHERE session_id = ${sessionId} AND repository = ${identity.repository} AND number = ${identity.number}
    `))
    const source = nextSessionPullRequestSource(stored?.source ?? null, input.source)
    if (!source) return false
    if (stored) {
      await db.run(sql`
        UPDATE ${sessionPullRequests} SET
          source = ${source}, created_by = ${attributionJson(input.by)}, url = ${identity.url},
          linked_at = ${Date.now()},
          title = CASE WHEN ${title} = '' THEN title ELSE ${title} END
        WHERE session_id = ${sessionId} AND repository = ${identity.repository} AND number = ${identity.number}
      `)
      return true
    }
    await db.run(sql`
      INSERT INTO ${sessionPullRequests}(
        session_id, repository, number, url, title, source, created_by, linked_at, organization_id
      ) VALUES (
        ${sessionId}, ${identity.repository}, ${identity.number}, ${identity.url}, ${title}, ${source},
        ${attributionJson(input.by)}, ${Date.now()}, ${organizationId}
      )
    `)
    return true
  })
  if (changed) emitChanged(sessionId)
  return changed
}

/**
 * Remove a pull request from a session. The row stays as a tombstone, so PR
 * sync does not link the pull request of the session's branch again. Returns
 * false when the session did not show the pull request.
 */
export async function unlinkSessionPullRequest(sessionId: string, repository: string, number: number): Promise<boolean> {
  const removed = (await getDatabase().run(sql`
    UPDATE ${sessionPullRequests} SET source = 'dismissed'
    WHERE session_id = ${sessionId} AND repository = ${repository.toLowerCase()} AND number = ${number}
      AND source <> 'dismissed'
  `)).changes > 0
  if (removed) emitChanged(sessionId)
  return removed
}

/** The part of a pull request a row draws, as PR sync last saw it: display
 *  state, never a permission. */
function snapshotOf(row: Row): TaskPrSnapshot | null {
  if (!row.pr_state || row.pr_state === 'missing' || row.pr_updated_at === null) return null
  const parsed = parseGitHubPullRequestUrl(row.url)
  if (!parsed) return null
  return {
    number: row.number, url: parsed.url, title: row.title,
    state: row.pr_state, draft: row.pr_draft === 1, updatedAt: row.pr_updated_at,
    baseRepo: parsed.baseRepo,
  }
}

function linkFromRow(row: Row & { source: SessionPullRequestSource }): SessionPullRequestLink {
  const link: SessionPullRequestLink = {
    sessionId: row.session_id,
    repository: row.repository,
    number: row.number,
    url: row.url,
    title: row.title,
    source: row.source,
    linkedAt: row.linked_at,
  }
  const createdBy = parseStoredAttribution(row.created_by)
  if (createdBy) link.createdBy = createdBy
  const snapshot = snapshotOf(row)
  if (snapshot) link.snapshot = snapshot
  if (row.pr_state === 'missing') link.missing = true
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
    ? sql` AND session_id IN (${sql.join(sessionIds.map((sessionId) => sql`${sessionId}`), sql`, `)})`
    : sql``
  const rows = rowSchema.array().parse(await getDatabase().all(sql`
    SELECT session_id, repository, number, url, title, source, created_by, linked_at, pr_state, pr_draft, pr_updated_at
    FROM ${sessionPullRequests}
    WHERE ${scopeClause(scope)} AND source <> 'dismissed'${onlySessions}
    ORDER BY linked_at DESC, repository, number DESC
  `))
  const bySession: SessionPullRequestsBySession = {}
  for (const row of rows) {
    if (row.source === 'dismissed') continue
    const link = linkFromRow({ ...row, source: row.source })
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
    SELECT 1 AS present FROM ${sessionPullRequests}
    WHERE session_id = ${sessionId}
      AND repository = ${repository.toLowerCase()} AND number = ${number}
  `)
  return !!row
}

/**
 * Write what PR sync saw for one pull request to every session link that names
 * it, and return the sessions whose links changed. Null means the code host
 * says that the pull request does not exist.
 */
export async function recordSessionPullRequestObservation(
  repository: string,
  number: number,
  pullRequest: PullRequest | null,
): Promise<string[]> {
  const matches = sql`repository = ${repository.toLowerCase()} AND number = ${number}`
  const db = getDatabase()
  const sessionIds = sessionIdRowSchema.array().parse(await db.all(sql`
    SELECT DISTINCT session_id FROM ${sessionPullRequests} WHERE ${matches}
  `)).map((row) => row.session_id)
  if (!sessionIds.length) return []
  await db.run(pullRequest
    ? sql`
      UPDATE ${sessionPullRequests} SET
        title = ${pullRequest.title}, pr_state = ${pullRequest.state},
        pr_draft = ${pullRequest.draft ? 1 : 0}, pr_updated_at = ${pullRequest.updatedAt}
      WHERE ${matches}`
    : sql`
      UPDATE ${sessionPullRequests} SET pr_state = 'missing', pr_draft = NULL, pr_updated_at = NULL
      WHERE ${matches}`)
  for (const sessionId of sessionIds) emitChanged(sessionId)
  return sessionIds
}

/** One watched pull request of a session, for PR sync's interest. */
export interface SessionPullRequestWatch {
  sessionId: string
  repository: string
  number: number
  state: 'open' | 'closed' | 'merged' | 'missing' | null
  updatedAt: string | null
}

/** Every live session link with what PR sync last saw. */
export async function readSessionPullRequestWatchList(scope: RecordScope): Promise<SessionPullRequestWatch[]> {
  const rows = rowSchema.array().parse(await getDatabase().all(sql`
    SELECT session_id, repository, number, url, title, source, created_by, linked_at, pr_state, pr_draft, pr_updated_at
    FROM ${sessionPullRequests}
    WHERE ${scopeClause(scope)} AND source <> 'dismissed'
  `))
  return rows.map((row) => ({
    sessionId: row.session_id,
    repository: row.repository,
    number: row.number,
    state: row.pr_state,
    updatedAt: row.pr_updated_at,
  }))
}

/** Whether PR sync last saw this pull request merged, on any session link. */
export async function sessionPullRequestIsMerged(repository: string, number: number): Promise<boolean> {
  const row = z.object({ pr_state: z.string().nullable() }).nullish().parse(await getDatabase().get(sql`
    SELECT pr_state FROM ${sessionPullRequests}
    WHERE repository = ${repository.toLowerCase()} AND number = ${number} AND pr_state IS NOT NULL
    LIMIT 1
  `))
  return row?.pr_state === 'merged'
}
