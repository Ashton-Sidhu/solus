import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { ShareResource, ResourceRole } from '@solus/contracts/sharing'
import type { SolusApiScope } from '@solus/contracts/solus-api'
import { recordScopeOf, organizationForNew, type RecordScope } from '../../admission/principal'
import type { WorkspaceRequestContext } from '../../admission/workspace-credentials'
import { SolusApiError } from '../../admission/workspace-error'
import { ShareAccessError, type ShareManager } from '../../sharing/share-manager'
import { getDatabase } from '../../db/database'
import { scopeClause } from '../scope'
import { workspaceProjects } from '../../projects/schema'

export function apiScope(context: WorkspaceRequestContext): RecordScope {
  return context.home.kind === 'organization' ? context.home.organizationId : recordScopeOf(context.principal)
}
export function apiOrganization(context: WorkspaceRequestContext): string {
  return context.home.kind === 'organization' ? context.home.organizationId : context.actingAgent?.organizationId ?? organizationForNew(context.principal)
}
/** The one scope check, on the operation itself, so HTTP and in-process tools cannot differ. */
export function requireScope(context: WorkspaceRequestContext, scope: SolusApiScope): void {
  if (!context.scopes.includes(scope)) throw new SolusApiError(403, 'FORBIDDEN', 'This credential does not permit that operation.')
}
export async function requireResource(shares: ShareManager, context: WorkspaceRequestContext, resource: ShareResource, role: ResourceRole): Promise<void> {
  try { await shares.assertRole(context.principal, resource, role) }
  catch (error) {
    if (error instanceof ShareAccessError) throw new SolusApiError(404, 'NOT_FOUND', 'Resource not found.')
    throw error
  }
}
export async function projectKeyForId(context: WorkspaceRequestContext, projectId: string | null | undefined): Promise<string | null> {
  if (!projectId) return null
  const row = z.object({ repository_key: z.string() }).nullish().parse(await getDatabase().get(sql`
    SELECT repository_key FROM ${workspaceProjects} WHERE id = ${projectId} AND ${scopeClause(apiScope(context))}
  `))
  if (!row) throw new SolusApiError(404, 'NOT_FOUND', 'Project not found.')
  return row.repository_key
}
export async function projectIdsForKeys(context: WorkspaceRequestContext, keys: readonly string[]): Promise<Map<string, Map<string, string>>> {
  const unique = [...new Set(keys)]
  if (!unique.length) return new Map()
  const rows = z.array(z.object({ id: z.string(), organization_id: z.string(), repository_key: z.string() })).parse(await getDatabase().all(sql`
    SELECT id, organization_id, repository_key FROM ${workspaceProjects}
    WHERE ${scopeClause(apiScope(context))} AND repository_key IN (${sql.join(unique.map(key => sql`${key}`), sql`, `)})
  `))
  const projects = new Map<string, Map<string, string>>()
  for (const row of rows) {
    let organization = projects.get(row.organization_id)
    if (!organization) { organization = new Map(); projects.set(row.organization_id, organization) }
    organization.set(row.repository_key, row.id)
  }
  return projects
}
