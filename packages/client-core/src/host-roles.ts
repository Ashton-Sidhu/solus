import type { RpcPlane } from '@solus/contracts/rpc-planes'

/**
 * Which planes a host serves (docs/plans/cloud-service-model.md §1). A laptop
 * serves both; the organization's workspace service serves `collaboration`
 * alone and answers every execution method with `PLANE_DISABLED`. A host tells
 * the client in `connectionsGetServerInfo.roles`; a host from before roles
 * existed says nothing and served both.
 */
export type HostRole = RpcPlane

export const ALL_HOST_ROLES: readonly HostRole[] = ['collaboration', 'execution']

/** What a server-info answer says of its roles, when it says anything. */
export interface HostRolesReport {
  roles?: readonly HostRole[]
}

/**
 * The roles a host serves, from its own answer or the fallback the client
 * already knows: a cloud directory row is collaboration-only before it is even
 * dialed, every other host is both until it says otherwise.
 */
export function hostRolesOf(report: HostRolesReport | null | undefined, fallback: readonly HostRole[] = ALL_HOST_ROLES): readonly HostRole[] {
  if (!report?.roles || report.roles.length === 0) return fallback
  return report.roles
}

export const COLLABORATION_ONLY_ROLES: readonly HostRole[] = ['collaboration']
