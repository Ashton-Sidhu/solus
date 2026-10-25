import { EVERY_PERMISSION, permissionsAllow, isResourceActionPath, type Permission, type ResourceActionPath, type ResourceRef } from '@solus/contracts/permissions'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { HostFact } from '@solus/client-core/host-facts'
import { resourceMay } from '../sharing/resource-roles'

/**
 * This client's standing on one host (docs/plans/permissions.md §4): "may I,
 * here". The host answers the permissions with its server info; a resource verb
 * is answered by the role the resource carries, for every kind
 * (docs/plans/access-model.md §2.7). The same tables gate the host, so a control
 * is disabled exactly when the call would be refused. Until the host answers,
 * the client assumes the owner's standing, so an owner's controls never flicker
 * on.
 */
export class HostStanding {
  constructor(
    private readonly serverId: string,
    private readonly serverInfo: () => HostFact<ConnectionsServerInfo>,
    private readonly isGone: () => boolean,
  ) {}

  /** The permissions this connection holds, as prefixes; the owner's until the
   *  host answers, and none on a host that is gone. */
  get permissions(): readonly Permission[] {
    if (this.isGone()) return []
    const fact = this.serverInfo()
    if (fact.state !== 'ready') return EVERY_PERMISSION
    if (Array.isArray(fact.value.permissions)) return fact.value.permissions
    // A host that sends no permissions gives a local owner's standing to its local owner only.
    return fact.value.principal === 'local-owner' ? EVERY_PERMISSION : []
  }

  /** How the host admitted this client; undefined until it answers. */
  get principal(): ConnectionsServerInfo['principal'] | undefined {
    const fact = this.serverInfo()
    return fact.state === 'ready' ? fact.value.principal : undefined
  }

  get isGuest(): boolean {
    return this.principal === 'guest'
  }

  /** The host is still making this member's Linux user and folders (docs/plans/member-isolation.md §8.1): no turn runs here yet. */
  get isPreparing(): boolean {
    const fact = this.serverInfo()
    return fact.state === 'ready' && fact.value.memberWorkspace === 'preparing'
  }

  /** Whether this client holds a permission here, or may do `action` on one resource of this host. */
  may(permission: Permission): boolean
  may(action: ResourceActionPath, resource: ResourceRef): boolean
  may(action: Permission | ResourceActionPath, resource?: ResourceRef): boolean {
    if (resource && isResourceActionPath(action)) return resourceMay(this.serverId, resource, action)
    return permissionsAllow(this.permissions, action)
  }
}
