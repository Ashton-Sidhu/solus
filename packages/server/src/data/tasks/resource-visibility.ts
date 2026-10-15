import { sql, type SQL } from 'drizzle-orm'
import type { ShareResourceKind } from '@solus/contracts/sharing'
import { visibleTo, type ResourceColumns } from '../../admission/access'
import { actorFor } from '../../admission/actor'
import type { Principal } from '../../admission/principal'
import { taskLinks, taskSessionLinks, tasks } from './schema'

/**
 * What a Solus API list returns: `visibleTo` on the resource's own row, and for
 * a work or a session also what a task the caller can open links to. Apply this
 * before LIMIT.
 */
export function workspaceResourceVisibility(principal: Principal, kind: ShareResourceKind, columns: ResourceColumns): SQL {
  const actor = actorFor(principal)
  const direct = visibleTo(actor, kind, columns)
  if (kind === 'task') return direct
  const taskVisible = visibleTo(actor, 'task', { id: sql`api_parent.id`, organization: sql`api_parent.organization_id`, owner: sql`api_parent.owner_key` })
  const link = kind === 'work'
    ? sql`SELECT 1 FROM ${taskLinks} AS api_link JOIN ${tasks} AS api_parent ON api_parent.id = api_link.task_id
        WHERE api_link.kind = 'work' AND api_link.target_key = ${columns.id}`
    : sql`SELECT 1 FROM ${taskSessionLinks} AS api_link JOIN ${tasks} AS api_parent ON api_parent.id = api_link.task_id
        WHERE api_link.session_id = ${columns.id}`
  return sql`((${direct}) OR EXISTS (${link} AND api_parent.organization_id = ${columns.organization}
    AND api_link.organization_id = ${columns.organization} AND (${taskVisible})))`
}
