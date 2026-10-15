import { isInsideRoot } from '../paths'
import { getIndexedSession } from '../db/session-indexer'
import { resolveSessionLineageById } from '../data/sessions/session-lineage'
import { RpcAccessError } from './access-policy'
import type { Principal } from './principal'
import type { RpcMethod } from '@solus/contracts/rpc'

/**
 * The bound on a permission (docs/plans/permissions.md §3). A guest's
 * permissions reach the shared session's checkout and nothing else:
 * `host.git.read` on a link to a session is that session's working directory,
 * not the disk. Every other principal's permissions are unbounded, and a scope
 * on a permission becomes data the day a second bounded case appears.
 */
export function pathScopeOf(principal: Principal): string | null {
  if (principal.kind !== 'guest') return null
  const { resource } = principal.share
  if (resource.kind !== 'session') return ''
  return resolveSessionLineageById(resource.id)?.active.cwd ?? getIndexedSession(resource.id)?.cwd ?? ''
}

/** Refuses a path outside the caller's scope; a scope of '' (a resource with no checkout) refuses every path. */
export function assertPathInScope(method: RpcMethod, principal: Principal, path: string | null | undefined): void {
  const scope = pathScopeOf(principal)
  if (scope === null) return
  if (!path || path === '~' || scope === '' || !isInsideRoot(scope, path)) {
    throw new RpcAccessError(method, principal.kind, `"${method}" reaches only the shared session's checkout`)
  }
}
