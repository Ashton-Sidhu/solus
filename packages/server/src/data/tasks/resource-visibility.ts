import type { SQL } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import type { ShareResourceKind } from '@solus/contracts/sharing'
import { visibleTo, type ResourceColumns } from '../../admission/access'
import { actorFor } from '../../admission/actor'
import type { Principal } from '../../admission/principal'
import { visibleThroughSession } from '../works/session-access'

/**
 * What a Solus API list returns: `visibleTo` on the resource's own row, and
 * for a work also what a session the caller can open made or links. A task
 * gives no access: it is not a Solus resource, and who can read it is decided
 * by the caller's own GitHub or Jira connection
 * (docs/plans/provider-owned-tasks.md §4.3). Apply this before LIMIT.
 */
export function workspaceResourceVisibility(principal: Principal, kind: ShareResourceKind, columns: ResourceColumns): SQL {
  const actor = actorFor(principal)
  const direct = visibleTo(actor, kind, columns)
  if (kind !== 'work') return direct
  return sql`((${direct}) OR ${visibleThroughSession(actor, columns.id)})`
}
