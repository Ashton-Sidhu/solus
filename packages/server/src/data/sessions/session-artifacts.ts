import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { artifactLinkedAt, isImagePath, type SessionArtifact, type SessionArtifacts } from '@solus/contracts/session-artifacts'
import { getDatabase } from '../../db/database'
import { ANY_ORGANIZATION, type RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { apps } from '../apps/schema'
import { resourceLinks } from '../links/schema'
import { works } from '../works/schema'
import { workTypeSchema } from '../works/work-rows'
import { readSessionPullRequests } from './session-pull-requests'
import { getSessionRecord, readSessionMetadataPage } from './session-records'
import type { SessionRecord } from '@solus/contracts/types'

/**
 * What a session produced or linked (docs/plans/session-artifacts.md): its
 * pull requests, the works it is a member of, and its file and automation
 * links, read together from the session's edges in `resource_links`. Nothing
 * is stored here. A lead also reads the artifacts of every session below it in
 * its delegation tree: the sessions it started, the ones they started, and so on.
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
  session_id: z.string(),
  linked_at: z.number(),
  id: z.string(),
  title: z.string().nullable(),
  type: workTypeSchema.nullable(),
})

const appSlugRowSchema = z.object({ id: z.string(), slug: z.string() })

const linkRowSchema = z.object({
  session_id: z.string(),
  target_kind: z.enum(['file', 'automation', 'app']),
  host_id: z.string(),
  target_key: z.string(),
  title: z.string(),
  linked_at: z.number(),
})

function inList(ids: readonly string[]): SQL {
  return sql.join(ids.map((id) => sql`${id}`), sql`, `)
}

/** The works each session is a member of, with when it was linked. */
async function readWorkArtifacts(scope: RecordScope, sessionIds: readonly string[], into: Map<string, SessionArtifact[]>): Promise<void> {
  const rows = workRowSchema.array().parse(await getDatabase().all(sql`
    SELECT resource_links.source_id AS session_id, resource_links.created_at AS linked_at, works.id, works.title, works.type
    FROM ${resourceLinks}
    JOIN ${works} ON works.id = resource_links.target_key AND works.organization_id = resource_links.organization_id
    WHERE ${scopeClause(scope, sql`resource_links.organization_id`)} AND resource_links.source_kind = 'session' AND resource_links.target_kind = 'work'
      AND resource_links.relation = 'member' AND resource_links.status = 'active' AND works.location IS NULL
      AND resource_links.source_id IN (${inList(sessionIds)})
  `))
  for (const row of rows) {
    into.get(row.session_id)?.push({ kind: 'work', workId: row.id, title: row.title ?? '', workType: row.type ?? 'doc', linkedAt: row.linked_at })
  }
}

async function readLinkArtifacts(scope: RecordScope, sessionIds: readonly string[], into: Map<string, SessionArtifact[]>): Promise<void> {
  const rows = linkRowSchema.array().parse(await getDatabase().all(sql`
    SELECT resource_links.source_id AS session_id, resource_links.target_kind, resource_links.target_scope AS host_id, resource_links.target_key,
      resource_links.title, resource_links.created_at AS linked_at
    FROM ${resourceLinks}
    WHERE ${scopeClause(scope, sql`resource_links.organization_id`)} AND resource_links.source_kind = 'session'
      AND resource_links.target_kind IN ('file', 'automation', 'app') AND resource_links.source_id IN (${inList(sessionIds)})
  `))
  // An app's surface goes by its slug, which only the app's own row holds. A link to an app that is gone names nothing.
  const appIds = [...new Set(rows.filter((row) => row.target_kind === 'app').map((row) => row.target_key))]
  const slugs = new Map(appIds.length === 0 ? [] : appSlugRowSchema.array().parse(await getDatabase().all(sql`SELECT id, slug FROM ${apps} WHERE id IN (${inList(appIds)})`)).map((row) => [row.id, row.slug]))
  for (const row of rows) {
    const items = into.get(row.session_id)
    if (!items) continue
    if (row.target_kind === 'file') {
      items.push({ kind: isImagePath(row.target_key) ? 'image' : 'file', hostId: row.host_id, path: row.target_key, title: row.title, linkedAt: row.linked_at })
    } else if (row.target_kind === 'app') {
      const slug = slugs.get(row.target_key)
      if (slug) items.push({ kind: 'app', hostId: row.host_id, appId: row.target_key, slug, title: row.title, linkedAt: row.linked_at })
    } else {
      items.push({ kind: 'automation', hostId: row.host_id, automationId: row.target_key, title: row.title, linkedAt: row.linked_at })
    }
  }
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
  for (const items of bySession.values()) items.sort((a, b) => artifactLinkedAt(b) - artifactLinkedAt(a))
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
      sql`${scopeClause(scope, sql`session_records.organization_id`)} AND session_records.parent_session_id IN (${inList(level)})`,
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
