import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { isImagePath, type SessionArtifact, type SessionArtifacts } from '@solus/contracts/session-artifacts'
import { sessionLinkInputSchema } from '@solus/contracts/session-links'
import { getDatabase } from '../../db/database'
import { ANY_ORGANIZATION, type RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { works } from '../works/schema'
import { workTypeSchema } from '../works/work-rows'
import { sessionLinks } from './schema'
import { readSessionPullRequests } from './session-pull-requests'
import { getSessionRecord, readSessionMetadataPage } from './session-records'
import type { SessionRecord } from '@solus/contracts/types'

/**
 * What a session produced or linked (docs/plans/session-artifacts.md): its
 * pull requests, the works linked to it, and its file and automation links,
 * read together. Nothing is stored here; each item comes from the record that
 * holds it. A lead also reads the artifacts of every session below it in its
 * delegation tree: the sessions it started, the ones they started, and so on.
 */

/** A lead starts few sessions; this only bounds a runaway read. */
const MAX_DELEGATED_SESSIONS = 200

type ChangeListener = (sessionId: string) => void
const listeners = new Set<ChangeListener>()

/** Hear each session whose artifacts changed. A delegate's change is also each ancestor's. */
export function onSessionArtifactsChanged(listener: ChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Announce a change to a session's artifacts, and to each ancestor's list, which groups them. */
export async function emitSessionArtifactsChanged(sessionId: string): Promise<void> {
  const announced = new Set<string>()
  let next: string | null | undefined = sessionId
  // A cycle in the records ends the walk.
  while (next && !announced.has(next)) {
    const current: string = next
    announced.add(current)
    for (const listener of listeners) listener(current)
    next = (await getSessionRecord(ANY_ORGANIZATION, current).catch(() => null))?.parentSessionId
  }
}

const workRowSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  type: workTypeSchema.nullable(),
  session_id: z.string().nullable(),
  meta: z.string().nullable(),
  created_at: z.number(),
})
const workSessionsSchema = z.object({ sessionIds: z.array(z.string()).optional() })

const linkRowSchema = z.object({
  session_id: z.string(),
  target: z.string(),
  title: z.string(),
  linked_at: z.number(),
})

function inList(ids: readonly string[]): SQL {
  return sql.join(ids.map((id) => sql`${id}`), sql`, `)
}

/** The works each session is a member of. `sessionIds` names the members; a
 *  work written before it existed has only its origin `session_id`. */
async function readWorkArtifacts(scope: RecordScope, sessionIds: readonly string[], into: Map<string, SessionArtifact[]>): Promise<void> {
  const db = getDatabase()
  const inMeta = db.engine === 'postgres'
    ? sql.join(sessionIds.map((id) => sql`(meta::jsonb->'sessionIds') ? ${id}`), sql` OR `)
    : sql`EXISTS (SELECT 1 FROM json_each(meta, '$.sessionIds') WHERE value IN (${inList(sessionIds)}))`
  const rows = workRowSchema.array().parse(await db.all(sql`
    SELECT id, title, type, session_id, meta, created_at FROM ${works}
    WHERE ${scopeClause(scope)} AND location IS NULL
      AND (session_id IN (${inList(sessionIds)}) OR ${inMeta})
  `))
  for (const row of rows) {
    const members = (row.meta ? workSessionsSchema.parse(JSON.parse(row.meta)).sessionIds : undefined)
      ?? (row.session_id ? [row.session_id] : [])
    for (const sessionId of members) {
      // The work has no time of each link; the time it was made stands for it.
      into.get(sessionId)?.push({ kind: 'work', workId: row.id, title: row.title ?? '', workType: row.type ?? 'doc', linkedAt: row.created_at })
    }
  }
}

async function readLinkArtifacts(scope: RecordScope, sessionIds: readonly string[], into: Map<string, SessionArtifact[]>): Promise<void> {
  const rows = linkRowSchema.array().parse(await getDatabase().all(sql`
    SELECT session_id, target, title, linked_at FROM ${sessionLinks}
    WHERE ${scopeClause(scope)} AND session_id IN (${inList(sessionIds)})
  `))
  for (const row of rows) {
    const target = sessionLinkInputSchema.shape.target.parse(JSON.parse(row.target))
    const items = into.get(row.session_id)
    if (!items) continue
    // Work links are held by the work (`readWorkArtifacts`), never in this table.
    if (target.kind === 'file') {
      items.push({ kind: isImagePath(target.path) ? 'image' : 'file', hostId: target.hostId, path: target.path, title: row.title, linkedAt: row.linked_at })
    } else if (target.kind === 'automation') {
      items.push({ kind: 'automation', hostId: target.hostId, automationId: target.targetId, title: row.title, linkedAt: row.linked_at })
    }
  }
}

function linkedAtOf(item: SessionArtifact): number {
  return item.kind === 'pull-request' ? item.link.linkedAt : item.linkedAt
}

/** Each session's artifacts, newest link first. */
async function readArtifactsBySession(scope: RecordScope, sessionIds: readonly string[]): Promise<Map<string, SessionArtifact[]>> {
  const bySession = new Map<string, SessionArtifact[]>(sessionIds.map((id) => [id, []]))
  const pullRequests = await readSessionPullRequests(scope, sessionIds)
  for (const [sessionId, links] of Object.entries(pullRequests)) {
    bySession.get(sessionId)?.push(...links.map((link): SessionArtifact => ({ kind: 'pull-request', link })))
  }
  await readWorkArtifacts(scope, sessionIds, bySession)
  await readLinkArtifacts(scope, sessionIds, bySession)
  for (const items of bySession.values()) items.sort((a, b) => linkedAtOf(b) - linkedAtOf(a))
  return bySession
}

/**
 * Every session below this one in its delegation tree, level by level, each
 * level oldest started first. A cycle ends the walk.
 */
async function readDelegatedSessions(scope: RecordScope, sessionId: string): Promise<SessionRecord[]> {
  const found: SessionRecord[] = []
  const seen = new Set([sessionId])
  let level = [sessionId]
  while (level.length > 0 && found.length < MAX_DELEGATED_SESSIONS) {
    const children = (await readSessionMetadataPage(
      sql`${scopeClause(scope, sql`session.organization_id`)} AND session.parent_session_id IN (${inList(level)})`,
      MAX_DELEGATED_SESSIONS - found.length,
    )).reverse().filter((child) => !seen.has(child.sessionId))
    for (const child of children) seen.add(child.sessionId)
    found.push(...children)
    level = children.map((child) => child.sessionId)
  }
  return found
}

/** Read only this session's links, without traversing delegated sessions. */
export async function readOwnSessionArtifacts(scope: RecordScope, sessionId: string): Promise<SessionArtifact[]> {
  return (await readArtifactsBySession(scope, [sessionId])).get(sessionId) ?? []
}

/** The session's own artifacts, then one group for each session below it in its delegation tree. */
export async function readSessionArtifacts(scope: RecordScope, sessionId: string): Promise<SessionArtifacts> {
  const children = await readDelegatedSessions(scope, sessionId)
  const bySession = await readArtifactsBySession(scope, [sessionId, ...children.map((child) => child.sessionId)])
  return {
    own: bySession.get(sessionId) ?? [],
    children: children.map((child) => ({
      sessionId: child.sessionId,
      title: child.customTitle ?? child.title,
      items: bySession.get(child.sessionId) ?? [],
    })),
  }
}
