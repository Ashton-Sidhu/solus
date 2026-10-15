import { createHash } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import { sql } from 'drizzle-orm'
import { sessionLinkInputSchema, type SessionLinkInput } from '@solus/contracts/session-links'
import type { Attribution } from '@solus/contracts/user'
import { getDatabase } from '../../db/database'
import { Work } from '../works/work'
import { linkWorkToSessionTasks } from '../works/work-tasks'
import { getSessionRecord, organizationOfSession } from './session-records'
import { sessionLinks } from './schema'

/** The same write serves the agent tool and the existing session outbox. A repeated link is safe. */
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
    await work.linkSession(sessionId)
    await linkWorkToSessionTasks(organizationId, work.record())
    return
  }
  const session = await getSessionRecord(organizationId, sessionId)
  if (session?.runnerHostId && target.hostId !== session.runnerHostId) throw new Error('The target must belong to the session’s execution host.')
  if (target.kind === 'file' && !isAbsolute(target.path) && !win32.isAbsolute(target.path)) throw new Error('A file reference needs an absolute host path.')
  // Keep long paths out of database index keys. The target retains the full location.
  const linkId = `${target.kind}:${createHash('sha256').update(JSON.stringify(target)).digest('hex')}`
  await getDatabase().run(sql`
    INSERT INTO ${sessionLinks}(session_id, link_id, target, title, created_by, linked_at, organization_id)
    VALUES (${sessionId}, ${linkId}, ${JSON.stringify(target)}, ${input.title ?? (target.kind === 'file' ? win32.basename(target.path) : target.targetId)}, ${JSON.stringify(actor)}, ${Date.now()}, ${organizationId})
    ON CONFLICT(session_id, link_id) DO NOTHING
  `)
}
