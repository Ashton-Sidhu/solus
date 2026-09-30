import { sql, type SQL } from 'drizzle-orm'
import type { ShareResourceKind } from '@solus/contracts/sharing'
import { isHostOwner, type Principal } from '../admission/principal'
import { resourceOwner, shareGrant } from './schema'

/** The sharing domain's direct read predicate. Callers supply only the resource columns. */
export function directResourceVisibility(principal: Principal, kind: ShareResourceKind, id: SQL, organization: SQL): SQL {
  if (isHostOwner(principal) || principal.kind === 'system') return sql`1 = 1`
  if (principal.kind === 'runner') return sql`1 = 0`
  if (principal.kind === 'guest') {
    const bound = principal.share.resource
    if (bound.kind !== kind) return sql`1 = 0`
    return sql`${id} = ${bound.id} AND ${organization} = ${principal.organizationId ?? 'local'} AND EXISTS (
      SELECT 1 FROM ${shareGrant} AS api_guest_grant
      WHERE api_guest_grant.organization_id = ${organization}
        AND api_guest_grant.resource_kind = ${kind} AND api_guest_grant.resource_id = ${id}
        AND api_guest_grant.subject_kind = 'everyone' AND api_guest_grant.link_secret_hash = ${principal.share.linkSecretHash}
    )`
  }
  const team = principal.teamIds.length
    ? sql`(api_share.subject_kind = 'team' AND api_share.subject_id IN (${sql.join(principal.teamIds.map(teamId => sql`${teamId}`), sql`, `)}))`
    : sql`1 = 0`
  const owns = sql`EXISTS (SELECT 1 FROM ${resourceOwner} AS api_owner
    WHERE api_owner.resource_kind = ${kind} AND api_owner.resource_id = ${id}
      AND api_owner.organization_id = ${organization} AND api_owner.owner_user_id = ${principal.userId})`
  const granted = sql`EXISTS (SELECT 1 FROM ${shareGrant} AS api_share
    WHERE api_share.resource_kind = ${kind} AND api_share.resource_id = ${id} AND api_share.organization_id = ${organization}
      AND ((api_share.subject_kind = 'user' AND api_share.subject_id = ${principal.userId})
        OR (api_share.subject_kind = 'organization' AND api_share.subject_id = ${principal.organizationId}) OR ${team}))`
  const unownedManaged = principal.hostKind === 'managed'
    ? sql`NOT EXISTS (SELECT 1 FROM ${resourceOwner} AS api_unowned WHERE api_unowned.resource_kind = ${kind} AND api_unowned.resource_id = ${id})`
    : sql`1 = 0`
  const foreignOwner = sql`EXISTS (SELECT 1 FROM ${resourceOwner} AS api_foreign
    WHERE api_foreign.resource_kind = ${kind} AND api_foreign.resource_id = ${id} AND api_foreign.organization_id <> ${organization})`
  return sql`${organization} = ${principal.organizationId} AND NOT (${foreignOwner}) AND (${owns} OR ${granted} OR ${unownedManaged})`
}
