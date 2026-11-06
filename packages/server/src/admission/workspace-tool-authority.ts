import { AsyncLocalStorage } from 'node:async_hooks'
import type { ResourceRole, ShareResource } from '@solus/contracts/sharing'
import type { Principal } from './principal'

/** Set at admitted turn execution, never from model-supplied tool arguments. */
const authority = new AsyncLocalStorage<Principal>()
export function withWorkspaceToolAuthority<T>(principal: Principal, run: () => T): T { return authority.run(principal, run) }
export function workspaceToolAuthority(): Principal | undefined { return authority.getStore() }

let roleOfResource: ((principal: Principal, resource: ShareResource) => Promise<ResourceRole>) | null = null

/** Boot gives the agent tools the share manager's role check. */
export function installToolAccess(roleFor: (principal: Principal, resource: ShareResource) => Promise<ResourceRole>): void {
  roleOfResource = roleFor
}

/**
 * Whether the turn running an agent tool may read a record: a member's or a guest's
 * turn reads only what the person may open. The host's own work, and the host's
 * owner, read everything on the disk (plans/031 rule 1).
 */
export async function toolMayRead(resource: ShareResource): Promise<boolean> {
  const principal = workspaceToolAuthority()
  if (!principal || !roleOfResource) return true
  return (await roleOfResource(principal, resource)) !== 'none'
}
