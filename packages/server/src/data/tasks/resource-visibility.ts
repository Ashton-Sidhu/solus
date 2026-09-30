import { sql, type SQL } from 'drizzle-orm'
import type { ShareResourceKind } from '@solus/contracts/sharing'
import type { Principal } from '../../admission/principal'
import { directResourceVisibility } from '../../sharing/resource-visibility'
import { taskLinks, taskSessionLinks, tasks } from './schema'

/** A task grants read access to its linked works/sessions. Apply this before LIMIT. */
export function workspaceResourceVisibility(principal: Principal, kind: ShareResourceKind, id: SQL, organization: SQL): SQL {
  const direct = directResourceVisibility(principal, kind, id, organization)
  if (kind === 'task') return direct
  const taskVisible = directResourceVisibility(principal, 'task', sql`api_parent.id`, sql`api_parent.organization_id`)
  const link = kind === 'work'
    ? sql`SELECT 1 FROM ${taskLinks} AS api_link JOIN ${tasks} AS api_parent ON api_parent.id = api_link.task_id
        WHERE api_link.kind = 'work' AND api_link.target_key = ${id}`
    : sql`SELECT 1 FROM ${taskSessionLinks} AS api_link JOIN ${tasks} AS api_parent ON api_parent.id = api_link.task_id
        WHERE api_link.session_id = ${id}`
  return sql`((${direct}) OR EXISTS (${link} AND api_parent.organization_id = ${organization}
    AND api_link.organization_id = ${organization} AND (${taskVisible})))`
}
