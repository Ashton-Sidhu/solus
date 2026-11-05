import { sql, type SQL } from 'drizzle-orm'
import type { ShareResourceKind } from '@solus/contracts/sharing'
import { visibleTo, type ResourceColumns } from '../../admission/access'
import { actorFor } from '../../admission/actor'
import type { Principal } from '../../admission/principal'
import { resourceLinks } from '../links/schema'
import { tasks } from './schema'
import { visibleThroughSession } from '../works/session-access'

/**
 * What a Solus API list returns: `visibleTo` on the resource's own row, and for
 * a work or a session also what a task the caller can open links to, and for a
 * work what a session the caller can open made or links. Apply this before LIMIT.
 */
export function workspaceResourceVisibility(principal: Principal, kind: ShareResourceKind, columns: ResourceColumns): SQL {
  const actor = actorFor(principal)
  const direct = visibleTo(actor, kind, columns)
  if (kind === 'task') return direct
  const taskVisible = visibleTo(actor, 'task', { id: sql`api_parent.id`, organization: sql`api_parent.organization_id`, owner: sql`api_parent.created_by` })
  const link = sql`SELECT 1 FROM ${resourceLinks} AS api_link JOIN ${tasks} AS api_parent ON api_parent.id = api_link.source_id
        WHERE api_link.source_kind = 'task' AND api_link.target_kind = ${kind === 'work' ? 'work' : 'session'} AND api_link.target_key = ${columns.id}`
  const throughTask = sql`EXISTS (${link} AND api_parent.organization_id = ${columns.organization}
    AND api_link.organization_id = ${columns.organization} AND (${taskVisible}))`
  if (kind === 'session') return sql`((${direct}) OR ${throughTask})`
  return sql`((${direct}) OR ${throughTask} OR ${visibleThroughSession(actor, columns.id)})`
}
