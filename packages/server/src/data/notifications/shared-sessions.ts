import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { shareRoleSchema } from '@solus/contracts/sharing'
import { SESSION_LIST_IDLE_MS } from '@solus/contracts/session-state'
import { getDatabase } from '../../db/database'
import { ownerKeyOf } from '../../admission/actor'
import { LOCAL_ORGANIZATION_ID, recordScopeOf } from '../../admission/principal'
import { isApiMode } from '../../host/api-mode'
import { aclEntry } from '../../sharing/schema'
import { scopeClause } from '../scope'
import { sessionRecords } from '../sessions/schema'
import { userOfStoredKey } from '../stored-attribution'
import { recordNotification, type NotificationReader } from './store'

const grantRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  subject_kind: z.enum(['user', 'team']),
  subject_id: z.string(),
  role: shareRoleSchema,
  created_by: z.string(),
  granted_by_name: z.string().nullable(),
  granted_at: z.coerce.number(),
  session_id: z.string(),
  title: z.string().nullable(),
  custom_title: z.string().nullable(),
})

/**
 * Write the reader's `session.shared` notifications before their hub is read
 * (docs/plans/shared-with-you.md §4.4). A host does not know who is in a team:
 * it learns a person's teams from their own credential. So a share writes no
 * row per member; each reader's rows are found here, with the same match as
 * their session list, when they read. One row per grant: the event id names
 * the session, the subject, and the grant time, so a repeated read writes
 * nothing and a higher role writes a new row. It names no row id: a Solus API
 * writes a runner's rows again, with new ids, each time they arrive. Only grants inside the list's idle window
 * count, so a person who joins a team does not get its whole history.
 *
 * Only the session's home writes them, the same home a client reads the
 * session's list from (`sessionHomeId`): the organization's Solus API for a
 * published organization session, the machine for any other. A client reads
 * the hub of both, so a row written at each would show the same share twice.
 */
export async function recordSharedSessions(reader: NotificationReader, now = Date.now()): Promise<void> {
  const personKey = ownerKeyOf(reader.actor)
  if (!personKey) return
  const principal = reader.actor.principal
  const teamIds = principal.kind === 'org-member' ? principal.teamIds : []
  const subjects = [sql`(acl.subject_kind = 'user' AND acl.subject_id = ${personKey})`]
  if (teamIds.length) subjects.push(sql`(acl.subject_kind = 'team' AND acl.subject_id IN (${sql.join(teamIds.map((teamId) => sql`${teamId}`), sql`, `)}))`)
  const db = getDatabase()
  const grants = grantRowSchema.array().parse(await db.all(sql`
    SELECT acl.id, acl.organization_id, acl.subject_kind, acl.subject_id, acl.role, acl.created_by, acl.granted_by_name,
      COALESCE(acl.granted_at, acl.created_at) AS granted_at, s.session_id, s.title, s.custom_title
    FROM ${aclEntry} AS acl
    JOIN ${sessionRecords} AS s ON s.session_id = acl.resource_id AND s.organization_id = acl.organization_id
    WHERE acl.resource_kind = 'session' AND (${sql.join(subjects, sql` OR `)})
      AND ${scopeClause(recordScopeOf(principal), sql`acl.organization_id`)}
      AND s.owner_key <> ${personKey}
      ${isApiMode() ? sql`` : sql`AND NOT (s.organization_id <> ${LOCAL_ORGANIZATION_ID} AND s.publication = 'published')`}
      AND COALESCE(acl.granted_at, acl.created_at) >= ${now - SESSION_LIST_IDLE_MS}
      AND (acl.expires_at IS NULL OR acl.expires_at > ${now})
  `))
  if (!grants.length) return
  await db.transaction(async (tx) => {
    for (const grant of grants) {
      await recordNotification(tx, {
        organizationId: grant.organization_id,
        eventId: `session.shared:${grant.session_id}:${grant.subject_kind}:${grant.subject_id}:${grant.granted_at}`,
        recipients: [personKey],
        facts: grant.subject_kind === 'team' ? { kind: 'session.shared', role: grant.role, teamId: grant.subject_id } : { kind: 'session.shared', role: grant.role },
        resource: { kind: 'session', sessionId: grant.session_id },
        by: { kind: 'user', user: userOfStoredKey(grant.created_by, grant.granted_by_name ?? 'Someone') },
        summary: { title: (grant.custom_title ?? grant.title ?? 'A session').slice(0, 300) },
        createdAt: grant.granted_at,
      })
    }
  })
}
