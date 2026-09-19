import type { RpcMethod } from '@solus/contracts/rpc'
import { rpcPlaneOf, type RpcPlane } from '@solus/contracts/rpc-planes'

/**
 * The roles one Solus process serves (docs/plans/cloud-service-model.md): a
 * role is a plane this host answers for. A laptop serves both; a cloud
 * workspace service serves `collaboration`; a runner serves `execution`.
 * Read once at boot from `SOLUS_ROLES`, a comma list; unset means both.
 */
export type SolusRole = RpcPlane

export const ALL_ROLES: ReadonlySet<SolusRole> = new Set<SolusRole>(['collaboration', 'execution'])

export function resolveRoles(env: { SOLUS_ROLES?: string } = process.env): ReadonlySet<SolusRole> {
  const raw = env.SOLUS_ROLES?.trim()
  if (!raw) return ALL_ROLES
  const roles = new Set<SolusRole>()
  for (const entry of raw.split(',')) {
    const role = entry.trim().toLowerCase()
    if (!role) continue
    if (role !== 'collaboration' && role !== 'execution') {
      throw new Error(`SOLUS_ROLES names an unknown role "${entry.trim()}"; use collaboration, execution, or both.`)
    }
    roles.add(role)
  }
  if (roles.size === 0) return ALL_ROLES
  return roles
}

/** A call to a plane this host does not serve. `code` is what reaches the wire. */
export class PlaneDisabledError extends Error {
  readonly code = 'PLANE_DISABLED' as const

  constructor(readonly method: RpcMethod, readonly plane: RpcPlane) {
    super(`"${method}" belongs to the ${plane} plane, which this host does not serve`)
    this.name = 'PlaneDisabledError'
  }
}

/** Throws when `method`'s plane is not among `roles`. */
export function assertPlaneServed(method: RpcMethod, roles: ReadonlySet<SolusRole>): void {
  const plane = rpcPlaneOf(method)
  if (!roles.has(plane)) throw new PlaneDisabledError(method, plane)
}
