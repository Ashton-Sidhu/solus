import { isAbsolute, win32 } from 'node:path'
import { sql } from 'drizzle-orm'
import { sessionLinkInputSchema, type SessionLinkInput } from '@solus/contracts/session-links'
import type { Attribution } from '@solus/contracts/user'
import { getDatabase } from '../../db/database'
import { attributionJson } from '../stored-attribution'
import { Work } from '../works/work'
import { linkWorkToSessionTasks } from '../works/work-tasks'
import { resourceLinks } from '../links/schema'
import { creatorOf, edgeClause, provenanceOf, sessionOwner, type LinkEdge } from '../links/resource-links'
import { getSessionRecord, organizationOfSession } from './session-records'
import { ensureSessionRow } from './session-identity'
import { emitSessionArtifactsChanged } from './session-artifacts'

type ItemTarget = SessionLinkInput['target']

/** A session's file or automation edge: the host that holds the item is the scope, its path or id the key. */
function edgeOf(sessionId: string, target: Exclude<ItemTarget, { kind: 'work' }>): LinkEdge {
  return {
    sourceKind: 'session',
    sourceId: sessionId,
    targetKind: target.kind,
    targetScope: target.hostId,
    targetKey: target.kind === 'file' ? target.path : target.targetId,
  }
}

/** The same write serves the agent tool and the Solus API's link route. A repeated link is safe. */
export async function linkSessionItem(sessionId: string, raw: SessionLinkInput, actor: Attribution): Promise<void> {
  const input = sessionLinkInputSchema.parse(raw)
  const organizationId = await organizationOfSession(sessionId)
  const target = input.target
  if (target.kind === 'work') {
    const work = await Work.find(organizationId, target.targetId)
    if (!work) throw new Error('Work not found in the session’s organization.')
    const record = work.record()
    const sessionIds = record.sessionIds ?? (record.sessionId ? [record.sessionId] : [])
    if (sessionIds.includes(sessionId)) return
    await work.linkSession(sessionId, actor)
    await linkWorkToSessionTasks(organizationId, work.record())
    return
  }
  const session = await getSessionRecord(organizationId, sessionId)
  if (session?.runnerHostId && target.hostId !== session.runnerHostId) throw new Error('The target must belong to the session’s execution host.')
  if (target.kind === 'file' && !isAbsolute(target.path) && !win32.isAbsolute(target.path)) throw new Error('A file reference needs an absolute host path.')
  const edge = edgeOf(sessionId, target)
  const title = input.title ?? (target.kind === 'file' ? win32.basename(target.path) : target.targetId)
  const inserted = await getDatabase().transaction(async (db) => {
    // The edge is the session's; a session nobody recorded yet gets its row, as this machine's own.
    await ensureSessionRow(sessionId, db)
    const createdBy = await creatorOf(actor, () => sessionOwner(db, sessionId))
    return db.run(sql`
      INSERT INTO ${resourceLinks}(organization_id, source_kind, source_id, target_kind, target_scope, target_key, relation, title, source, status, author, created_by, created_at)
      VALUES (${organizationId}, 'session', ${sessionId}, ${edge.targetKind}, ${edge.targetScope}, ${edge.targetKey}, 'reference', ${title},
        ${provenanceOf(actor)}, 'active', ${attributionJson(actor)}, ${createdBy}, ${Date.now()})
      ON CONFLICT(source_kind, source_id, target_kind, target_scope, target_key) DO NOTHING
    `)
  })
  if (inserted.changes > 0) await emitSessionArtifactsChanged(sessionId)
}

/** The reverse of `linkSessionItem`. A link that is not there changes nothing. */
export async function unlinkSessionItem(sessionId: string, raw: ItemTarget): Promise<void> {
  // Parsed as a link is, so the key is spelled the same.
  const target = sessionLinkInputSchema.parse({ target: raw }).target
  if (target.kind === 'work') {
    await (await Work.find(await organizationOfSession(sessionId), target.targetId))?.unlinkSession(sessionId)
    return
  }
  const removed = await getDatabase().run(sql`DELETE FROM ${resourceLinks} WHERE ${edgeClause(edgeOf(sessionId, target))}`)
  if (removed.changes > 0) await emitSessionArtifactsChanged(sessionId)
}
